# standard-grok

DeepSeek Harness（DSH）的 agent preset：**标准模式 + 本地 Grok 多模态读图**。

在 `standard` 预设的全部能力之上，注册 `grok_vision` 工具：当会话需要多模态能力（截图、图表、UI、照片）而主模型不支持视觉输入时，Agent 读取本地图片交给 Grok CLI 分析，返回文本结果。

## 目录结构

```
agent.cordis.yml                    # preset 组成：standard 全量 + tool-grok-vision 行
preset.yml                          # 显示名与描述
packages/dsh-tool-grok-vision/      # 插件包（npm 名 dsh-grok-vision）：注册 grok_vision 工具
  lib/index.js
  package.json
install.sh                          # 一键安装到本机 DSH
```

## 工作原理

- preset 行 `name: 'dsh-grok-vision'` 从 DSH 宿主 profile 的模块基址解析（web profile 的 node_modules 链），所以插件包只需作为 profile 的 `file:` 依赖安装一次。
- preset 在每次会话创建时挂载：安装或修改后**新会话立即生效，无需重启宿主进程**。
- 插件只注册进宿主的 `tools` 注册表，不发布任何 Service，因此 preset 内无需 isolate realm。

## 安装

前置条件：已安装 DSH 与 Grok CLI（`grok` 在 PATH 中或通过 `GROK_BIN` 指定），Grok CLI 已登录（`~/.grok/auth.json`）。

```bash
git clone <仓库地址> ~/tcode/github/standard-grok
cd standard-grok
./install.sh
```

`install.sh` 做三件事：

1. 将 preset 文件**复制**到 `~/.dsh/.agent-presets/standard-grok`（DSH 的预设扫描不跟随软链，必须是真实目录）
2. 将 `packages/dsh-tool-grok-vision` 登记为 web profile 的 `file:` 依赖并执行 `pnpm install`
3. 检查 `~/.dsh/settings.yaml` 的默认预设，若未设置则设为 `standard-grok`（也可在 Web 设置里手动选择）

脚本幂等：修改本仓库后重跑 `./install.sh` 即可完成同步（插件包为 hardlink 安装，改动即时生效；preset 文件以复制方式部署，需重跑同步）。

## 使用

新建会话后自动获得 `grok_vision`。Agent 需要看图时调用：

- `images`：本地图片绝对路径数组（PNG / JPEG / WebP / GIF）
- `prompt`：分析要求（要提取、回答或判断什么）

## 配置

`agent.cordis.yml` 中 `tool-grok-vision` 行的 `config`：

| 项 | 默认 | 说明 |
| --- | --- | --- |
| `grokBin` | `process.env.GROK_BIN \|\| 'grok'` | 本地 Grok 可执行文件 |
| `timeoutMs` | `120000` | 单次调用预算 |
| `maxImageBytes` | `8388608`（8 MiB） | 单图大小上限 |
| `maxImages` | `4` | 单次图片数上限 |

## 注意事项

- 每次调用消耗 x.ai 配额（小图约 $0.06 / 12 秒）。
- 插件包内的 peer 依赖（`@deepseek-ai/dsh-tools` 等）由 DSH 安装自带的扁平模块目录解析，仓库无需携带。
- 升级 DSH 后无需重装：preset 与插件包均位于 DSH 安装之外。
