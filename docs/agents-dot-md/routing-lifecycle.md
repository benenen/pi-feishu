# 消息路由与回合生命周期
> 普通消息延迟、投递占位、来源认领、自主回合与话题路由的硬性契约。

## pi 把排队消息并进同一个 agent 运行，所以普通消息必须自己扣住
`pi-agent-core` 的 `agent-loop.js`：agent 本该结束时发现有 followUp，就把它塞进
`pendingMessages` 然后 **`continue` 外层循环** —— 不发 `agent_end`，也不再发一次
`agent_start`。一次运行从头到尾只有一个 `agent_start`。

而本扩展是「一次 `agent_start` = 一条飞书流」，目标在 `startTurn` 那一刻定死。
所以**回合进行中来自别的对话的消息，答案会整段发进上一个对话** —— 那边只看到一个
表情，一个字都收不到。这不是竞态，是必然。

同一个对话也不能直接 followUp：目的地虽然没错，答案却只更新先前那张卡片；飞书更新
消息不会把旧卡片置底，后来那条问题下面没有机器人消息，看起来就是「pi 做完了但没回」。
一条普通消息必须单独开一个 run 和一张卡，卡片头再带上对应的飞书问题原文。

对策：`shouldDefer` 判定为真时不投给 pi，扣在 `DeferredQueue` 里，等 `agent_settled`
再作为新 prompt 发出去，自然开出新的 `agent_start`。只有**当前回合所在的同一会话、
同一话题**用 `!` 显式 steer 时立即打断；另一个会话或同群不同话题的 `!` 仍要扣住，
不能劫持当前任务。

`ExtensionAPI.sendUserMessage()` 返回 `void`，不是可等待的 Promise；从调用到
`agent_start` 之间还有异步窗口。接线层必须先用 `reserveDispatch(messageId)` 同步占位，
再调用 `sendUserMessage`，否则两条紧邻消息都可能看见「空闲」并挤进同一个 run。同步拒绝
时用 `cancelDispatch` 释放占位和来源；不要用 `await sendUserMessage` 制造已经等待成功的假象。
Pi 的 wrapper 还会吞掉底层 Promise 的异步 preflight rejection，因此生产接线在投递后挂
120 秒 `DispatchWatchdog`：到 `before_agent_start` / `agent_start` 就清掉；一直没启动则 abort、
释放 reservation、给原问题失败回执，并继续放行延迟队列，绝不能让整座桥永久卡在 busy。

## 回合来源只能靠 before_agent_start 的 prompt 认领
pi 不提供「这个回合是哪条消息触发的」：`agent_start` 是空事件，`sendUserMessage`
收不了元数据。**入站消息**唯一的钥匙是 `before_agent_start.prompt` —— 它就是
`sendUserMessage` 收到的原字符串（`expandPromptTemplates: false`，pi 不改写），且恰好在
`agent_start` 之前发出。（扩展自己推起来的**自主回合**连这个事件都没有，另有一把钥匙，
见下一节。）

所以入站时把 `messageId → { chatId, senderId, question }` 和「发给 pi 的原文」一起登记进
`origin-registry.ts`，`before_agent_start` 上按原文认领，出站一律按 messageId 回查。
**不要再引入任何「最近一条是谁」的全局变量** —— 两条消息接连进来时它必错。

`question` 是飞书原始正文，给 `startTurn` 放在新卡片顶部；不能改用加工后的 prompt，
后者可能已经拼进图片 key、字节数等只给 agent 看的说明。纯图片正文为空时才退回 prompt。

认领关联在 `agent_settled` 清，**不能在 `agent_end` 清**：自动重试会在一次运行里
开多个回合，而 `before_agent_start` 只发一次。

历史上为这件事错过三版，根因都是**赌 pi 的内部顺序**：FIFO 队列（要求「一个回合
恰好一个槽位」）、`input.text` 关联、会话条目倒推（要求 `agent_start` 时触发这轮的
用户消息已在 `getEntries()` 里 —— 实测不成立）。

## 自主回合（pi-asd 的 watcher 推送）另有一把钥匙，且卡片必须晚建
扩展用 `pi.sendMessage(..., { triggerTurn: true })` 推起来的回合，在 pi 里走的是
`sendCustomMessage` → `_runAgentPrompt`，**绕开了 `prompt()`，因此根本不发
`before_agent_start`**。上一节那把钥匙对它完全无效，认领必然落空、出站退回网关默认
收件方。实测症状：在群里 @ 派给子 agent 的活，一分五十秒后结果掉进了操作员私聊。

pi-asd 的推送在 `details.session` 里报出它说的是哪个 session，于是补上第二把钥匙：

1. `tool_execution_end` 上，`asd_spawn` / `asd_steer` / `asd_follow` / `asd_nav` 的返回带
   `details.session` —— 那一刻回合来源还认领得到，把 `session → 出站目标` 记进
   `agent-origin.ts`
2. `message_start` 上认出 `customType === "pi-asd-agent"`，按 `details.session` 回查目标

两条硬规矩：

- **认领得到消息来源时，来源永远优先。** 推送在 boss 忙时是以 followUp 并进当前回合的，
  那一轮属于提问的那个人，不能被一条顺路的 agent 通知改道（`#autonomousTarget` 只在
  `#originMessageId === undefined` 时返回值）。
- **认领不到来源的回合，`startTurn` 不许立刻建卡。** 飞书流式卡片一旦建在某个会话里就
  搬不走，而 pi 的事件顺序是 `agent_start` → `message_start`：在 `startTurn` 里定死目标，
  推送就永远只能落进默认收件方。所以 `#startStreaming` 推迟到「真的有内容要发」才调 ——
  有 `question` 抬头的（飞书消息发起的）照旧立刻建卡，行为不变。

只认 `customType` + `details.session` 这一对结构化字段，**不许**退回去解析通知正文里的
`agent "xxx"`：那是给模型读的一句中文，拿它当协议，pi-asd 改一次措辞这里就静默失灵。
认不出就退回默认收件方 —— 也就是没修之前的行为，不会发给**错误**的对话。

## 「飞书流开着」和「pi 忙不忙」是两个生命周期，混用会丢消息
- `isStreaming` —— `agent_start` → `agent_end`，只管飞书流的渲染
- `isAgentActive` —— `agent_start` → **`agent_settled`**，才是 pi 的运行

后者活得久：`agent_end` 之后 pi 还可能自动重试或压缩上下文
（`_handlePostAgentRun` 用 `agent.continue()` 再开一轮），`_isAgentRunActive` 要到
`_emitAgentSettled` 才置 false。而 `endTurn` 一进来就把 `#turn` 清了，之后还要等
流式收尾（上限 15s）—— 所以窗口能有十几秒。

这段窗口里用 `isStreaming` 判定的话，`decideDelivery` 会认为「空闲」而不带
`deliverAs` 直接发，`prompt()` 抛 `Agent is already processing`，异常被入站
handler 的 catch 吞掉，**消息就没了**。

凡是「pi 现在能不能收一条新 prompt」的判断一律用 `isAgentActive`。
`decideDelivery` 的参数因此叫 `agentActive` 而不是 `isStreaming`。

两个点不能改错：

- **必须是 `agent_settled`，不能是 `agent_end`。** `_emitAgentSettled` 是先把
  `_isAgentRunActive = false` 再 emit 的，只有在它里面 `sendUserMessage` 才会走非排队
  路径。在 `agent_end` 里发会被当成排队消息并回同一个运行，等于没修。
- **判定要用有效目标**（`#turnTarget ?? gateway.boundChatId`）。终端敲字发起的回合
  没有飞书来源，`#turnTarget` 是空的，但流照样发往已绑定会话；只看原值会误判成
  「没有目标」而放行。

## 话题只在「触发消息本来就在话题里」时才走
出站目标是 `SendTarget`（`types.ts`）而不是裸 chatId。`replyTo` 有值时 SDK 改走
`im.v1.message.reply` 并带 `reply_in_thread`，回复才落回提问的那个话题。

判定的唯一依据是入站消息的 `threadId`（`origin-registry.ts` 的 `targetOf`）：
有就回话题，没有就退化成 `{ chatId }` 走原来的 `message.create`。

**不要改成「一律带 replyTo」** —— 普通群里那样会把每条回答都变成一个新话题，
是所有现存用户可见的行为倒退。

出站一律用 `bridge.turnSendTarget` / `origins.targetOfToolCall`，不要用
`turnTarget` —— 后者只回 chatId，是给 `deferred.ts` 做「是不是同一个对话」比较用的，
两个语义别混。
