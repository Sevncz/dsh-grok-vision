// Host-level `grok_vision` tool: delegate multimodal (image) analysis to the
// local Grok CLI (`grok --prompt-file <json> --output-format json`, single-turn
// headless). Registered through `ctx.tools`, so it is visible to every session
// whose composition mounts this package.
//
// Image sources:
//   - file paths (absolute, or relative to the workspace cwd)
//   - "clipboard": read the macOS clipboard as PNG (osascript)
//   - "screen":    capture the main display (screencapture, cursor included)
import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, extname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Cordis plugin name used by loader diagnostics. */
const name = "tool-grok-vision";

/** Services required by this tool suite. */
const inject = ["tools", "systemPrompt"];

const DEFAULT_TIMEOUT_MS = 120000;
const DEFAULT_MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_IMAGES = 4;
const DEFAULT_IMAGE_TIMEOUT_MS = 180000;
const DEFAULT_OUTPUT_DIR = "/tmp/dsh-grok-images";

/** Cap on collected stdout bytes, defensive only (text answers are small). */
const MAX_STDOUT_BYTES = 4 * 1024 * 1024;

/** Supported image extensions → MIME type sent to Grok. */
const MIME_BY_EXT = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

/** Baoyu style assets shipped in this package: skill name → directory. */
const STYLE_SKILLS = [
  ["baoyu-cover-image", "baoyu-cover-image", "cover"],
  ["baoyu-infographic", "baoyu-infographic", "infographic"],
  ["baoyu-comic", "baoyu-comic", "comic"],
  ["baoyu-xhs-images", "baoyu-xhs-images", "xhs"],
];

const Config = z.object({
  /** Path or name of the local grok binary. */
  grokBin: z.string().default("grok"),
  /** Cooperative tool-call budget (ms); also backs the internal kill timer. */
  timeoutMs: z.number().default(DEFAULT_TIMEOUT_MS),
  /** Per-image size ceiling in bytes. */
  maxImageBytes: z.number().default(DEFAULT_MAX_IMAGE_BYTES),
  /** Maximum number of images per call. */
  maxImages: z.number().default(DEFAULT_MAX_IMAGES),
  /** x.ai image generation model. */
  imageModel: z.string().default("grok-imagine-image"),
  /** Image generation budget (ms). */
  imageTimeoutMs: z.number().default(DEFAULT_IMAGE_TIMEOUT_MS),
  /** Default output directory for generated images. */
  outputDir: z.string().default(DEFAULT_OUTPUT_DIR),
  /** Optional explicit xAI API key; when unset, the local grok login token is used. */
  xaiApiKey: z.string(),
});

function assertPositiveInteger(label, value) {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`tool-grok-vision: ${label} must be a positive integer`);
  }
}

/** Run a command to completion; resolve stdout, reject on failure with stderr. */
function runCommand(command, args, timeoutMs) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      if (stdout.length < 1024 * 1024) stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      if (stderr.length < 64 * 1024) stderr += chunk;
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    timer.unref?.();
    child.once("error", (error) => {
      clearTimeout(timer);
      rejectPromise(new Error(`${command} failed to start: ${error.message}`));
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolvePromise(stdout);
      else rejectPromise(new Error(`${command} exited ${code}: ${stderr.trim()}`));
    });
  });
}

/** Materialize the macOS clipboard as a PNG file. */
async function materializeClipboard(targetPath) {
  try {
    await runCommand(
      "osascript",
      [
        "-e",
        "set pngData to the clipboard as «class PNGf»",
        "-e",
        `set outFile to open for access (POSIX file "${targetPath}") with write permission`,
        "-e",
        "write pngData to outFile",
        "-e",
        "close access outFile",
      ],
      30000,
    );
  } catch (error) {
    throw new Error(
      `failed to read the clipboard as an image (copy a screenshot first): ${error.message}`,
    );
  }
}

/** Capture the main display into a PNG file (silent, with cursor). */
async function materializeScreen(targetPath) {
  try {
    await runCommand("screencapture", ["-x", "-C", targetPath], 30000);
  } catch (error) {
    throw new Error(`failed to capture the screen: ${error.message}`);
  }
}

/** Resolve an image argument to an absolute path (relative to the workspace cwd). */
function resolveImagePath(input) {
  const trimmed = String(input).trim();
  if (trimmed.length === 0) throw new Error("image path must be a non-empty string");
  return isAbsolute(trimmed) ? trimmed : resolve(process.cwd(), trimmed);
}

/** MIME type for an image path, or undefined when the extension is unsupported. */
function mimeFor(imagePath) {
  return MIME_BY_EXT[extname(imagePath).toLowerCase()];
}

/**
 * Read one image into a base64 payload (ACP ImageContent), enforcing the
 * size ceiling and the supported-extension whitelist.
 */
async function readImageBlock(imagePath, maxImageBytes) {
  const mimeType = mimeFor(imagePath);
  if (mimeType === undefined) {
    throw new Error(
      `unsupported image type: ${imagePath} (supported: ${Object.keys(MIME_BY_EXT).join(", ")})`,
    );
  }
  let data;
  try {
    data = await readFile(imagePath);
  } catch (error) {
    throw new Error(`failed to read image ${imagePath}: ${error.message}`);
  }
  if (data.byteLength === 0) throw new Error(`image is empty: ${imagePath}`);
  if (data.byteLength > maxImageBytes) {
    throw new Error(
      `image ${imagePath} is ${data.byteLength} bytes, over the ${maxImageBytes}-byte limit`,
    );
  }
  return { type: "image", data: data.toString("base64"), mimeType };
}

/**
 * Run `grok --prompt-file <file> --output-format json` and return its parsed
 * result. Kills the child when `signal` aborts or the budget timer fires.
 */
function runGrok(grokBin, promptFile, timeoutMs, signal) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(grokBin, ["--prompt-file", promptFile, "--output-format", "json"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let stdoutOverflow = false;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      if (stdout.length >= MAX_STDOUT_BYTES) {
        stdoutOverflow = true;
        return;
      }
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      if (stderr.length < 64 * 1024) stderr += chunk;
    });

    const kill = () => {
      if (!child.killed) child.kill("SIGKILL");
    };
    if (signal.aborted) kill();
    signal.addEventListener("abort", kill, { once: true });
    // Backstop: the policy timer normally aborts first; this guarantees the
    // child never outlives the budget even without the timeout policy row.
    const timer = setTimeout(kill, timeoutMs + 5000);
    timer.unref?.();

    child.once("error", (error) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", kill);
      rejectPromise(new Error(`failed to start grok (${grokBin}): ${error.message}`));
    });
    child.once("close", (code, exitSignal) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", kill);
      if (signal.aborted) {
        rejectPromise(new Error("grok_vision call was aborted"));
        return;
      }
      if (code !== 0) {
        const tail = stderr.trim();
        const detail = tail.length > 0 ? `: ${tail.slice(-2000)}` : "";
        rejectPromise(
          new Error(`grok exited with code ${code ?? exitSignal}${detail}`),
        );
        return;
      }
      if (stdoutOverflow) {
        rejectPromise(new Error("grok output exceeded the internal size cap"));
        return;
      }
      resolvePromise(stdout);
    });
  });
}

/** Parse grok's `--output-format json` response into `{ text }`. */
function parseGrokOutput(stdout) {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) return { text: "" };
  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed.text === "string" && parsed.text.length > 0) {
      return { text: parsed.text };
    }
    if (parsed.error !== undefined) {
      throw new Error(`grok reported an error: ${JSON.stringify(parsed.error)}`);
    }
    return { text: "" };
  } catch (error) {
    if (error instanceof SyntaxError) {
      // Not JSON: pass the raw output through rather than failing the call.
      return { text: trimmed };
    }
    throw error;
  }
}

/**
 * Resolve the xAI API key: explicit config first, then the local Grok CLI
 * login token (`~/.grok/auth.json`). Never logged or surfaced.
 */
async function resolveXaiKey(explicit) {
  if (explicit !== undefined && explicit.length > 0) return explicit;
  try {
    const authPath = join(resolve(process.env.HOME ?? "~", ".grok"), "auth.json");
    const auth = JSON.parse(await readFile(authPath, "utf8"));
    const entry = Object.values(auth)[0];
    if (entry !== undefined && typeof entry.key === "string" && entry.key.length > 0) {
      return entry.key;
    }
  } catch {
    /* fall through */
  }
  throw new Error(
    "no xAI API key: set `xaiApiKey` in the plugin config or log in with the local grok CLI (grok login)",
  );
}

/** Directory of this package's style assets (styles/*). */
function styleAssetDir() {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "styles");
}

/** Load one style's compact spec (a few KB; x.ai caps prompts at 8000 chars). */
async function loadStyleSnippet(styleKey) {
  const entry = STYLE_SKILLS.find(([, , key]) => key === styleKey);
  if (entry === undefined) {
    throw new Error(`unknown style "${styleKey}" (supported: ${STYLE_SKILLS.map(([, , k]) => k).join(", ")})`);
  }
  return await readFile(join(styleAssetDir(), "summaries", `${styleKey}.md`), "utf8");
}

/**
 * Call x.ai images/generations and write every returned image to disk.
 * Returns the list of saved paths.
 */
async function generateImages(request, signal) {
  const { key, model, prompt, n, aspectRatio, resolution, outputDir, output } = request;
  const body = {
    model,
    prompt,
    n,
    aspect_ratio: aspectRatio,
    resolution,
    response_format: "b64_json",
  };
  const response = await fetch("https://api.x.ai/v1/images/generations", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 2000);
    throw new Error(`x.ai image generation failed (HTTP ${response.status}): ${detail}`);
  }
  const payload = await response.json();
  const items = Array.isArray(payload.data) ? payload.data : [];
  if (items.length === 0) throw new Error("x.ai returned no images");
  await mkdir(outputDir, { recursive: true });
  const saved = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const b64 = item.b64_json ?? (item.url !== undefined ? undefined : undefined);
    if (typeof b64 !== "string" || b64.length === 0) {
      throw new Error(`x.ai image ${i} has no b64_json payload (response_format must be b64_json)`);
    }
    const bytes = Buffer.from(b64, "base64");
    const ext = extForBytes(bytes);
    const base =
      output !== undefined
        ? items.length === 1
          ? output.replace(/\.[^.]+$/, "")
          : output.replace(/\.[^.]+$/, `-${String(i + 1)}`)
        : join(outputDir, `grok-img-${Date.now().toString(36)}-${String(i + 1)}`);
    const target = `${base}${ext}`;
    await writeFile(resolve(target), bytes);
    saved.push(resolve(target));
  }
  return saved;
}

/** Detect the real image extension from magic bytes (x.ai may return JPEG for .png requests). */
function extForBytes(bytes) {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8) return ".jpg";
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return ".png";
  if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46) return ".webp";
  return ".png";
}

/** Extract the `description` field from a SKILL.md frontmatter block. */
function frontmatterDescription(content, fallback) {
  const match = /^---\n([\s\S]*?)\n---/.exec(content);
  if (match === null) return fallback;
  const line = match[1]
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.startsWith("description:"));
  if (line === undefined) return fallback;
  return line.slice("description:".length).trim().replace(/^["']|["']$/g, "");
}

/**
 * Register the baoyu style skills into the global skills layer. Skill bodies
 * load on demand, so shipping the full markdown is cheap; the resource base
 * points at the asset directory for reference files.
 */
async function registerStyleSkills(ctx) {
  const skills = ctx.get("skills");
  if (skills === undefined) return;
  const base = styleAssetDir();
  for (const [skillName, dir] of STYLE_SKILLS) {
    try {
      const content = await readFile(join(base, dir, "SKILL.md"), "utf8");
      skills.register({
        name: skillName,
        description: frontmatterDescription(content, `Baoyu ${skillName} style guide for image generation.`),
        whenToUse: `Use when the user asks to generate images in the ${dir} style (see the skill body for triggers).`,
        content,
        source: "runtime",
        resourceBase: { kind: "directory", path: join(base, dir) },
      });
    } catch (error) {
      console.error(`[tool-grok-vision] failed to register style skill ${skillName}:`, error.message);
    }
  }
}

/**
 * Register the `grok_vision` and `grok_generate_image` tools plus the style
 * skills and system-prompt guidance.
 * Registrations are effect-scoped and unregister on plugin dispose.
 */
async function apply(ctx, config) {
  const resolved = config;
  assertPositiveInteger("timeoutMs", resolved.timeoutMs);
  assertPositiveInteger("maxImageBytes", resolved.maxImageBytes);
  assertPositiveInteger("maxImages", resolved.maxImages);
  assertPositiveInteger("imageTimeoutMs", resolved.imageTimeoutMs);

  await registerStyleSkills(ctx);

  ctx.systemPrompt.section({
    name: "tool:grok_vision",
    order: 115,
    text: 'Your primary model cannot see images directly. When a task requires visual understanding — a screenshot, diagram, chart, UI mockup, or photo — call the grok_vision tool instead of asking the user to describe them. Image sources: local file paths, "clipboard" (use when the user says they copied/screenshotted something to the clipboard), and "screen" (use when the user wants you to look at their screen). For IMAGE GENERATION, call grok_generate_image; when the user wants a specific visual style (article cover, infographic, comic, xiaohongshu cards), load the matching baoyu-* skill first and follow its style spec in the prompt, or pass the style key to the tool.',
  });

  ctx.tools.register(
    defineTool({
      name: "grok_vision",
      description:
        "Analyze images with the local Grok multimodal model. Call this when you need visual understanding (image content, screenshots, diagrams, charts, UI inspection) that your primary model cannot perform. Sources: local file paths (PNG/JPEG/WebP/GIF), 'clipboard' for the macOS clipboard image, or 'screen' to capture the user's display. The answer is returned as text.",
      parameters: {
        images: {
          type: "array",
          required: true,
          description:
            'Image sources: absolute or workspace-relative file paths, and/or the special values "clipboard" (macOS clipboard image) and "screen" (capture the display).',
          items: { type: "string" },
        },
        prompt: {
          type: "string",
          required: true,
          description: "What to analyze, extract, or answer about the images.",
        },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            text: { type: "string", required: true },
          },
        },
        render: (_args, value) => [{ type: "text", text: value.text }],
      },
      timeoutMs: resolved.timeoutMs,
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const { images, prompt } = args;
        if (!Array.isArray(images) || images.length === 0) {
          throw new Error(
            'images must be a non-empty array of file paths or "clipboard"/"screen"',
          );
        }
        if (images.length > resolved.maxImages) {
          throw new Error(
            `at most ${resolved.maxImages} images per call (got ${images.length})`,
          );
        }
        if (prompt.trim().length === 0) {
          throw new Error("prompt must be a non-empty string");
        }

        const workDir = await mkdtemp(join(tmpdir(), "dsh-grok-vision-"));
        try {
          const blocks = [];
          let specialIndex = 0;
          for (const input of images) {
            const trimmed = String(input).trim();
            let imagePath;
            if (trimmed === "clipboard") {
              imagePath = join(workDir, `clipboard-${specialIndex++}.png`);
              await materializeClipboard(imagePath);
            } else if (trimmed === "screen") {
              imagePath = join(workDir, `screen-${specialIndex++}.png`);
              await materializeScreen(imagePath);
            } else {
              imagePath = resolveImagePath(trimmed);
            }
            blocks.push(await readImageBlock(imagePath, resolved.maxImageBytes));
          }
          blocks.push({ type: "text", text: prompt });

          const promptFile = join(workDir, "prompt.json");
          await writeFile(promptFile, JSON.stringify(blocks));
          const stdout = await runGrok(
            resolved.grokBin,
            promptFile,
            resolved.timeoutMs,
            exec.signal,
          );
          return parseGrokOutput(stdout);
        } finally {
          await rm(workDir, { recursive: true, force: true }).catch(() => {});
        }
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: "grok_generate_image",
      description:
        "Generate raster images with the x.ai grok-imagine model. Call this when the user asks to generate, create, or draw images (article covers, infographics, comics, xiaohongshu cards, illustrations). Optionally pass a style key (cover/infographic/comic/xhs) to attach the bundled baoyu style spec to the prompt; for full control, load the matching baoyu-* skill and write the complete styled prompt yourself. Returns local file paths of the saved images.",
      parameters: {
        prompt: {
          type: "string",
          required: true,
          description: "The image content description; write it in the target language and style.",
        },
        style: {
          type: "string",
          description:
            "Optional bundled style spec to prepend: cover (article covers), infographic, comic, or xhs (xiaohongshu cards).",
          enum: ["cover", "infographic", "comic", "xhs"],
        },
        aspect_ratio: {
          type: "string",
          description: "Target aspect ratio.",
          enum: ["1:1", "3:4", "4:3", "9:16", "16:9", "2:3", "3:2", "2:1", "1:2", "auto"],
          default: "16:9",
        },
        resolution: {
          type: "string",
          description: "Output resolution tier.",
          enum: ["1k", "2k"],
          default: "1k",
        },
        n: {
          type: "number",
          description: "Number of images to generate (1-4).",
          default: 1,
        },
        output: {
          type: "string",
          description:
            "Optional output file path (e.g. /path/cover.png). When omitted, images land in the plugin's output directory. With n > 1 a numeric suffix is appended.",
        },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            images: {
              type: "array",
              required: true,
              items: { type: "string" },
            },
          },
        },
        render: (_args, value) => [
          { type: "text", text: `Generated images:\n${value.images.map((p) => `- ${p}`).join("\n")}` },
        ],
      },
      timeoutMs: resolved.imageTimeoutMs,
      isConcurrencySafe: () => true,
      async execute(args, exec) {
        const { prompt, style, aspect_ratio: aspectRatio, resolution, n, output } = args;
        if (prompt.trim().length === 0) throw new Error("prompt must be a non-empty string");
        const count = n ?? 1;
        if (!Number.isInteger(count) || count < 1 || count > 4) {
          throw new Error("n must be an integer between 1 and 4");
        }
        const fullPrompt =
          style !== undefined
            ? `Follow the style specification below when generating the image.\n\n--- STYLE SPEC START ---\n${await loadStyleSnippet(style)}\n--- STYLE SPEC END ---\n\nContent request: ${prompt}`
            : prompt;
        const key = await resolveXaiKey(resolved.xaiApiKey);
        return {
          images: await generateImages(
            {
              key,
              model: resolved.imageModel,
              prompt: fullPrompt,
              n: count,
              aspectRatio,
              resolution,
              outputDir: resolved.outputDir,
              ...(output !== undefined && output.length > 0 ? { output } : {}),
            },
            exec.signal,
          ),
        };
      },
    }),
  );
}

export {
  Config,
  DEFAULT_IMAGE_TIMEOUT_MS,
  DEFAULT_MAX_IMAGE_BYTES,
  DEFAULT_MAX_IMAGES,
  DEFAULT_OUTPUT_DIR,
  DEFAULT_TIMEOUT_MS,
  apply,
  inject,
  name,
};
