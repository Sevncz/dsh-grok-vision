# 封面图风格规范（baoyu-cover-image 摘要）

文章/公众号封面图。生成时从五个维度组合，并在 prompt 中明确写出所选维度。

## 五维度

1. **Type 构图**：hero、conceptual、typography、metaphor、scene、minimal
2. **Palette 配色**：warm、elegant、cool、dark、earth、vivid、pastel、mono、retro、duotone、macaron。选一套并在 prompt 中写明主色/底色/点缀色
3. **Rendering 渲染**：flat-vector、hand-drawn、painterly、digital、pixel、chalk、screen-print
4. **Text 文字密度**：none / title-only / title-subtitle / text-rich。标题必须忠实原文，不得杜撰
5. **Mood 氛围**：subtle、balanced、bold

## 核心原则

- 大量留白，突出核心信息，避免拥挤
- 主视觉居中或偏左（右侧留给标题区）
- 人物只用简化剪影，不用写实人脸
- 用简洁可辨识的图标表达概念
- 不渲染色号/角色标签等元文字

## Prompt 模板

"Create an article cover image. Type: <构图>; Palette: <配色名，列出主色 hex>; Rendering: <渲染风格>; Text: <文字密度，标题为「...」>; Mood: <氛围>; Aspect ratio: <比例>. Content: <主题内容>. Ample whitespace, simplified silhouettes, no realistic faces, no meta text."
