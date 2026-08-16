#!/usr/bin/env bash
# Install this package as a DSH bundle into the web profile:
#   dsh plugin --profile web add ./packages/dsh-grok-vision
# That is the official path (docs/user/develop/basic/publish.zh.md):
#   link: the checkout, then append dsh.profile.bundles because we declare dsh.bundle.
# Also strips a leftover host-row we used to write into the user's cordis.patch.yml
# (that row would double-load the plugin after the bundle layer exists).
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_DIR="$REPO_DIR/packages/dsh-grok-vision"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PROFILE="${DSH_PROFILE:-web}"
PROFILE_DIR="$DSH_HOME/profiles/$PROFILE"
PATCH="$PROFILE_DIR/cordis.patch.yml"

if [ ! -d "$PKG_DIR" ]; then
  echo "错误：未找到插件包 $PKG_DIR" >&2
  exit 1
fi

if command -v dsh >/dev/null 2>&1; then
  DSH=(dsh)
else
  command -v npx >/dev/null 2>&1 || { echo "错误：未找到 dsh 或 npx" >&2; exit 1; }
  DSH=(npx --yes @deepseek-ai/dsh)
fi

echo "==> 1/3 dsh plugin --profile $PROFILE add $PKG_DIR"
# Relative specs are anchored to the invoking cwd; run from the repo so `.` is this checkout.
"${DSH[@]}" plugin --profile "$PROFILE" add "$PKG_DIR"
echo "    提示：pnpm 的 missing peer warning 属预期（见 README「安装」），忽略即可"

echo "==> 2/3 把宿主 peer 链到本包 node_modules（link: 从 checkout realpath 解析）"
if [ ! -e "$DSH_HOME/profiles/node_modules/@deepseek-ai/schemastery" ]; then
  echo "    profiles/node_modules 尚未愈合，先跑一次 --dump-config"
  "${DSH[@]}" --profile "$PROFILE" --dump-config >/dev/null
fi
node "$PKG_DIR/scripts/link-host-peers.mjs"

echo "==> 3/3 去掉用户 patch 里旧的手写宿主行（若有）"
python3 - "$PATCH" <<'PYEOF'
import os
import re
import sys

path = sys.argv[1]
if not os.path.exists(path):
    print("    无用户 patch，跳过")
    raise SystemExit(0)

text = open(path).read()
if "id: dsh-grok-vision" not in text:
    print("    用户 patch 无旧宿主行，跳过")
    raise SystemExit(0)

# Drop the insert list item whose id is dsh-grok-vision, plus the comment we used to write above it.
pattern = re.compile(
    r"(?:^# (?:Host-level grok_vision|dsh-grok-vision host tools).*\n)*"
    r"- insert:\n"
    r"(?:    .*\n)*"
    r"    - id: dsh-grok-vision\n"
    r"(?:      .*\n)*",
    re.M,
)
new, n = pattern.subn("", text, count=1)
if n == 0:
    print("    未能解析旧宿主行，请手工从 cordis.patch.yml 删掉 id: dsh-grok-vision", file=sys.stderr)
    raise SystemExit(1)

stripped = re.sub(r"(?m)^\s*#.*$", "", new).strip()
if stripped in ("", "[]"):
    new = """# Your patch layer for this dsh profile, applied after every bundle layer:
# a top-level YAML array of loader patch entries (id-targeted config
# overrides, disables, and insert lists; `!!js` expressions allowed).
[]
"""
open(path, "w").write(new)
print("    已移除旧宿主行（改由组合包层插入）")
PYEOF

echo "完成。重启 DSH（npx @deepseek-ai/dsh web）。可用 dsh --profile $PROFILE --dump-config 确认存在 # == dsh-grok-vision 层。"
