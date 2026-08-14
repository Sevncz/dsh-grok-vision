# 信息图风格规范（baoyu-infographic 摘要）

专业信息图（infographic），把内容转成结构化视觉叙事。

## 布局（Layout，选一并在 prompt 写明）

bento-grid（便当盒网格）、comparison-matrix（对比矩阵）、binary-comparison（双栏对比）、funnel（漏斗）、hierarchical-layers（层级塔）、hub-spoke（枢纽辐射）、tree-branching（树状分支）、linear-progression（线性进程）、timeline（时间线）、iceberg（冰山）、dashboard（仪表盘）、comic-strip（连环画式）、periodic-table（周期表式）、story-mountain（故事山）

## 样式（Style，选一）

- flat-corporate：扁平商务，蓝灰主色，几何图标
- minimal：极简，大留白，细线条，黑白 + 单点缀色
- isometric：等轴测立体块，科技感
- hand-drawn：手绘线条 + 淡彩
- editorial：杂志编辑风，衬线标题 + 网格排版
- dashboard-dark：深色仪表盘，霓虹点缀

## 核心原则

- 信息层级清晰：主标题 > 分节 > 标签 > 数据
- 关键数字放大展示（数据可视化：条形/圆环/大数字）
- 每区块信息精炼（一句核心 + 3-5 关键词）
- 图标 + 短标签，不写长段落
- 留白充足，区块分明
- 文字按用户语言；标题醒目可读
- 不渲染元文字（色号、说明标签）

## Prompt 模板

"Create a professional infographic. Layout: <布局>; Style: <样式>; Aspect ratio: <比例>; Language: <语言>. Content structure: <分节标题与要点>. Emphasize key numbers with charts, use icons + short labels, clear hierarchy, ample whitespace."
