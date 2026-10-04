# 系统架构
> 双向桥接、独立 herdr 通道及模块职责与依赖边界。

一个 pi 扩展（`@earendil-works/pi-coding-agent`），把当前 pi 会话双向桥接到飞书：
终端开的会话，手机上接着看、接着聊，危险工具调用在飞书弹卡片审批。

`package.json` 里的 `pi.extensions: ["./extensions"]` 是 pi 的加载入口，
`extensions/feishu/index.ts` 的 default export 就是扩展工厂函数。

## 组件与调用方向
数据是**双向**流动的，两条链路各走各的：

```
飞书消息 ──► FeishuGateway.onMessage ──► index.ts ──► pi.sendUserMessage
                                                            │
pi 事件 (agent_start / message_update / tool_execution_*) ──►│
                     │                                       ▼
                     └──► Bridge ──► renderer(纯函数) ──► TurnStream ──► 飞书流式卡片
```

另有一条**不经过 pi** 的旁路，`/herdr` 命令走它（并行派活）：

```
飞书 /herdr … ──► index.ts ──► HerdrService ──► extensions/herdr ──► herdr CLI ──► 别的 agent
                     │              │                                             面板
                     │              └── 后台 watch（每任务一个，互不排队）──────────┘
                     └──► 结果直接 gw.sendText 回原对话
```

| 模块 | 职责 |
|---|---|
| `index.ts` | **只做接线**。注册 `pi.on(...)` 与 `/feishu` 命令，持有 gateway/bridge 的生命周期。工厂函数里绝不启动后台资源，只声明 |
| `bridge.ts` | 编排层。回合状态机（`startTurn`/`endTurn`）、工具调用闸门（`gateToolCall`）、入站消息转 prompt |
| `feishu.ts` | 飞书网关（direct 档）。包住 `createLarkChannel`，收敛 SDK 的事件与出站 API |
| `inbound.ts` | SDK 消息 → `InboundMessage` 的映射，以及会话名称缓存 |
| `gate.ts` | 入站放行判定（`gateInbound`）。无依赖，bridge 与 renderer 共用同一份状态机 |
| `deferred.ts` | 回合进行中的普通消息要扣住，等这轮跑完再单独成回合。详见对应专题模块 |
| `origin-registry.ts` | 消息级来源登记表：`messageId → chatId`，按原文认领回合来源，工具调用绑消息 |
| `agent-origin.ts` | 子 agent 来源登记表：`session 名 → 派活那个对话`。pi-asd watcher 推起来的自主回合靠它路由，详见对应专题模块 |
| `image.ts` | 发图的准入判定：目录白名单（按 realpath）+ 魔数识别。纯函数，不碰文件系统 |
| `risk.ts` | 安全判定。三档模型，详详见对应专题模块 |
| `approval.ts` | 多通道审批竞速（飞书卡片 vs 终端对话框），先到先得 |
| `approval-card.ts` | 卡片构造/解析 + 未决审批登记表 |
| `turn-stream.ts` | 推拉流适配器。Bridge 往里 push，SDK 的 stream 回调从里 pull |
| `renderer.ts` | 纯函数：pi 事件 → markdown。无状态、无 IO |
| `config.ts` | 配置合并与校验 |
| `dispatch-watchdog.ts` | 投递后未启动的超时恢复，防止 reservation 永久占位 |
| `pairing.ts` | 配对码和绑定状态 |
| `reaction.ts` | 入站表情回执的去重与生命周期 |
| `log.ts` | 日志出口。**唯一允许写终端的地方** |
| `herdr-commands.ts` | `/herdr` 命令的解析与渲染。纯函数，无 IO |
| `herdr-service.ts` | herdr 派活编排：会话选择、watch 登记、结果回飞书。详见对应专题模块 |

另一个目录 `extensions/herdr/` 是**独立于飞书的 herdr 客户端**（无 pi、无飞书依赖，可离线测）：

| 模块 | 职责 |
|---|---|
| `types.ts` | `Result<T>` / 错误码 / `HerdrAgent` 与 snake_case 归一化 |
| `cli.ts` | 唯一的 `herdr <argv>` 出口：`spawn`（`shell:false`）、超时/abort、JSON 信封 → `Result<T>` |
| `agents.ts` | 高层操作：list/get/start/prompt/wait/read/send-keys/stop。`agent start` 的分支（split vs workspace）在此 |
| `watch.ts` | 派活 + watch：`promptAndWatch` / `watchUntilSettled`。可注入时钟与 sleep |
| `harvest.ts` | 取结果：pi 会话文件抽最后一条 assistant，否则退面板输出 |
| `index.ts` | pi 工具层（`herdr_*`），薄封装，供终端会话里的模型调用 |

## 模块依赖边界

- `index.ts` 只做注册、接线与生命周期管理；工厂调用阶段只声明，不启动连接、进程或 watcher。
- `renderer.ts`、`gate.ts`、`image.ts`、`herdr-commands.ts` 保持纯函数，IO 留在网关或编排层。
- `extensions/herdr/` 的客户端层不依赖 pi 或飞书；只有 `index.ts` 工具入口依赖 pi。
- 消息投递与回合来源读 [routing-lifecycle.md](routing-lifecycle.md)，SDK 出站读 [gateway-sdk.md](gateway-sdk.md)，安全策略读 [security.md](security.md)，派活读 [herdr.md](herdr.md)。
