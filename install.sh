#!/usr/bin/env bash
# 将 dsh-grok-vision preset 安装到本机 DSH：
#   1. 复制 preset 到 ~/.dsh/.agent-presets/dsh-grok-vision（DSH 的预设扫描不跟随软链，必须真实目录）
#   2. 将 packages/dsh-grok-vision 登记为 web profile 的 file: 依赖
#   3. 将默认预设设为 dsh-grok-vision（写入或替换 ~/.dsh/settings.yaml 中的 agent-presets.default）
#
# 幂等：可反复执行。修改本仓库后重跑本脚本即完成同步。
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PRESET_DIR="$DSH_HOME/.agent-presets/dsh-grok-vision"
PROFILE_DIR="$DSH_HOME/profiles/web"
SETTINGS="$DSH_HOME/settings.yaml"

if [ ! -d "$PROFILE_DIR" ]; then
  echo "错误：未找到 DSH web profile 目录 $PROFILE_DIR" >&2
  exit 1
fi
command -v pnpm >/dev/null 2>&1 || { echo "错误：未找到 pnpm" >&2; exit 1; }

echo "==> 1/3 复制 preset 到用户预设目录"
if [ -e "$PRESET_DIR" ] || [ -L "$PRESET_DIR" ]; then
  rm -rf "$PRESET_DIR"
fi
mkdir -p "$PRESET_DIR"
cp "$REPO_DIR/agent.cordis.yml" "$REPO_DIR/preset.yml" "$PRESET_DIR/"

echo "==> 2/3 登记插件包为 web profile 依赖"
cd "$PROFILE_DIR"
pnpm add "dsh-grok-vision@file:$REPO_DIR/packages/dsh-grok-vision"

echo "==> 3/3 设置默认预设"
python3 - "$SETTINGS" <<'PYEOF'
import sys, os
path = sys.argv[1]
text = open(path).read() if os.path.exists(path) else ""
lines = text.splitlines(keepends=True)
out, i, inserted = [], 0, False
while i < len(lines):
    line = lines[i]
    if line.startswith("agent-presets:"):
        out.append(line)
        i += 1
        # 吸收该段下已有的 default 行（无论值是什么），用我们的值替换
        while i < len(lines):
            nxt = lines[i]
            if nxt.startswith("  default:"):
                i += 1
                continue
            break
        out.append("  default: dsh-grok-vision\n")
        inserted = True
        continue
    out.append(line)
    i += 1
if not inserted:
    if out and not out[-1].endswith("\n"):
        out.append("\n")
    out.append("\nagent-presets:\n  default: dsh-grok-vision\n")
open(path, "w").write("".join(out))
print("    已设置 agent-presets.default: dsh-grok-vision")
PYEOF

echo "完成。新会话即带 grok_vision 工具（当前运行中的会话不受影响）。"
