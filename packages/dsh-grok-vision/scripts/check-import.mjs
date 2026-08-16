#!/usr/bin/env node
// Import the shipped entry from this checkout (the same realpath dsh uses
// after `link:`) and require host peers to resolve to the DSH install.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const pkgRoot = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const repoRoot = dirname(dirname(pkgRoot));
const entry = join(pkgRoot, "lib", "runtime.js");
const linker = join(pkgRoot, "scripts", "link-host-peers.mjs");
const dshHome = process.env.DSH_HOME ?? join(homedir(), ".dsh");
const profilesNm = realpathSync(join(dshHome, "profiles", "node_modules"));

const linked = spawnSync(process.execPath, [linker], { encoding: "utf8" });
process.stdout.write(linked.stdout);
process.stderr.write(linked.stderr);
assert.equal(linked.status, 0, `link-host-peers failed: ${linked.stderr}`);

const mod = await import(pathToFileURL(entry).href);
assert.equal(typeof mod.apply, "function", "shipped entry must export apply");
assert.ok(Array.isArray(mod.inject) && mod.inject.includes("tools"), "inject must include tools");

function packageRootOf(file) {
  let dir = dirname(file);
  for (;;) {
    if (existsSync(join(dir, "package.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`no package.json above ${file}`);
    dir = parent;
  }
}

function assertHostPackage(name) {
  const resolved = fileURLToPath(import.meta.resolve(name, pathToFileURL(entry).href));
  const real = realpathSync(resolved);
  const pkgDir = packageRootOf(real);
  const underRepoNm = pkgDir.startsWith(join(repoRoot, "node_modules") + sep);
  const underPnpmStore = pkgDir.includes(`${sep}.pnpm${sep}`);
  assert.equal(underPnpmStore && underRepoNm, false, `${name} resolved to a repo-vendored pnpm copy: ${pkgDir}`);
  const underProfiles = pkgDir.startsWith(profilesNm + sep);
  const siblingDsh = existsSync(join(dirname(pkgDir), "dsh", "package.json"));
  assert.ok(
    underProfiles || siblingDsh,
    `${name} must resolve to the DSH host copy, got ${pkgDir}`,
  );
  process.stdout.write(`${name}\n  resolve: ${resolved}\n  realpath: ${real}\n  package: ${pkgDir}\n`);
  return real;
}

assertHostPackage("@deepseek-ai/schemastery");
assertHostPackage("@deepseek-ai/dsh-tools");

const requireFromEntry = createRequire(entry);
for (const name of ["@deepseek-ai/cordis", "@deepseek-ai/dsh-system-prompt"]) {
  const resolved = requireFromEntry.resolve(name);
  process.stdout.write(`${name}\n  resolve: ${resolved}\n  realpath: ${realpathSync(resolved)}\n`);
}

process.stdout.write(`imported ${entry}\napply=${typeof mod.apply} inject=${JSON.stringify(mod.inject)}\n`);
