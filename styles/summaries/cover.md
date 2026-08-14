# 封面图风格规范（baoyu-cover-image 摘要）

文章/公众号封面图。生成时从五个维度组合，并在 prompt 中明确写出所选维度。

## 五维度

1. **Type 构图**：hero（大视觉主体占 60-70%）、conceptual（抽象形状分区）、typography（标题为主 40%+）、metaphor（具体物隐喻抽象概念）、scene（氛围场景）、minimal（单一焦点 + 60% 留白）
2. **Palette 配色**（示例）：cool 工程蓝 #2563EB/#1E3A5F/#06B6D4 + 灰底 #F8F9FA + 琥珀点缀；warm 暖色；dark 暗色高级感；macaron 马卡龙柔和；vivid 高饱和；elegant 雅致低饱和。选一套并在 prompt 中写明主色/底色/点缀色的 hex 或色名
3. **Rendering 渲染**：flat 扁平矢量、gradient 渐变、3d 立体、isometric 等轴测、hand-drawn 手绘、watercolor 水彩、photoreal 写实、minimalist 极简线条。写明线条质感（干净/速写/笔刷）与深度（扁平/软边）
4. **Text 文字密度**：none / title-only（单标题 85% 画面）/ title-subtitle（标题+副题 75%）/ text-rich（标题+副题+2-4 标签 60%）。标题必须忠实原文，不得杜撰
5. **Mood 氛围**：subtle（低对比低饱和宁静）、balanced（均衡）、bold（高对比高饱和冲击）

## 核心原则

- 大量留白，突出核心信息，避免拥挤
- 主视觉居中或偏左（右侧留给标题区）
- 人物只用简化剪影，不用写实人脸
- 用简洁可辨识的图标表达概念
- 不渲染色号/角色标签等元文字

## Prompt 模板

"Create an article cover image. Type: <构图>; Palette: <配色名，列出主色 hex>; Rendering: <渲染风格>; Text: <文字密度，标题为「...」>; Mood: <氛围>; Aspect ratio: <比例>. Content: <主题内容>. Ample whitespace, simplified silhouettes, no realistic faces, no meta text."
