import { spawnSync } from "child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { basename, join } from "path";
import { PDFDocument } from "pdf-lib";

interface PageInfo {
  filename: string;
  path: string;
  index: number;
  promptPath?: string;
}

function parseArgs(): { dir: string; output?: string } {
  const args = process.argv.slice(2);
  let dir = "";
  let output: string | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--output" || args[i] === "-o") {
      output = args[++i];
    } else if (!args[i].startsWith("-")) {
      dir = args[i];
    }
  }

  if (!dir) {
    console.error("Usage: bun merge-to-pdf.ts <comic-dir> [--output filename.pdf]");
    process.exit(1);
  }

  return { dir, output };
}

function findComicPages(dir: string): PageInfo[] {
  if (!existsSync(dir)) {
    console.error(`Directory not found: ${dir}`);
    process.exit(1);
  }

  const files = readdirSync(dir);
  const pagePattern = /^(\d+)-(cover|page)(-[\w-]+)?\.(png|jpg|jpeg|webp)$/i;
  const promptsDir = join(dir, "prompts");
  const hasPrompts = existsSync(promptsDir);

  const pages: PageInfo[] = files
    .filter((f) => pagePattern.test(f))
    .map((f) => {
      const match = f.match(pagePattern);
      const baseName = f.replace(/\.(png|jpg|jpeg|webp)$/i, "");
      const promptPath = hasPrompts ? join(promptsDir, `${baseName}.md`) : undefined;

      return {
        filename: f,
        path: join(dir, f),
        index: parseInt(match![1], 10),
        promptPath: promptPath && existsSync(promptPath) ? promptPath : undefined,
      };
    })
    .sort((a, b) => a.index - b.index);

  if (pages.length === 0) {
    console.error(`No comic pages found in: ${dir}`);
    console.error("Expected format: 00-cover-slug.png, 01-page-slug.png, etc.");
    process.exit(1);
  }

  return pages;
}

function bytesOf(page: PageInfo): Uint8Array {
  if (!page.filename.toLowerCase().endsWith(".webp")) {
    return readFileSync(page.path);
  }
  if (process.platform !== "darwin") {
    throw new Error(`${page.filename} is webp; convert to png/jpg before merging`);
  }
  const dir = mkdtempSync(join(tmpdir(), "comic-webp-"));
  const dest = join(dir, "page.png");
  try {
    const result = spawnSync("sips", ["-s", "format", "png", page.path, "--out", dest], {
      encoding: "utf8",
    });
    if (result.status !== 0) {
      throw new Error(`sips failed to convert ${page.filename}: ${result.stderr}`);
    }
    return readFileSync(dest);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function isJpeg(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8;
}

async function createPdf(pages: PageInfo[], outputPath: string) {
  const pdfDoc = await PDFDocument.create();
  pdfDoc.setAuthor("baoyu-comic");
  pdfDoc.setSubject("Generated Comic");

  for (const page of pages) {
    const imageData = bytesOf(page);
    const image = isJpeg(imageData) ? await pdfDoc.embedJpg(imageData) : await pdfDoc.embedPng(imageData);
    const { width, height } = image;
    const pdfPage = pdfDoc.addPage([width, height]);
    pdfPage.drawImage(image, { x: 0, y: 0, width, height });
    console.log(`Added: ${page.filename}${page.promptPath ? " (prompt available)" : ""}`);
  }

  writeFileSync(outputPath, await pdfDoc.save());
  console.log(`\nCreated: ${outputPath}`);
  console.log(`Total pages: ${pages.length}`);
}

async function main() {
  const { dir, output } = parseArgs();
  const pages = findComicPages(dir);

  const dirName = basename(dir) === "comic" ? basename(join(dir, "..")) : basename(dir);
  const outputPath = output || join(dir, `${dirName}.pdf`);

  console.log(`Found ${pages.length} pages in: ${dir}\n`);

  await createPdf(pages, outputPath);
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
