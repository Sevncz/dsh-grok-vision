# dsh-grok-vision

DeepSeek Harness（DSH）**宿主级**插件：注册 `grok_vision` 工具，通过本地 Grok CLI 提供多模态图像理解。

挂在宿主层，**所有会话**（含重启前创建的旧会话、任意预设的会话）自动可用，无需任何预设配置。

## 目录结构

```
packages/dsh-grok-vision/       # DSH 组合包（npm 名 dsh-grok-vision）
  lib/runtime.js                # 注册 grok_vision / grok_generate_image
  styles/                       # baoyu 风格 skill 与 style= 摘要
  cordis.patch.yml              # 组合包配置层（insert 本插件行）
  package.json                  # 声明 dsh.bundle.patch
install.sh                      # dsh plugin add + 宿主 peer 扁平链接
```

## 工作原理

这是一个标准 DSH **组合包**（见官方 [打包与安装插件](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/publish.zh.md)）：

- `package.json` 声明 `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`
- `dsh plugin --profile web add ./packages/dsh-grok-vision` 会 `link:` 本 checkout，并把包名追加进 `dsh.profile.bundles`
- `link:` 让 Node 从本仓库 realpath 解析模块，走不到 `$DSH_HOME/profiles/node_modules`；`install.sh` 会按 dsh 同样的扁平 symlink，把宿主 peer（schemastery / dsh-tools / cordis / dsh-system-prompt）链进本包 `node_modules`，**不要** `pnpm add` 这些 peer
- 启动时按 bundles 顺序叠加各组合包 patch，再叠加用户自己的 `cordis.patch.yml`
- 本包的 patch 插入一行宿主插件，在全局 `tools` 注册 `grok_vision` / `grok_generate_image`，所有会话可见
- 不要手改用户 profile 的 `cordis.patch.yml` 来插入本插件；用户层只用来按 `id` 覆盖配置

## 安装

前置条件：已安装 DSH 与 Grok CLI（`grok` 在 PATH 中或通过 `GROK_BIN` 指定），Grok CLI 已登录（`~/.grok/auth.json`）。

```bash
git clone <仓库地址> ~/tcode/github/dsh-grok-vision
cd dsh-grok-vision
./install.sh
# 即：dsh plugin --profile web add ./packages/dsh-grok-vision
#     再 node packages/dsh-grok-vision/scripts/link-host-peers.mjs
# 重启 DSH：npx @deepseek-ai/dsh web
# 可用 dsh --profile web --dump-config 确认存在 "# == dsh-grok-vision" 层
```

升级 DSH 不会清除安装：组合包层在 profile 的 `dsh.profile.bundles` 里，源码在本仓库。

> `pnpm add` 时若看到 "WARN Issues with peer dependencies found"（cordis、dsh-tools 等宿主 peer 缺失），属预期。由 `link-host-peers.mjs` 链到 `$DSH_HOME/profiles/node_modules` 里 dsh 已愈合的那一份。**不要**按提示把这些 peer 装进本仓库。

## 使用

Agent 需要看图时自动调用 `grok_vision`，图片来源有三种：

- `images`：本地图片路径（绝对路径或相对会话工作区，且必须落在工作区内；PNG / JPEG / WebP / GIF）
- `images: ["clipboard"]`：读取 macOS 剪贴板中的图片（复制一张截图后说"看看我剪贴板里的图"）
- `images: ["screen"]`：截取当前 macOS 显示器画面（说"看看我的屏幕"）
- `prompt`：分析要求

### 生图（grok_generate_image）

- `prompt`：内容描述
- `style`（可选）：`cover`（文章封面）/ `infographic`（信息图）/ `comic`（知识漫画）/ `xhs`（小红书卡片）——工具自动附上对应风格规范；或先加载同名 `baoyu-*` skill 自己写完整风格 prompt
- `aspect_ratio`：`auto` / `1:1` / `16:9` / `3:4` / `2.35:1` 或任意 `W:H`；`resolution`：1k / 2k；`n`：1-4 张
- `ref`（可选）：最多 3 张工作区内参考图；有 `ref` 时走 x.ai `/v1/images/edits`，否则走 `/v1/images/generations`
- `output`（可选）：输出路径（相对会话工作区），缺省存到 `outputDir`；父目录由工具创建
- 认证优先 `xaiApiKey` / `XAI_API_KEY`，否则复用本机 grok 登录态（过期会明确要求 `grok login`）
- **Prompt 记录**（baoyu 可复现约定）：每次生成都会在图片旁保存同名 `.md`，含时间戳、模型、比例、分辨率、输出路径与完整最终 prompt，便于审计与重放

四个风格 skill（`baoyu-cover-image` / `baoyu-infographic` / `baoyu-comic` / `baoyu-xhs-images`）随插件注册为运行时 skill，模型可加载获得完整风格规范。

## 配置

组合包自带的 `cordis.patch.yml` 写入默认 `config`。用户要改某项，在 **profile** 的 `~/.dsh/profiles/web/cordis.patch.yml` 按 `id` 覆盖整行（DSH patch 替换整块 config，不是深合并）：

| 项 | 默认 | 说明 |
| --- | --- | --- |
| `grokBin` | `process.env.GROK_BIN \|\| 'grok'` | 本地 Grok 可执行文件 |
| `timeoutMs` | `120000` | 读图调用预算（复杂分析建议 600000） |
| `maxImageBytes` | `8388608`（8 MiB） | 单图大小上限 |
| `maxImages` | `4` | 单次图片数上限 |
| `maxTurns` | `4` | 传给 grok CLI 的 `--max-turns`（`1` 时带图请求会偶发、`2` 时复杂分析请求会 `max turns reached`） |
| `imageModel` | `grok-imagine-image` | 生图模型 |
| `imageTimeoutMs` | `180000` | 生图调用预算 |
| `outputDir` | `/tmp/dsh-grok-images` | 生成图片缺省输出目录 |
| `savePrompt` | `true` | 是否在图片旁保存 `.md` prompt 记录 |
| `xaiApiKey` | 空（用 `XAI_API_KEY` 或 grok 登录态） | 显式 xAI API Key |

## 代码更新

宿主进程会缓存裸包名的解析结果与模块实例。修改本包代码后二选一：

1. **重启宿主一次**（最简单）；
2. 把宿主行的 `name` 临时指向 `dsh-grok-vision/runtime` 子路径（新 specifier，免重启）。

## 注意事项

- 每次调用消耗 x.ai 配额（小图约 $0.06 / 12 秒）。
- 插件包内的 peer 依赖（`@deepseek-ai/dsh-tools` 等）由 DSH 安装自带的扁平模块目录解析，仓库无需携带。
