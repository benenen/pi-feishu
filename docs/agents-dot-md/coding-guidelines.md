# 编码与改动规范
> 局部改动、异步边界、纯函数与结构化输入的实现约定。

- 沿用模块现有风格，只修改任务涉及的行为；编排留在 Bridge / Service，入口留接线。
- 异步操作显式 await、return 或 catch；后台 watcher 各自持有 abort 与错误出口。需要顺序的队列和 SDK 流保持顺序，独立任务才并行。
- 边界输入用 `unknown` 与类型守卫收窄，错误保留上下文和 cause，并走项目日志出口。
- 保持 TypeScript strict；断言须有明确依据。注册工具的 JSON Schema `as never` 是已验证的 API 适配例外，见 [tech-stack.md](tech-stack.md)。
- 代码前后按 [code-checklist.md](code-checklist.md) 自检，验证遵循 [testing.md](testing.md)。
