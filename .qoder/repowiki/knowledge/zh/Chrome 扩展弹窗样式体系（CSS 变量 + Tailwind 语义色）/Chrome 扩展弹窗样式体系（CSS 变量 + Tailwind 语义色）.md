---
kind: frontend_style
name: Chrome 扩展弹窗样式体系（CSS 变量 + Tailwind 语义色）
category: frontend_style
scope:
    - '**'
source_files:
    - extension/popup.css
    - extension/popup.html
    - extension/manifest.json
    - extension/content.js
---

本仓库的前端样式仅存在于 Chrome 扩展 `extension/` 目录中，采用「原生 CSS + CSS 自定义属性」的轻量方案，未引入任何 UI 框架或构建工具。

1. 样式系统与方法论
- 使用 `:root` 集中声明设计令牌（design tokens），包括颜色、阴影、圆角等，命名遵循 BEM 风格前缀（如 `--primary`、`--shadow-md`、`--radius-sm`）。
- 颜色体系直接映射到 Tailwind CSS v3 的语义色值（indigo/slate/emerald/amber/red/purple/blue），便于与 Tailwind 生态保持一致。
- 布局以 Flexbox 和 CSS Grid 为主：顶部栏用 flex，日历网格用 `grid-template-columns: repeat(7, 1fr)` 实现 7 列周历。
- 组件化通过类名组合实现（`.cal-day.normal`、`.cal-day.abnormal`、`.cal-day.leave`、`.cal-day.overtime`），状态由语义化 class 切换。

2. 关键文件
- `extension/popup.css`：全部样式定义，包含主题变量、全局 reset、弹窗外壳、统计面板、日历网格及日期单元格样式。
- `extension/popup.html`：弹窗 HTML 结构，引用 popup.css 与 popup.js。
- `extension/manifest.json`：声明 MV3 扩展入口，popup 页面为 `popup.html`。
- `extension/content.js`：注入云创考勤页面的内容脚本，负责在目标页面上渲染数据（样式复用 popup.css 中的同名类）。

3. 架构约定
- 无 SCSS/Less/Tailwind 编译链，纯静态 CSS 随扩展分发。
- 固定弹窗尺寸（480×500px），不处理响应式断点，针对桌面浏览器扩展场景。
- 所有视觉差异通过 CSS 变量 + 语义化 class 控制，避免硬编码颜色。
- 交互反馈统一使用 `transform: scale()` + `transition: all 0.15s ease` 的微动效。