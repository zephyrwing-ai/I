# Agent Studio 设计文档索引

`DESIGN.md` 曾经同时包含产品结构、交互、视觉和工程架构，容易造成内容重复。自 v0.3 起，按设计产物拆分为：

- [产品结构](./product-structure/index.mdx)：软件包含的页面、区块、内容和能力清单。
- [交互逻辑](./interaction/index.mdx)：用户动作、系统响应、状态变化和错误恢复。
- [视觉设计](../design/README.md)：颜色、字体、图标、尺寸、组件视觉状态和动效 token。
- [工程架构](./ENGINEERING-ARCHITECTURE.md)：Renderer、IPC、Agent Runtime、Provider、Execution 的实现契约。

当前唯一有效的设计基线是以上四类文档的合并约束；若文档之间出现冲突，先修正产品结构，再同步交互、视觉和工程契约，不在原型代码中自行猜测。
