# dsh-grok-vision

DeepSeek Harness（DSH）**宿主级**插件：注册 `grok_vision` 工具，通过本地 Grok CLI 提供多模态图像理解。

挂在宿主层，**所有会话**（含重启前创建的旧会话、任意预设的会话）自动可用，无需任何预设配置。

## 目录结构

```
packages/dsh-grok-vision/       # 插件包（npm 名 dsh-grok-vision）
  lib/runtime.js                # 注册 grok_vision 工具
  package.json
install.sh                      # 一键安装（宿主行 + profile 依赖）
```

## 工作原理

- `install.sh` 在 web profile 的 `cordis.patch.yml` 写入一行宿主条目（模块名 `dsh-grok-vision`），并把插件包登记为 profile 的 `file:` 依赖。
- DSH 启动时读取宿主行 → 在全局 `tools` 注册表注册 `grok_vision` → 所有会话可见。
- 插件不发布任何 Service，宿主行无需 isolate realm。

## 安装

前置条件：已安装 DSH 与 Grok CLI（`grok` 在 PATH 中或通过 `GROK_BIN` 指定），Grok CLI 已登录（`~/.grok/auth.json`）。

```bash
git clone <仓库地址> ~/tcode/github/dsh-grok-vision
cd dsh-grok-vision
./install.sh
# 重启 DSH 宿主进程（宿主层行只在启动时读取）
```

升级 DSH 不会清除安装：宿主行在 `~/.dsh/profiles/web/cordis.patch.yml`，插件包在仓库内，均位于安装目录之外。

## 使用

Agent 需要看图时自动调用 `grok_vision`，图片来源有三种：

- `images`：本地图片路径（绝对路径或相对会话工作区，PNG / JPEG / WebP / GIF）
- `images: ["clipboard"]`：读取 macOS 剪贴板中的图片（复制一张截图后说"看看我剪贴板里的图"）
- `images: ["screen"]`：截取当前显示器画面（说"看看我的屏幕"）
- `prompt`：分析要求

### 生图（grok_generate_image）

- `prompt`：内容描述
- `style`（可选）：`cover`（文章封面）/ `infographic`（信息图）/ `comic`（知识漫画）/ `xhs`（小红书卡片）——工具自动附上对应风格规范；或先加载同名 `baoyu-*` skill 自己写完整风格 prompt
- `aspect_ratio`：1:1 / 16:9 / 3:4 / 9:16 等；`resolution`：1k / 2k；`n`：1-4 张
- `output`（可选）：输出路径，缺省存到 `outputDir`
- 生图走 x.ai images/generations（`grok-imagine-image`），认证复用本机 grok 登录态（或配置 `xaiApiKey`）
- **Prompt 记录**（baoyu 可复现约定）：每次生成都会在图片旁保存同名 `.md`，含时间戳、模型、比例、分辨率、输出路径与完整最终 prompt，便于审计与重放

四个风格 skill（`baoyu-cover-image` / `baoyu-infographic` / `baoyu-comic` / `baoyu-xhs-images`）随插件注册为运行时 skill，模型可加载获得完整风格规范。

## 配置

`cordis.patch.yml` 宿主行的 `config`：

| 项 | 默认 | 说明 |
| --- | --- | --- |
| `grokBin` | `process.env.GROK_BIN \|\| 'grok'` | 本地 Grok 可执行文件 |
| `timeoutMs` | `120000` | 读图调用预算 |
| `maxImageBytes` | `8388608`（8 MiB） | 单图大小上限 |
| `maxImages` | `4` | 单次图片数上限 |
| `imageModel` | `grok-imagine-image` | 生图模型 |
| `imageTimeoutMs` | `180000` | 生图调用预算 |
| `outputDir` | `/tmp/dsh-grok-images` | 生成图片缺省输出目录 |
| `savePrompt` | `true` | 是否在图片旁保存 `.md` prompt 记录 |
| `xaiApiKey` | 空（用 grok 登录态） | 显式 xAI API Key |

## 代码更新

宿主进程会缓存裸包名的解析结果与模块实例。修改本包代码后二选一：

1. **重启宿主一次**（最简单）；
2. 把宿主行的 `name` 临时指向 `dsh-grok-vision/runtime` 子路径（新 specifier，免重启）。

## 注意事项

- 每次调用消耗 x.ai 配额（小图约 $0.06 / 12 秒）。
- 插件包内的 peer 依赖（`@deepseek-ai/dsh-tools` 等）由 DSH 安装自带的扁平模块目录解析，仓库无需携带。
