# herdr 派活与结果回收
> 独立后台 watch、真实活动门、会话文件收获与关闭清理。

## herdr 派活不经过 pi —— 经了就谈不上并行
`/herdr` 在入站 handler 里本地处理（与 `/feishu` 同级），**不交给 `pi.sendUserMessage`**。
理由与本扩展的主线约束是同一个：`agent_start` 一次运行只发一次，飞书只有一条流，
而 pi 会把排队消息并进同一个运行 —— 多个任务只能串行，还得在同一张卡片里抢行。
所以每个任务在 `herdr-service.ts` 里各自登记一个 watch、各自一个后台 Promise，
结果各自按 `SendTarget` 回原对话。同一个 herdr 目标上只允许一个 watch：它是一块
终端面板，两句话同时塞进去会在里面打架。

结果是**异步推送**的，与回合无关：`watch` 落地时飞书那边可能正在跑别的回合，
这条消息走 `gw.sendText(target, ...)`，与 `/feishu` 回执同一条路，不碰 `Bridge` 的流。
飞书一停（`stop()`）就必须 `herdrService.shutdown()`：abort 掉在等的 herdr 子进程，
不然它们会在没有收件方的情况下白等，更坏的是发出异常。

## herdr 的 `agent prompt --wait` 不能拿轮询代替
「任务快到两次轮询之间就跑完」是个真坑：客户端轮询 `agent get` 会看到 agent 还是
idle（还没开始），把上一条的旧状态当成结果。这是错判为完成，比超时坏得多。

`agent prompt --wait --until idle --until done --until blocked` 把提交、活动门、
落地等待合成一个调用，herdr 自己保证从非工作态发出的 prompt 必须观测到
working/blocked 活动。`watch.ts` 只在它返回 TIMEOUT（agent 还在跑）时
才接上分片 `agent wait` + `agent get` 轮询；返回 `agent_prompt_stalled` 且状态序号不动时
报 `stalled`，**绝不谎报完成**。

结果正文优先从 pi 的**会话文件**里抽（`harvest.ts` 的 `extractPiAnswer`）：herdr 的
`agent_session.kind === "path"` 就是 pi 的会话 jsonl，最后一条 assistant 回复
就是答案。面板输出（`agent read`）混着 TUI 边框与状态页脚，只能做兼容退路。

修改客户端链路的验证要求见 [testing.md](testing.md)；访问控制见 [security.md](security.md)。
