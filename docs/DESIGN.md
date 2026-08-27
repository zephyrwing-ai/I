# Agent Studio 设计文档索引

`DESIGN.md` 曾经同时包含产品范围、UX/UI 和工程架构，容易造成职责混淆。自 v0.2 起，按责任边界拆分为：

- [产品行为规格](./product-behavior/index.mdx)：PM 定义的产品范围、规则和成功条件。
- [UX 设计](./UX-DESIGN.md)：信息架构、流程、状态、交互、搜索、错误恢复、响应式和无障碍。
- [UI 设计](./UI-DESIGN.md)：颜色、字体、图标、尺寸、组件视觉状态和动效。
- [工程架构](./ENGINEERING-ARCHITECTURE.md)：Renderer、IPC、Agent Runtime、Provider、Execution 的实现契约。

当前唯一有效的设计基线是以上四类文档的合并约束；若文档之间出现冲突，先修正 PM 范围，再同步 UX/UI 和工程契约，不在原型代码中自行猜测。
