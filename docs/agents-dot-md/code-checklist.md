# 代码 checklist（强制自检）
> 写代码前定位专题约束，完成后逐项核对改动与验证证据。

每次代码改动后逐项自检；专题文档是详细规则的唯一来源，下面的反例和正例用于定位检查点。

| 检查点 | 反例及后果 | 正例 / 详细规则 |
|---|---|---|
| 运行语法与类型 | 构造参数属性 / 无后缀 import，Node 无法原生执行 | 显式字段、`.ts`、`import type`；[tech-stack.md](tech-stack.md) |
| 日志与异步失败 | 裸 `console.error` 冲花 TUI，游离 Promise 逃进事件循环 | 项目 logger、明确错误出口；[gateway-sdk.md](gateway-sdk.md) |
| 扩展加载 | 工厂启动连接或 import 未声明的 typebox，加载即失败 | 纯注册、JSON Schema；[architecture.md](architecture.md)、[tech-stack.md](tech-stack.md) |
| 普通消息投递 | followUp 合并运行，消息没独立卡片 | 延迟队列、同步 reservation、watchdog；[routing-lifecycle.md](routing-lifecycle.md) |
| 回合来源与话题 | 最近消息全局变量 / 一律 replyTo，串会话或新开话题 | 原文认领、结构化来源、SendTarget；[routing-lifecycle.md](routing-lifecycle.md) |
| 网关参数与流 | 少形参静默丢目标，增量 append 吞字 | 参数转发与 cumulativeSink；[gateway-sdk.md](gateway-sdk.md) |
| 风险与审批 | 出错放行 / 外发或 herdr 控制工具漏分类 | fail-closed、三档风险清单；[security.md](security.md) |
| 卡片点击 | 只依赖 SDK 鉴权，群友能审批 | 操作者、逐卡会话及单会话绑定三层；[security.md](security.md) |
| herdr 并行与收获 | 发给 pi 排队 / 轮询旧 idle / 抓 TUI 当答案 | 独立 watch、prompt --wait、会话正文；[herdr.md](herdr.md) |
| 配置与秘密 | JSON 错误静默跳过 / 凭据入库 | 区分缺文件和坏配置；[environment.md](environment.md) |
| 验证证据 | 替身通过就认为 SDK 正确 / 未重启 pi 实测 | TDD、真链路验证与重启；[testing.md](testing.md) |

新增条目写清规则、反例及正例，链接到对应专题；沿用既有依赖与手写替身，不引入第二套同类方案。
