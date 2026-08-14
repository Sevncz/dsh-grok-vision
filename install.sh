#!/usr/bin/env bash
# 将 dsh-grok-vision 安装为本机 DSH 的宿主级插件：
#   1. 将 packages/dsh-grok-vision 登记为 web profile 的 file: 依赖
#   2. 在 profile 的 cordis.patch.yml 写入宿主行（幂等）
# 宿主层行在 DSH 启动时读取：安装完成后重启一次宿主即生效。
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PROFILE_DIR="$DSH_HOME/profiles/web"
PATCH="$PROFILE_DIR/cordis.patch.yml"

if [ ! -d "$PROFILE_DIR" ]; then
  echo "错误：未找到 DSH web profile 目录 $PROFILE_DIR" >&2
  exit 1
fi
command -v pnpm >/dev/null 2>&1 || { echo "错误：未找到 pnpm" >&2; exit 1; }

echo "==> 1/2 登记插件包为 web profile 依赖"
cd "$PROFILE_DIR"
pnpm add "dsh-grok-vision@file:$REPO_DIR/packages/dsh-grok-vision"

echo "==> 2/2 写入宿主行"
python3 - "$PATCH" <<'PYEOF'
import sys, os
path = sys.argv[1]
text = open(path).read() if os.path.exists(path) else "[]\n"
if "id: dsh-grok-vision" in text:
    print("    宿主行已存在，跳过")
else:
    entry = """
# Host-level grok_vision tool: registered once at startup, visible to EVERY
# session regardless of agent preset (including pre-existing sessions).
- insert:
    - id: dsh-grok-vision
      name: 'dsh-grok-vision'
      config:
        grokBin: !!js process.env.GROK_BIN || 'grok'
"""
    if "[]" in text:
        text = text.replace("[]", entry, 1)
    else:
        text = text.rstrip() + "\n" + entry
    open(path, "w").write(text)
    print("    已写入宿主行")
PYEOF

echo "完成。重启 DSH 后，所有会话（含旧会话、任意预设）自动获得 grok_vision。"
