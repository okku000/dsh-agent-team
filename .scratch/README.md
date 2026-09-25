# 工作资料目录索引

`.scratch/` 保存跨会话工作项的设计快照、研究、实施 tickets、原型和可复查的里程碑证据。它不定义当前产品行为、公开 API、稳定维护流程或架构边界；这些以 `packages/`、测试、package README 和 `../docs/` 为准。

**怎么在这里工作（工作项结构、ticket 骨架、Team 流程对接、生命周期）见 [AGENTS.md](AGENTS.md)。**

## 目录

```text
.scratch/
├── active/                 # 尚未结束的工作项
├── archive/YYYY-MM/<work>/ # 已完成工作项的历史资料
└── local/                  # Git 忽略的私人草稿和临时输出
```

## 当前工作项入口

本节只列尚未结束的工作项；已结束的见 `archive/YYYY-MM/`。

进行中一项：[从 Team GUI 创建 routine](active/gui-routines/README.md)（2026-09-25：store 与引擎的两种 action 已落地，Remote CRUD 与设置区界面待做）。

已归档的四项（2026-09）：[Routines 与 producer 触发的唤醒](archive/2026-09/routines-and-wakes/README.md)（2026-09-25 归档：Team 自带的 routine producer 落地并在探针机上完成一次真实发火）、[0.1.7 UI 设计语言再基线](archive/2026-09/ui-parity-0.1.7/README.md)（task:d3ec167b，2026-09-24 归档）、[Member Session 架构](archive/2026-09/member-session-architecture/README.md)、[Context continuity](archive/2026-09/context-continuity/README.md)。

## 临时材料和 UI 证据

`.scratch/local/`、`artifacts/` 和 `artifacts/browser/` 被 Git 忽略。临时日志、agent handoff、下载物、调试截图和日常 browser test 输出放在那里，不进入归档。

UI 改动需要真实浏览器自检时，`npm run test:browser` 会把本次截图写入 `artifacts/browser/`。它们用于审查本次改动，不是自动视觉回归基线，也不会改动 Git 工作区。只有人工确认能说明已完成工作项验收结论的少量代表图，才复制进对应归档的 `archive/YYYY-MM/<work>/validation/`；每张图都必须在同目录 README 中说明证明的验收点和复跑命令。一个浏览器 journey 跨多个 UI ticket 时，可以像本仓库一样集中保存。

详细 UI 改动检查和证据选择规则见 [`../docs/development/generated-and-seams.zh.md`](../docs/development/generated-and-seams.zh.md)。
