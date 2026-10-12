# 通用工具后台等待
> pi 1.0.2 公共执行点补丁、独立 watcher、原目标快照及取消与审批边界。

- `scripts/patch-pi-background.ts` 只在参数校验和审批之后的 `executePreparedToolCall` 执行点加全局 hook，覆盖核心模块和实际 CLI bundle；不匹配版本/结构即拒绝，保存备份，可检查及回滚。安装/升级后重新应用，运行中的 pi 必须重启。
- 未安装 hook 或无飞书目标时沿用原同步执行；日志明确报告缺失补丁，不能声称后台已经启用。
- `BackgroundTools.run` 在 `toolWaitMs`（默认 10 秒）内保持原返回/异常，超过只返回后台登记回执，实际执行由独立 AbortController 和 watcher 继续等待。绝不把等待期限当执行超时，也不能重复执行工具。
- 目标在调用时复制为 `SendTarget`，后续消息、回合结束和新回合不能改道。完成通知通过 `onComplete` 交给 Bridge 排入总结队列，绝不直接发原始结果。复用当前 pi 模型独立开回合总结，再通过正常流式链路回原对话/话题；忙时等 `agent_settled`，不发 followUp 合并运行。内部总结资料最多保留头尾共 24000 字符并标注截断。
- 父工具调用子工具时（pi 的 `parent/序号` id），子结果必须完整返回给父工具，不能替换成后台回执。后台子调用审批用父任务目标，不能继承/修改新回合的整轮授权，事件不能污染新回合的卡片。
- 新回合取消不取消已脱离的工具；桥接 shutdown 给全部任务发取消信号并抑制晚到结果，不等待忽略 abort 的第三方工具。gateway 发送失败由 watcher 兜住，日志走项目 logger。
- 16 个同时管理的工具上限；执行依赖结果的后续步骤应等完成消息，回执不是成功正文。

验证使用 `background-tools.test.ts` 的取消/来源/嵌套/失败测试，以及 `pi-background-contract.test.ts` 对真实 pi 核心和原生 bash 的执行测试；真实 CLI 另用无网络的合成 provider 验证 bundle 确实命中 hook。

## 总结与来源

- `background-summary.ts` 构造总结指令：正文先点明原请求，再提炼结论、关键事实和来源链接，如实说明失败/未完成，不展示原始日志、JSON 或内部调用编号，不重复执行工具。Bridge 用捕获的原始问题作为结果卡片抬头，多条任务分别保留，不能用工具名称替换用户问题。
- 在工具启动时复制原问题和 threadId；settled 会清掉原来源表，不能到完成时才回查它。
- `recordBackground` 给生成的 messageId 保存真实 `SendTarget`：它不是飞书消息，不能拿它当 replyTo。后台来源的捕获目标优先于后来的默认绑定，普通入站的单会话过滤行为保持不变。
- `enqueueBackgroundResult` 与普通消息共用有界 FIFO、同步 dispatch reservation 和 120 秒启动 watchdog；队列满或投递失败只发失败通知，不降级外发原始结果。
- `background-summary.test.ts` 验证独立总结、忙时队列、真实话题目标、改绑不串对话及超长/失败资料；真实 pi RPC 用合成 provider 验证完成后确实开启新回合。

## TUI 任务状态

- `background-status.ts` 的纯函数构造 footer 简短列表及输入框下方的完整 Background / Watcher 列表，区分执行中与交付总结，显示任务、目标和耗时；清除不可信正文中的 ANSI / 控制字符。
- 用 `ctx.ui.setStatus` + `setWidget(..., { placement: "belowEditor" })`，不接管 `setFooter`，保持 pi-usage 等 footer 扩展兼容。footer 有宽度截断，完整列表放 widget，不能只塞一条超长 status。
- manager 和 herdr service 提供只读 `watching()` 快照与 `onChange` 通知；同步短工具不入 background，完成/取消/停止立即更新并清除状态。
- `BackgroundTaskStatus` 构造不启动资源；只有 TUI 中存在活跃任务才每秒刷新耗时，清空或 dispose 就取消定时器。RPC/print/json 不注册刷新；惰性 UI getter 失效时不抛错、不裸写终端。
- `background-status.test.ts` 验证列表、阶段、耗时刷新、控制字符、headless 与销毁；真 pi TUI 在隔离 agent 目录和合成 provider 下验证 UI 实际显示及清空。
