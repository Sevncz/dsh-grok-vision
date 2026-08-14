// Host-level `grok_vision` tool: delegate multimodal (image) analysis to the
// local Grok CLI (`grok --prompt-file <json> --output-format json`, single-turn
// headless). Registered through `ctx.tools`, so it is visible to every session
// whose composition mounts this package — intended for the HOST composition,
// never per-preset.
import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, isAbsolute, join, resolve } from "node:path";

/** Cordis plugin name used by loader diagnostics. */
const name = "tool-grok-vision";

/** Services required by this tool suite. */
const inject = ["tools", "systemPrompt"];

const DEFAULT_TIMEOUT_MS = 120000;
const DEFAULT_MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_IMAGES = 4;

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

const Config = z.object({
  /** Path or name of the local grok binary. */
  grokBin: z.string().default("grok"),
  /** Cooperative tool-call budget (ms); also backs the internal kill timer. */
  timeoutMs: z.number().default(DEFAULT_TIMEOUT_MS),
  /** Per-image size ceiling in bytes. */
  maxImageBytes: z.number().default(DEFAULT_MAX_IMAGE_BYTES),
  /** Maximum number of images per call. */
  maxImages: z.number().default(DEFAULT_MAX_IMAGES),
});

function assertPositiveInteger(label, value) {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`tool-grok-vision: ${label} must be a positive integer`);
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
 * Register the `grok_vision` tool and its system-prompt guidance.
 * Registrations are effect-scoped and unregister on plugin dispose.
 */
function apply(ctx, config) {
  const resolved = config;
  assertPositiveInteger("timeoutMs", resolved.timeoutMs);
  assertPositiveInteger("maxImageBytes", resolved.maxImageBytes);
  assertPositiveInteger("maxImages", resolved.maxImages);

  ctx.systemPrompt.section({
    name: "tool:grok_vision",
    order: 115,
    text: "Your primary model cannot see images directly. When a task requires visual understanding — a screenshot, diagram, chart, UI mockup, or photo — call the grok_vision tool with the local image file paths instead of asking the user to describe them. Prefer read_image (when available) or grok_vision for visual inputs.",
  });

  ctx.tools.register(
    defineTool({
      name: "grok_vision",
      description:
        "Analyze local image files with the local Grok multimodal model. Call this when you need visual understanding (image content, screenshots, diagrams, charts, UI inspection) that your primary model cannot perform. Images are read from disk and sent to Grok; the answer is returned as text.",
      parameters: {
        images: {
          type: "array",
          required: true,
          description:
            "Paths to local image files (PNG/JPEG/WebP/GIF), resolved relative to the session workspace.",
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
          throw new Error("images must be a non-empty array of file paths");
        }
        if (images.length > resolved.maxImages) {
          throw new Error(
            `at most ${resolved.maxImages} images per call (got ${images.length})`,
          );
        }
        if (prompt.trim().length === 0) {
          throw new Error("prompt must be a non-empty string");
        }

        const blocks = [];
        for (const input of images) {
          const imagePath = resolveImagePath(input);
          blocks.push(await readImageBlock(imagePath, resolved.maxImageBytes));
        }
        blocks.push({ type: "text", text: prompt });

        const workDir = await mkdtemp(join(tmpdir(), "dsh-grok-vision-"));
        const promptFile = join(workDir, "prompt.json");
        try {
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
}

export { Config, DEFAULT_MAX_IMAGE_BYTES, DEFAULT_MAX_IMAGES, DEFAULT_TIMEOUT_MS, apply, inject, name };
