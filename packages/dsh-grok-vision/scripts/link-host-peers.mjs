#!/usr/bin/env node
// Point this package's node_modules at the DSH host copies of our peers.
// `link:` makes Node resolve from this checkout's realpath, so the walk-up
// never reaches $DSH_HOME/profiles/node_modules unless we add the same
// flat-symlink pattern dsh-app-boot uses there.
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pkgRoot = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const manifest = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf8"));
const peers = Object.keys(manifest.peerDependencies ?? {});
const dshHome = process.env.DSH_HOME ?? join(homedir(), ".dsh");
const fallbackDir = join(dshHome, "profiles", "node_modules");

function resolveHostDir(name) {
  const fromFallback = join(fallbackDir, name);
  if (existsSync(fromFallback)) return fromFallback;
  const extra = process.env.DSH_HOST_NODE_MODULES;
  if (typeof extra === "string" && extra.length > 0) {
    const fromExtra = join(extra, name);
    if (existsSync(fromExtra)) return fromExtra;
  }
  return undefined;
}

function ensureSymlink(link, target) {
  mkdirSync(dirname(link), { recursive: true });
  try {
    symlinkSync(target, link);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    if (lstatSync(link).isSymbolicLink() && readlinkSync(link) === target) return;
    rmSync(link, { recursive: true, force: true });
    symlinkSync(target, link);
  }
}

const missing = [];
for (const name of peers) {
  const target = resolveHostDir(name);
  if (target === undefined) {
    missing.push(name);
    continue;
  }
  ensureSymlink(join(pkgRoot, "node_modules", name), target);
  process.stdout.write(`linked ${name} -> ${target}\n`);
}

if (missing.length > 0) {
  process.stderr.write(
    `link-host-peers: no host copy of ${missing.join(", ")} under ${fallbackDir}\n` +
      "Run `npx @deepseek-ai/dsh --profile web --dump-config` once so dsh heals profiles/node_modules, then re-run this script.\n",
  );
  process.exit(1);
}
