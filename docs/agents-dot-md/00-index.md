# docs/agents-dot-md 模块索引

> AGENTS.md 的细化模块目录（不会被 Claude Code 自动加载，按需查阅）。本文件由 agents-dot-md skill 的 `reindex.py` 生成，勿手工编辑。

- [系统架构](architecture.md) — 双向桥接、独立 herdr 通道及模块职责与依赖边界。
- [代码 checklist（强制自检）](code-checklist.md) — 写代码前定位专题约束，完成后逐项核对改动与验证证据。
- [编码与改动规范](coding-guidelines.md) — 局部改动、异步边界、纯函数与结构化输入的实现约定。
- [配置与运行环境](environment.md) — 分层配置、凭据优先级、配置错误处理与真实飞书冒烟入口。
- [日志、网关与 SDK 契约](gateway-sdk.md) — TUI 日志保护、出站异常兜底、参数转发与累计流式输出。
- [herdr 派活与结果回收](herdr.md) — 独立后台 watch、真实活动门、会话文件收获与关闭清理。
- [消息路由与回合生命周期](routing-lifecycle.md) — 普通消息延迟、投递占位、来源认领、自主回合与话题路由的硬性契约。
- [安全与审批](security.md) — 风险三档、外发准入、herdr 控制工具及卡片点击鉴权。
- [技术栈与实现约定](tech-stack.md) — Node 原生类型剥离、TypeScript ESM、依赖与验证命令。
- [测试与实机验证](testing.md) — TDD、手写替身、真 SDK 契约测试、herdr 隔离验收及 pi 重启要求。
- [语言约定](translation.md) — 交流、测试名称及代码注释沿用本仓库的中文风格。
