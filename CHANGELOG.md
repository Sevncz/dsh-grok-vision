# Changelog

## 0.1.1

- After `link:`, create flat host-peer symlinks under this package so Node can resolve `@deepseek-ai/schemastery` and the other peers from the checkout realpath (same pattern as `$DSH_HOME/profiles/node_modules`).
- Ship as a DSH bundle: `dsh.bundle.patch` + package `cordis.patch.yml`. Install with `dsh plugin --profile web add`, not by writing into the user's `cordis.patch.yml`.
- Install with `link:` (directory symlink). `file:` snapshots the package at add time, so later `styles/` never appears in the profile `node_modules` and a hard `apply()` throw takes down the whole DSH host.
- Style-skill registration degrades: missing assets are logged, `apply()` still succeeds, tools stay available.

- Ship baoyu style assets inside the package so `file:` installs register the four skills and `style=` snippets.
- Resolve relative `images` / `output` / `ref` against the session workspace, not the host `process.cwd()`.
- Create `output` parent directories; suffix `n > 1` even when the path has no extension; unique default filenames.
- Add `ref` (up to 3 workspace images) and route those calls to `/v1/images/edits`.
- Accept cinematic `2.35:1` and other `W:H` aspect ratios.
- Reject paths outside the session workspace (plus configured `outputDir`).
- Fail closed on an expired Grok OIDC token; prefer `xaiApiKey` / `XAI_API_KEY`.
- Run Grok vision as a single-turn completion (`--no-subagents --verbatim --max-turns 1`).
- Fail fast when `clipboard` / `screen` run off macOS.
- Parse `cordis.patch.yml` without rewriting the first `[]` inside another mapping.
