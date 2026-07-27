# pi-feishu 设计文档

日期：2026-07-27
状态：待实现

## 一句话

一个 pi 扩展（pi package），把当前 pi 会话桥接到飞书，让你在终端开的头，能从手机上接着聊 —— 带流式输出、工具可见性和危险操作审批。

## 目标与非目标

### 目标

- 通过 `pi install` 安装，作为 pi 扩展运行在宿主 pi 进程内
- 飞书单聊/群聊 ↔ **当前这个** pi 会话双向桥接，共享同一份上下文
- 助手输出流式呈现，工具调用可见
- 危险工具调用需人工审批，飞书卡片和 TUI 对话框都可批
- 白名单控制谁能触达

### 非目标（YAGNI）

- 多 chat 对多 session、多 repo 切换 —— 一个 pi 进程只有一个会话和一个 cwd，此形态下不成立
- 群聊多人并发驱动同一会话
- 卡片上除「允许 / 拒绝」外的交互
- 语音、视频消息
- 自建 WS 重连、心跳、markdown→卡片转换 —— `@larksuiteoapi/node-sdk` 已内置

## 背景与关键约束

### pi SDK

- 扩展通过 `pi.on(...)` 订阅事件，`tool_call` 事件 **可以阻塞**：返回 `{ block: true, reason }` 即拒绝该次工具执行
- `ctx.sendUserMessage(content, { deliverAs?: "steer" | "followUp" })` 注入用户消息，`content` 接受 `string` 或 `(TextContent | ImageContent)[]`
- `ctx.ui.confirm/select` 支持 `{ signal }`，可用 `AbortController` 程序化取消
- **扩展 factory 里禁止启动后台资源**（进程、socket、watcher、timer）。必须延迟到 `session_start` 或触发它的命令，并注册幂等的 `session_shutdown`
- `/new`、`/resume`、`/fork` 会替换整个 session，扩展捕获的旧 `pi` / `ctx` 全部失效

### 飞书 SDK

`@larksuiteoapi/node-sdk` ≥ 1.71 的 `createLarkChannel` 已提供：

- WS 长连接、重连、心跳（服务端权威策略）
- `policy.{dmMode, dmAllowlist, groupAllowlist, requireMention}` 白名单与 @ 判定
- `safety.dedup` 消息去重
- `channel.stream(to, { markdown: producer })` 流式卡片，含 `streamThrottleMs/Chars` 节流
- `streamMaxElementChars`（默认 30000）超限自动滚动到新卡片，规避 `230099 / ErrCode 11310`
- `on('cardAction')` 卡片按钮回调
- `downloadResource(fileKey, type)` 下载图片/文件

这些一律直接用，不重写。

## 架构

### 形态

目录式 pi extension，打包为 npm/git 包，`pi install` 安装。

### 生命周期

```
factory(pi)          只注册 /feishu 命令、读配置。不开任何连接
   ↓
session_start        config.autoStart 为 true 才 connect()，否则等 /feishu start
   ↓
[运行中]              LarkChannel 长连接，双向桥接
   ↓
session_shutdown     幂等 disconnect()，可重入
```

`autoStart` 默认 `false`。否则每开一个 `pi` 就多一条 WS 连接，多个实例会抢同一批消息。

### 绑定模型

一个 pi 会话 ↔ 一个飞书 chat：

- `policy.dmMode: 'allowlist'` + `dmAllowlist: [配置的 open_id]`；群聊用 `groupAllowlist` + `requireMention: true`
- 首条通过白名单的消息**绑定**其 `chatId`
- 其他 chat 的消息回绝：「该会话已绑定到其他对话」
- `/feishu status` 查看状态，`/feishu stop` 解绑并断开

### 模块

| 文件 | 职责 | 可脱离 SDK 单测 |
|---|---|---|
| `src/config.ts` | 读 settings + env，校验，导出强类型 `Config` | 是 |
| `src/index.ts` | 扩展入口：注册命令、挂生命周期 | 否 |
| `src/bridge.ts` | 编排：飞书事件 ↔ pi 事件 | 否 |
| `src/renderer.ts` | 纯函数 `(event) => string \| null` | 是（重点） |
| `src/turn-stream.ts` | 推→拉适配器 | 是（重点） |
| `src/approval.ts` | `assessRisk` 纯函数 + 卡片交互 | 判定部分是 |
| `src/feishu.ts` | LarkChannel 封装 | 否 |

三条边界：

1. `renderer.ts` 不认识飞书，也不认识 pi 的 session —— 只是事件到 markdown 的纯映射
2. `approval.ts` 的**危险判定**是纯函数 `(toolName, input) => "safe" | "risky"`，与卡片交互分离
3. `turn-stream.ts` 不碰任何 SDK —— 只是一个带背压的字符串队列

## 数据流

### 入站：飞书 → pi

```
飞书 message
  → LarkChannel policy 过滤（SDK 内置）
  → 绑定检查（非绑定 chat 回绝）
  → /feishu 子命令？→ 本地处理，不进 agent
  → 有图片/文件？→ downloadResource() → ImageContent
  → ctx.sendUserMessage(content, { deliverAs })
```

`deliverAs` 决策表：

| 情形 | deliverAs | 理由 |
|---|---|---|
| agent 空闲 | 省略 | 直接开新回合 |
| agent 在跑 | `followUp` | 遥控时误打断代价高，默认排队 |
| 消息以 `!` 开头 | `steer` | 显式打断的逃生口 |

### 出站：pi → 飞书

pi 事件是**推**模型，`channel.stream()` 的 producer 是**拉**模型（给你 controller，等 async 函数返回才结束）。用 `TurnStream` 适配：

```ts
class TurnStream {
  push(chunk: string): void                                // pi 事件回调里调
  finish(): void                                           // agent_end 时调
  async pump(c: MarkdownStreamController): Promise<void>   // 交给 producer
}
```

`agent_start` 开卡并启动 `pump`，`agent_end` 调 `finish()` 让 producer resolve、卡片定稿。**一个 agent 回合 = 一张流式卡片。**

### renderer 映射表

采用「全推」模式：不管回合从终端还是飞书发起，内容都同步到飞书。

| pi 事件 | 渲染 |
|---|---|
| `input`（source=`interactive`） | `> 💻 你在终端问：…` |
| `message_update` / `text_delta` | 原样追加 |
| `message_update` / `thinking_delta` | 丢弃 |
| `tool_execution_start` | `⚙️ **bash** \`npm test\`` |
| `tool_execution_end` | ` ✓ 12s` / ` ✗ 失败` |
| `agent_end` | `--- ⏱ 46s · 12.3k tok` —— 耗时由桥接自己计时（`agent_start` 打点），token 从 `message_end` 的 `message.usage` 累加 |

## 审批流

飞书卡片与 TUI 对话框**同时弹出，先到先得**：

```ts
pi.on("tool_call", async (event, ctx) => {
  const risk = assessRisk(event.toolName, event.input);
  if (risk === "safe") return undefined;

  const ac = new AbortController();
  const decision = await Promise.race([
    askFeishuCard(event, ac.signal),
    askTuiDialog(ctx, event, ac.signal),
    rejectAfter(config.approvalTimeoutMs),
  ]);
  ac.abort();

  return decision.allow ? undefined : { block: true, reason: decision.reason };
});
```

硬规则：

1. **超时 fail-closed** —— 超时一律 `block`，绝不默认放行
2. 被抢答的一边要收干净：卡片 `updateCard` 改「已在终端处理」，TUI 走 `signal.abort()`
3. 危险判定分两档，由 `approvalMode` 控制

### 危险判定

`assessRisk(toolName, input, config) => "safe" | "risky"`，纯函数。

**`balanced`（默认）** —— 只拦真正有破坏力的：

- `bash` 命令匹配危险模式：`rm -rf`、`sudo`、`chmod`/`chown 777`、`dd`、`mkfs`、`curl|wget ... | sh`、`git push --force`、写入 `/dev/`
- `bash` 命令含重定向（`>`、`>>`、`tee`）且目标在 `repoRoot` 之外
- `write` / `edit` 目标路径在 `repoRoot` 之外
- 其余（`ls`、`cat`、`grep`、`git status`、`npm test` 等读类）直接放行

**`strict`** —— 所有 `bash` 调用 + 所有 `write` / `edit` 都要批。适合完全不信任的环境，代价是一个回合可能要批十几次。

模式判定必须防绕过：命令先做空白归一化和大小写归一化再匹配，路径先 `path.resolve` 再判断是否在 `repoRoot` 内（不能只做字符串前缀比较，否则 `../` 和符号链接能逃逸）。

## 会话替换

`/new`、`/resume`、`/fork` 会换掉整个 session，扩展捕获的旧 `pi` / `ctx` 失效。

- `session_before_switch` / `session_before_fork` → 断开桥接，收掉所有未决审批（**一律 block**）
- 新 session 的 `session_start` → 用**新的** ctx 重建桥接，飞书发一条「会话已重置」
- 绝不跨 session 持有 `ctx`；桥接状态存在扩展模块作用域，每次 `session_start` 重建

## 错误处理

| 失败点 | 处理 |
|---|---|
| 飞书 WS 断线 | SDK 自动重连；重连期间出站丢弃并标记，`agent_end` 补发完整结果 |
| 出站 `append` / `send` 失败 | try/catch 只 log；卡片废了降级为一条完整 `channel.send` |
| 审批卡片发不出去 | fail-closed → `block`，理由「审批通道不可用」 |
| `downloadResource` 失败 | 不阻塞，转成 `[图片下载失败]` 文本继续送给 agent |
| 事件 handler 内抛异常 | 全部包 try/catch，避免 `extension_error` 打断 agent |
| 配置缺失 / 非法 | 启动即校验，报错到 TUI，不半开 |

原则：**飞书挂了，pi 该干活还是干活；审批通道挂了，一律不放行。**

## 配置

来源：pi `settings.json` 的扩展配置段 + 环境变量（密钥优先走环境变量）。

| 键 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `appId` | string | 必填 | 飞书 App ID |
| `appSecret` | string | 必填 | 飞书 App Secret，建议走环境变量 |
| `autoStart` | boolean | `false` | `session_start` 时是否自动连接 |
| `dmAllowlist` | string[] | `[]` | 允许单聊的 open_id |
| `groupAllowlist` | string[] | `[]` | 允许的群 chat_id |
| `requireMention` | boolean | `true` | 群聊是否需要 @ 机器人 |
| `approvalMode` | `"balanced"` \| `"strict"` | `"balanced"` | 危险判定档位，见「危险判定」 |
| `approvalTimeoutMs` | number | `120000` | 审批超时，超时即拒绝 |
| `repoRoot` | string | 宿主 cwd | 判定「写到范围外」的基准路径 |

## 测试策略

### 1. 纯函数单测（主战场，无 SDK 无网络）

- `renderer`：事件序列 → 期望 markdown。覆盖 delta 拼接、工具行、thinking 丢弃、收尾统计
- `assessRisk`：表驱动，`balanced` / `strict` 两档各测一遍。重点测**绕过尝试** —— `rm  -rf`（多空格）、`RM -RF`（大小写）、`../` 路径逃逸、符号链接逃逸、`$(...)` 嵌套；以及 `balanced` 下读类命令确实放行（防误伤）
- `TurnStream`：push 早于 pump、finish 后残留 flush、pump 中持续 push、空回合
- `config`：校验分支

### 2. 契约测试（mock 两个 SDK）

- `approval`：Promise.race 三条路径各测一遍，断言另一边确实被 abort、**超时一定 block**
- `bridge`：绑定逻辑、`deliverAs` 决策表、session 替换时的断开/重连

### 3. 手工冒烟（写进 README checklist）

真 app + 真会话：单聊往返、图片转发、危险命令三种审批结局（飞书批 / TUI 批 / 放超时）、断网重连、`/new` 后重绑。

实现顺序遵循 TDD：先写测试再写实现。

## 未决事项

无。所有设计决策已确认。
