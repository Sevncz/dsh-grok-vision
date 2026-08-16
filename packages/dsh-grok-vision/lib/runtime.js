// Host-level grok_vision + grok_generate_image. Registered through ctx.tools
// so every session that mounts this package can see both tools.
import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const name = "tool-grok-vision";
const inject = ["tools", "systemPrompt"];

const DEFAULT_TIMEOUT_MS = 120000;
const DEFAULT_MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_IMAGES = 4;
const DEFAULT_IMAGE_TIMEOUT_MS = 180000;
const DEFAULT_OUTPUT_DIR = "/tmp/dsh-grok-images";
const MAX_STDOUT_BYTES = 4 * 1024 * 1024;
const MAX_REFS = 3;
const ASPECT_RATIO_RE = /^(auto|\d+(?:\.\d+)?:\d+(?:\.\d+)?)$/;

const MIME_BY_EXT = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

/** Baoyu style assets shipped in this package: skill name → directory → style key. */
const STYLE_SKILLS = [
  ["baoyu-cover-image", "baoyu-cover-image", "cover"],
  ["baoyu-infographic", "baoyu-infographic", "infographic"],
  ["baoyu-comic", "baoyu-comic", "comic"],
  ["baoyu-xhs-images", "baoyu-xhs-images", "xhs"],
];

const Config = z.object({
  grokBin: z.string().default("grok"),
  timeoutMs: z.number().default(DEFAULT_TIMEOUT_MS),
  maxImageBytes: z.number().default(DEFAULT_MAX_IMAGE_BYTES),
  maxImages: z.number().default(DEFAULT_MAX_IMAGES),
  imageModel: z.string().default("grok-imagine-image"),
  imageTimeoutMs: z.number().default(DEFAULT_IMAGE_TIMEOUT_MS),
  outputDir: z.string().default(DEFAULT_OUTPUT_DIR),
  savePrompt: z.boolean().default(true),
  xaiApiKey: z.string(),
});

function assertPositiveInteger(label, value) {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`tool-grok-vision: ${label} must be a positive integer`);
  }
}

function assertDarwin(feature) {
  if (process.platform !== "darwin") {
    throw new Error(`${feature} is only supported on macOS`);
  }
}

function workspaceCwd(exec) {
  const cwd = exec.agent?.session?.header?.cwd;
  return typeof cwd === "string" && cwd.length > 0 ? cwd : process.cwd();
}

function isInsideRoot(root, candidate) {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

/** Resolve a model-supplied path against the session workspace; reject escapes. */
function resolveUserPath(input, exec, extraRoots = []) {
  const trimmed = String(input).trim();
  if (trimmed.length === 0) throw new Error("path must be a non-empty string");
  const cwd = workspaceCwd(exec);
  const abs = isAbsolute(trimmed) ? resolve(trimmed) : resolve(cwd, trimmed);
  const roots = [cwd, ...extraRoots.map((root) => (isAbsolute(root) ? resolve(root) : resolve(cwd, root)))];
  if (!roots.some((root) => isInsideRoot(root, abs))) {
    throw new Error(`path is outside the session workspace: ${trimmed}`);
  }
  return abs;
}

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

async function materializeClipboard(targetPath) {
  assertDarwin("clipboard");
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

async function materializeScreen(targetPath) {
  assertDarwin("screen");
  try {
    await runCommand("screencapture", ["-x", "-C", targetPath], 30000);
  } catch (error) {
    throw new Error(`failed to capture the screen: ${error.message}`);
  }
}

function mimeFor(imagePath) {
  return MIME_BY_EXT[extname(imagePath).toLowerCase()];
}

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

function runGrok(grokBin, promptFile, timeoutMs, signal) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(
      grokBin,
      [
        "--prompt-file",
        promptFile,
        "--output-format",
        "json",
        "--no-subagents",
        "--verbatim",
        "--max-turns",
        "1",
        "--permission-mode",
        "dontAsk",
        "--disable-web-search",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
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
        rejectPromise(new Error(`grok exited with code ${code ?? exitSignal}${detail}`));
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
      return { text: trimmed };
    }
    throw error;
  }
}

function isFreshAuthEntry(entry, now) {
  if (typeof entry?.key !== "string" || entry.key.length === 0) return false;
  if (typeof entry.expires_at !== "string" || entry.expires_at.length === 0) return true;
  const expires = Date.parse(entry.expires_at);
  return Number.isFinite(expires) && expires > now + 30_000;
}

async function resolveXaiKey(explicit) {
  if (explicit !== undefined && explicit.length > 0) return explicit;
  const envKey = process.env.XAI_API_KEY;
  if (typeof envKey === "string" && envKey.length > 0) return envKey;
  let auth;
  try {
    const authPath = join(homedir(), ".grok", "auth.json");
    auth = JSON.parse(await readFile(authPath, "utf8"));
  } catch {
    throw new Error(
      "no xAI API key: set `xaiApiKey` / XAI_API_KEY or log in with the local grok CLI (`grok login`)",
    );
  }
  const entries = Object.values(auth).filter((entry) => entry !== null && typeof entry === "object");
  const now = Date.now();
  const fresh = entries.filter((entry) => isFreshAuthEntry(entry, now));
  if (fresh.length === 0) {
    const anyKey = entries.some((entry) => typeof entry.key === "string" && entry.key.length > 0);
    throw new Error(
      anyKey
        ? "Grok login token expired. Run `grok login` or set `xaiApiKey` / XAI_API_KEY."
        : "no xAI API key: set `xaiApiKey` / XAI_API_KEY or log in with the local grok CLI (`grok login`)",
    );
  }
  fresh.sort((a, b) => Date.parse(b.expires_at ?? 0) - Date.parse(a.expires_at ?? 0));
  return fresh[0].key;
}

function styleAssetDir() {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "styles");
}

async function loadStyleSnippet(styleKey) {
  const entry = STYLE_SKILLS.find(([, , key]) => key === styleKey);
  if (entry === undefined) {
    throw new Error(`unknown style "${styleKey}" (supported: ${STYLE_SKILLS.map(([, , k]) => k).join(", ")})`);
  }
  return await readFile(join(styleAssetDir(), "summaries", `${styleKey}.md`), "utf8");
}

function extForBytes(bytes) {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8) return ".jpg";
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return ".png";
  }
  if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46) {
    return ".webp";
  }
  return ".png";
}

function outputStem(output, outputDir, index, count) {
  if (output === undefined) {
    return join(outputDir, `grok-img-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}-${String(index + 1)}`);
  }
  const abs = resolve(output);
  const ext = extname(abs);
  const dir = dirname(abs);
  const stem = ext.length > 0 ? abs.slice(0, -ext.length) : abs;
  return count === 1 ? stem : `${stem}-${String(index + 1)}`;
}

function assertAspectRatio(value) {
  if (value === undefined || ASPECT_RATIO_RE.test(value)) return;
  throw new Error(`invalid aspect_ratio "${value}" (use auto, 16:9, 2.35:1, or any W:H)`);
}

async function generateImages(request, signal) {
  const { key, model, prompt, n, aspectRatio, resolution, outputDir, output, refs } = request;
  const hasRefs = Array.isArray(refs) && refs.length > 0;
  const body = {
    model,
    prompt,
    n,
    aspect_ratio: aspectRatio,
    resolution,
    response_format: "b64_json",
  };
  if (hasRefs) {
    const images = refs.map((block) => ({
      type: "image_url",
      url: `data:${block.mimeType};base64,${block.data}`,
    }));
    if (images.length === 1) body.image = images[0];
    else body.images = images;
  }
  const endpoint = hasRefs ? "https://api.x.ai/v1/images/edits" : "https://api.x.ai/v1/images/generations";
  const response = await fetch(endpoint, {
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
    throw new Error(`x.ai image ${hasRefs ? "edit" : "generation"} failed (HTTP ${response.status}): ${detail}`);
  }
  const payload = await response.json();
  const items = Array.isArray(payload.data) ? payload.data : [];
  if (items.length === 0) throw new Error("x.ai returned no images");
  const saved = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const b64 = item.b64_json;
    if (typeof b64 !== "string" || b64.length === 0) {
      throw new Error(`x.ai image ${i} has no b64_json payload (response_format must be b64_json)`);
    }
    const bytes = Buffer.from(b64, "base64");
    const ext = extForBytes(bytes);
    const target = `${outputStem(output, outputDir, i, items.length)}${ext}`;
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes);
    saved.push(target);
  }
  return saved;
}

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

async function registerStyleSkills(ctx) {
  const skills = ctx.get("skills");
  if (skills === undefined) return;
  const base = styleAssetDir();
  const missing = [];
  for (const [skillName, dir] of STYLE_SKILLS) {
    const skillPath = join(base, dir, "SKILL.md");
    let content;
    try {
      content = await readFile(skillPath, "utf8");
    } catch {
      missing.push(skillPath);
      continue;
    }
    skills.register({
      name: skillName,
      description: frontmatterDescription(content, `Baoyu ${skillName} style guide for image generation.`),
      whenToUse: `Use when the user asks to generate images in the ${dir} style (see the skill body for triggers).`,
      content,
      source: "runtime",
      resourceBase: { kind: "directory", path: join(base, dir) },
    });
  }
  if (missing.length > 0) {
    console.error(
      `[tool-grok-vision] style skills not registered (host will still start). Re-run ./install.sh so the profile uses link: to this package. Missing:\n${missing.map((p) => `  ${p}`).join("\n")}`,
    );
  }
}

async function writePromptRecord(images, record) {
  const target = images[0];
  if (target === undefined) return;
  const mdPath = target.replace(/\.[^.]+$/, "") + ".md";
  const lines = [
    "# Image Generation Prompt",
    "",
    `- Generated: ${new Date().toISOString()}`,
    `- Model: ${record.model}`,
    `- Style: ${record.style ?? "-"}`,
    `- Aspect ratio: ${record.aspectRatio}`,
    `- Resolution: ${record.resolution}`,
    images.length > 0 ? `- Outputs:\n${images.map((p) => `    - ${p}`).join("\n")}` : "",
    "",
    "## Prompt",
    "",
    record.prompt,
    "",
  ];
  await writeFile(mdPath, lines.join("\n")).catch((error) => {
    console.error("[tool-grok-vision] failed to write prompt record:", error.message);
  });
}

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
    text: 'Your primary model cannot see images directly. When a task requires visual understanding — a screenshot, diagram, chart, UI mockup, or photo — call the grok_vision tool instead of asking the user to describe them. Image sources: local file paths inside the session workspace, "clipboard" (macOS clipboard image), and "screen" (macOS display capture). For IMAGE GENERATION, call grok_generate_image; pass ref (up to 3 workspace image paths) when the skill needs visual consistency. When the user wants a specific visual style (article cover, infographic, comic, xiaohongshu cards), load the matching baoyu-* skill first and follow its style spec in the prompt, or pass the style key to the tool.',
  });

  ctx.tools.register(
    defineTool({
      name: "grok_vision",
      description:
        "Analyze images with the local Grok multimodal model. Call this when you need visual understanding (image content, screenshots, diagrams, charts, UI inspection) that your primary model cannot perform. Sources: workspace file paths (PNG/JPEG/WebP/GIF), 'clipboard' for the macOS clipboard image, or 'screen' to capture the macOS display. The answer is returned as text.",
      parameters: {
        images: {
          type: "array",
          required: true,
          description:
            'Image sources: absolute or workspace-relative file paths, and/or the special values "clipboard" (macOS clipboard image) and "screen" (macOS display capture).',
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
          throw new Error('images must be a non-empty array of file paths or "clipboard"/"screen"');
        }
        if (images.length > resolved.maxImages) {
          throw new Error(`at most ${resolved.maxImages} images per call (got ${images.length})`);
        }
        if (prompt.trim().length === 0) {
          throw new Error("prompt must be a non-empty string");
        }

        const extraRoots = [resolved.outputDir];
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
              imagePath = resolveUserPath(trimmed, exec, extraRoots);
            }
            blocks.push(await readImageBlock(imagePath, resolved.maxImageBytes));
          }
          blocks.push({ type: "text", text: prompt });

          const promptFile = join(workDir, "prompt.json");
          await writeFile(promptFile, JSON.stringify(blocks));
          const stdout = await runGrok(resolved.grokBin, promptFile, resolved.timeoutMs, exec.signal);
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
        "Generate raster images with the x.ai grok-imagine model. Call this when the user asks to generate, create, or draw images (article covers, infographics, comics, xiaohongshu cards, illustrations). Optionally pass a style key (cover/infographic/comic/xhs) to attach the bundled baoyu style spec. Pass ref (up to 3 workspace image paths) for character/style consistency — that uses the image-edit endpoint. Returns local file paths of the saved images.",
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
          description:
            "Target aspect ratio: auto, 1:1, 3:4, 4:3, 9:16, 16:9, 2:3, 3:2, 2:1, 1:2, 2.35:1, or any W:H the Imagine API accepts.",
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
        ref: {
          type: "array",
          description:
            "Optional reference images (up to 3 workspace paths). When set, the call uses /v1/images/edits instead of text-to-image. Use this for character sheets, previous-card anchors, and style refs.",
          items: { type: "string" },
        },
        output: {
          type: "string",
          description:
            "Optional output file path (workspace-relative or absolute under the workspace / outputDir). When omitted, images land in the plugin's output directory. With n > 1 a numeric suffix is appended even if the path has no extension.",
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
        const { prompt, style, aspect_ratio: aspectRatio, resolution, n, output, ref } = args;
        if (prompt.trim().length === 0) throw new Error("prompt must be a non-empty string");
        assertAspectRatio(aspectRatio);
        const count = n ?? 1;
        if (!Number.isInteger(count) || count < 1 || count > 4) {
          throw new Error("n must be an integer between 1 and 4");
        }
        const extraRoots = [resolved.outputDir];
        const outputDir = isAbsolute(resolved.outputDir)
          ? resolve(resolved.outputDir)
          : resolve(workspaceCwd(exec), resolved.outputDir);
        let resolvedOutput;
        if (output !== undefined && output.length > 0) {
          resolvedOutput = resolveUserPath(output, exec, extraRoots);
        }
        const refInputs = Array.isArray(ref) ? ref : [];
        if (refInputs.length > MAX_REFS) {
          throw new Error(`ref accepts at most ${MAX_REFS} images (x.ai images/edits limit)`);
        }
        const refBlocks = [];
        for (const item of refInputs) {
          const refPath = resolveUserPath(item, exec, extraRoots);
          refBlocks.push(await readImageBlock(refPath, resolved.maxImageBytes));
        }
        const fullPrompt =
          style !== undefined
            ? `Follow the style specification below when generating the image.\n\n--- STYLE SPEC START ---\n${await loadStyleSnippet(style)}\n--- STYLE SPEC END ---\n\nContent request: ${prompt}`
            : prompt;
        const key = await resolveXaiKey(resolved.xaiApiKey);
        const images = await generateImages(
          {
            key,
            model: resolved.imageModel,
            prompt: fullPrompt,
            n: count,
            aspectRatio,
            resolution,
            outputDir,
            ...(resolvedOutput !== undefined ? { output: resolvedOutput } : {}),
            ...(refBlocks.length > 0 ? { refs: refBlocks } : {}),
          },
          exec.signal,
        );
        if (resolved.savePrompt) {
          await writePromptRecord(images, {
            model: resolved.imageModel,
            style: style ?? null,
            aspectRatio,
            resolution,
            prompt: fullPrompt,
          });
        }
        return { images };
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
