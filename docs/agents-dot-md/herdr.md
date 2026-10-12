# herdr 派活与结果回收
> 独立后台 watch、真实活动门、会话文件收获与关闭清理。

## 目标与启动目录

所有工具的 `target` 必须原样复制 `herdr_list_agents` 输出的 `target` 值：优先注册的 agent 名，没有名称时用 pane id（例如 `w2:p3`）。工作区 label（例如 `aiclass`）、目录名和终端标题不是 agent 名；不能解析标题猜目标，也不能在 NOT_FOUND 后自动创建 agent。

默认复用已有 agent；模型先列出并按任务、目录和空闲状态选择，只有用户明确要求新建时才能调用 `herdr_start_agent`。工具通过 `promptGuidelines` 把这项约束加入系统提示；`/herdr new` 是用户显式创建入口。服务未选目标时也只选已有空闲、就绪且没有 watch 的 agent，没找到就报错，不隐式创建。

`startAgent` 始终显式传 `--cwd`：用户给了目录就用该目录，未给则使用 `homedir()`。`~` / `~/...` 在客户端展开，因为 CLI `shell:false` 不会展开它；split 和 workspace 两条分支都不能继承当前 cwd。

## herdr 派活不经过 pi —— 经了就谈不上并行
`/herdr` 在入站 handler 里本地处理（与 `/feishu` 同级），**不交给 `pi.sendUserMessage`**。
理由与本扩展的主线约束是同一个：`agent_start` 一次运行只发一次，飞书只有一条流，
而 pi 会把排队消息并进同一个运行 —— 多个任务只能串行，还得在同一张卡片里抢行。
所以每个任务在 `herdr-service.ts` 里各自登记一个 watch、各自一个后台 Promise，
结果各自按 `SendTarget` 回原对话。同一个 herdr 目标上只允许一个 watch：它是一块
终端面板，两句话同时塞进去会在里面打架。

派活和等待各自独立运行；`watch` 落地时飞书那边可能正在跑别的回合。生产接线将完成结果通过 `onComplete` 排入 Bridge 的总结队列，等 pi 空闲后独立总结，再回原对话/话题。派活回执仍直接 `gw.sendText`，显式 `/herdr read` 仍按读输出命令处理。独立客户端未提供总结回调时保留正文回传能力。
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
