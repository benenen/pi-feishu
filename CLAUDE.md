# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 命令

```bash
npm test                              # 全量，node:test
node --test "test/risk.test.ts"       # 单个测试文件
node --test --test-name-pattern "管道" # 按名字筛
npm run typecheck                     # tsc --noEmit
```

Node ≥ 24。**没有构建步骤** —— 依赖 Node 原生的类型剥离（type stripping）直接跑 `.ts`。

无 lint / formatter，提交前跑 `npm test` + `npm run typecheck` 即可。

## 这是什么

一个 pi 扩展（`@earendil-works/pi-coding-agent`），把当前 pi 会话双向桥接到飞书：
终端开的会话，手机上接着看、接着聊，危险工具调用在飞书弹卡片审批。

`package.json` 里的 `pi.extensions: ["./extensions"]` 是 pi 的加载入口，
`extensions/feishu/index.ts` 的 default export 就是扩展工厂函数。

## 架构

数据是**双向**流动的，两条链路各走各的：

```
飞书消息 ──► FeishuGateway.onMessage ──► index.ts ──► pi.sendUserMessage
                                                            │
pi 事件 (agent_start / message_update / tool_execution_*) ──►│
                     │                                       ▼
                     └──► Bridge ──► renderer(纯函数) ──► TurnStream ──► 飞书流式卡片
```

| 模块 | 职责 |
|---|---|
| `index.ts` | **只做接线**。注册 `pi.on(...)` 与 `/feishu` 命令，持有 gateway/bridge 的生命周期。工厂函数里绝不启动后台资源，只声明 |
| `bridge.ts` | 编排层。回合状态机（`startTurn`/`endTurn`）、工具调用闸门（`gateToolCall`）、入站消息转 prompt |
| `feishu.ts` | 飞书网关（direct 档）。包住 `createLarkChannel`，收敛 SDK 的事件与出站 API |
| `inbound.ts` | SDK 消息 → `InboundMessage` 的映射，以及会话名称缓存。direct/broker 两档共用 |
| `gate.ts` | 入站放行判定（`gateInbound`）。无依赖，bridge 与 renderer 共用同一份状态机 |
| `deferred.ts` | 回合进行中来自其他对话的消息要扣住，等这轮跑完再单独成回合。见下方 |
| `broker/` | broker 档。`gateway.ts` 是会话侧客户端，其余（`server`/`channel`/`registry`/`protocol`）跑在 broker 进程里 |
| `risk.ts` | 安全判定。三档模型，详见下方 |
| `approval.ts` | 多通道审批竞速（飞书卡片 vs 终端对话框），先到先得 |
| `approval-card.ts` | 卡片构造/解析 + 未决审批登记表 |
| `turn-stream.ts` | 推拉流适配器。Bridge 往里 push，SDK 的 stream 回调从里 pull |
| `renderer.ts` | 纯函数：pi 事件 → markdown。无状态、无 IO |
| `config.ts` | 配置合并与校验 |
| `log.ts` | 日志出口。**唯一允许写终端的地方** |

## 硬性约束

改这个仓库前必须知道的几条，每条都是踩过的坑：

### 日志绝不能裸写 stderr/stdout

pi 的 TUI 不接管 stderr，`console.error` 会直接打进渲染区（光标所在的输入框那一片），
把界面冲花 —— 出错时日志一多，整个会话没法操作。

所有日志走 `log.ts` 的 `createLogger()`，它经 `ctx.ui.notify` 进 pi 的消息区，
只在 headless（`hasUI === false`）或 runner 已停用时才退回 stderr。

飞书 SDK 自己的 `defaultLogger` 也是直接写 `console.log` 的，`createLarkChannel`
必须传 `logger: createSdkLogger(...)` 把它接管掉。

`ExtensionContext` 的属性全是惰性 getter，存下引用晚点读拿到的是**当前**的 UI；
但 runner 停用后读它会 **throw**，而 `log` 是从 catch 块和 SDK 回调里调的 ——
所以日志函数整段包在 try/catch 里，自己绝不抛异常。

### gateway 出站调用的异常必须在 bridge 侧兜住

`feishu.ts` 的 `streamTurn`/`sendText` 刻意**不**自我包含异常（会 reject）。
`bridge.ts` 侧统一兜底 —— 任何 gateway 调用的 rejection 都不能逃进 pi 的事件循环。
新增 gateway 调用点时，照着现有四处的写法包好。

### pi 把排队消息并进同一个 agent 运行，所以跨对话的消息必须自己扣住

`pi-agent-core` 的 `agent-loop.js`：agent 本该结束时发现有 followUp，就把它塞进
`pendingMessages` 然后 **`continue` 外层循环** —— 不发 `agent_end`，也不再发一次
`agent_start`。一次运行从头到尾只有一个 `agent_start`。

而本扩展是「一次 `agent_start` = 一条飞书流」，目标在 `startTurn` 那一刻定死。
所以**回合进行中来自别的对话的消息，答案会整段发进上一个对话** —— 那边只看到一个
表情，一个字都收不到。这不是竞态，是必然。

对策：`shouldDefer` 判定为真时不投给 pi，扣在 `DeferredQueue` 里，等 `agent_settled`
再作为新 prompt 发出去，自然开出新的 `agent_start`。

两个点不能改错：

- **必须是 `agent_settled`，不能是 `agent_end`。** `_emitAgentSettled` 是先把
  `_isAgentRunActive = false` 再 emit 的，只有在它里面 `sendUserMessage` 才会走非排队
  路径。在 `agent_end` 里发会被当成排队消息并回同一个运行，等于没修。
- **判定要用有效目标**（`#turnTarget ?? gateway.boundChatId`）。终端敲字发起的回合
  没有飞书来源，`#turnTarget` 是空的，但流照样发往已绑定会话；只看原值会误判成
  「没有目标」而放行。

### `implements GatewayLike` 挡不住「少写一个可选参数」

两个网关都声明了 `implements GatewayLike`，但 TypeScript 的方法参数是可以**少**的：
接口写 `streamTurn(run, to?)`，实现写成 `streamTurn(run)` 照样通过编译，多传的
实参被静默丢掉。群里 @ 的回复一路发到私聊，就是这么来的 —— 接口和调用方都改了，
实现没改，全绿。

所以 `test/gateway-arity.test.ts` 用 `Function.length` 兜这一类。改 `GatewayLike`
的签名时，两个实现都要跟着改，并给新参数补一条 arity 断言。

### 安全闸门一律 fail-closed

- `assessRisk` 抛错 → 按危险处理（`gateToolCall` 里有 try/catch，因为 async 函数的
  未捕获异常会变成 rejected promise 直接跳过 block 契约，结果是危险工具被放行）
- 审批超时 / 所有通道都挂 / 没有通道 → 一律拒绝
- 会话结束时所有未决审批一律拒绝，并把卡片收到终态

### 卡片点击必须自己鉴权

飞书 SDK 只对 `im.message.receive_v1` 走完整的策略管道；`card.action.trigger`
**只有去重和串行化，没有任何白名单过滤**。所以 `feishu.ts` 的 cardAction handler
自己校验 `evt.chatId === bound` 且 `operator.openId ∈ approverAllowlist` ——
否则群里任何看得见卡片的人都能点「允许」，让 agent 干活的人自己批准自己。

### strip-only 模式的语法限制

Node 的类型剥离不做代码生成，所以**不能用构造函数参数属性**（`constructor(private x)`），
依赖要写成显式字段。同理避免 `enum`、`namespace`、装饰器。

模块间 import 必须带 `.ts` 后缀（`allowImportingTsExtensions`）。
`verbatimModuleSyntax` 开着，纯类型导入必须写 `import type`。

## risk.ts 的判定模型

三档，`balanced` 是默认：

- **`strict`** —— 安全清单：只有 read/grep/find/ls 免批。用清单而非黑名单是因为
  扩展和 MCP 能注册任意名字的工具，枚举危险名字必然漏
- **`balanced`** —— bash 走**命令白名单 + 标志白名单**。只列命令名不够：
  `git log --output=`、`sort -o`、`find -fprint0` 都能把任意内容写进任意路径，
  且不含任何 shell 元字符
- **`relaxed`** —— bash 走**黑名单**，与另两档相反。枚举危险必然有漏网，
  这是它用便利换来的代价

改 `balanced` 的白名单时，核心不变量是「**评估的文本 ≠ 执行的 argv**」——
本模块前四版反复栽在这里：

- 用 `shell-quote` 真解析而不是正则 + split：`'--output=/etc/x'` 带引号时不以 `-`
  开头，naive 分词会当成位置参数放过，而 shell 剥掉引号后它仍是标志
- 反引号 / `$` / `{}` 在原始串上先拒（`RAW_FORBIDDEN`）—— shell-quote 不把它们
  报成 operator，会让 token 流与实际 argv 脱节
- 未加引号的 glob 一律放弃判定：只看得到模式串，看不到展开成什么
- 重定向一律放弃判定：写入目标是操作数不是命令，逐段判定看不见它
- 管道 / `&&` / `||` / `;` 按段拆开逐段判定，**一段不安全整条不安全**
- 加命令进白名单前，先查它有没有写文件的口子（`-o`、`-i`、`w` 之类），
  以及有没有「第二个位置参数即输出文件」的行为（`uniq in out`）—— 后者只能靠
  `maxPositionals` 拦

## 测试

`test/*.test.ts` 与 `extensions/feishu/*.ts` 一一对应（`index.ts` 除外 ——
它只做接线，逻辑都在被它调用的模块里）。用 `node:test` + `node:assert/strict`，
无 mock 框架，需要替身时手写假对象（见 `test/bridge.test.ts` 的 `fakeGateway`）。

本仓库按 TDD 开发：**先写失败的测试，确认它因功能缺失而失败，再写实现**。
安全相关的改动尤其如此 —— `risk.test.ts` 里「回归 v1 / v2」那两组是历史上真实
逃逸过的用例，改判定逻辑时它们必须保持绿。

测试与注释用中文，与现有风格保持一致。

## 配置

`~/.pi/agent/feishu.json` → `<项目>/.pi/feishu.json`，后者覆盖前者。
凭据两项（`FEISHU_APP_ID` / `FEISHU_APP_SECRET`）可走环境变量且优先级最高，
其余键只能写在配置文件里。

「文件不存在」和「文件存在但 JSON 有语法错」刻意区分开 —— 两者都静默跳过的话，
用户改坏配置只会看到一句莫名其妙的「缺少 appId」，或者更糟：白名单悄悄退回空数组。

字段说明见 `README.md`。README 还带一份**冒烟测试清单**（需要真实飞书应用 + 真实
pi 会话），改动涉及连接、审批、绑定行为时照着走一遍。
