# direct 模式操作手册

默认模式，不需要任何额外进程 —— pi 会话自己连飞书。
（另一种是 broker 模式，见 [`broker.md`](broker.md)；什么时候该换过去，本文末尾有对照。）

## 五分钟上手

### 1. 配置

`~/.pi/agent/feishu.json`（全局）：

```json
{
  "appId": "cli_xxx",
  "appSecret": "xxx",
  "approverAllowlist": ["ou_你的openid"],
  "bindTarget": "code",
  "autoStart": false
}
```

`transport` 不用写，默认就是 `direct`。凭据也可以走环境变量
`FEISHU_APP_ID` / `FEISHU_APP_SECRET`，优先级最高。

**`approverAllowlist` 是必填的**，而且必须是你在**这个飞书应用**下的 open_id。

> **open_id 按应用隔离** —— 换了 appId 就得重取，旧的填进去不会报错，只会静默失效。
> 取当前应用下的 open_id：
>
> ```bash
> TOKEN=$(curl -s -X POST https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal \
>   -H 'Content-Type: application/json' \
>   -d '{"app_id":"cli_xxx","app_secret":"yyy"}' | jq -r .tenant_access_token)
> curl -s -H "Authorization: Bearer $TOKEN" \
>   'https://open.feishu.cn/open-apis/contact/v3/scopes?user_id_type=open_id' | jq .data.user_ids
> ```

### 2. 启动并配对

```
/feishu start
```

终端打出一串 8 位配对码：

```
飞书桥接已启动，等待配对。
在要绑定的飞书对话里发送这串配对码（10 分钟内有效）：

    6RYXSZSS
```

把码发到你想绑的飞书对话（私聊或群都行），机器人回「配对成功」即完成。
**在哪个对话里发，就绑哪个对话。**

配对码只在终端显示，绝不发进飞书 —— 发出去就等于把钥匙挂门上。它是一次性的、
有时效的，重新签发会作废旧码。

### 3. 用起来

飞书里直接发消息，pi 就开始跑回合，结果以流式卡片回来。

- 消息前缀 `!` 表示**打断**当前回合（steer），否则排队到回合结束（followUp）
- 危险操作会弹审批卡片，三个按钮：允许 / 本回合全部允许 / 拒绝

## 命令

| 终端 | 飞书里 | 作用 |
|---|---|---|
| `/feishu start` | ✗ 只能从终端发起 | 建立长连接。拿着终端的人才有权决定 |
| `/feishu status` | ✓ | 连接、绑定、策略、审批的完整状态 |
| `/feishu pair` | ✗ | 未绑定时重新签发配对码 |
| `/feishu unbind` | ✓ | 解绑；`bindTarget: "code"` 下会自动签发新码 |
| `/feishu stop` | ✓ | 停止并解绑 |

## 绑定方式（`bindTarget`）

| 值 | 行为 | 适合 |
|---|---|---|
| `"code"` | 终端显示配对码，谁输对绑谁 | **推荐**，私聊和群都能绑 |
| `"operator"`（默认） | 启动时主动私信 `operatorOpenId` 并绑定该私聊 | 只用私聊、想省一步 |
| `"oc_xxxx"` | 启动即绑定该群，并往群里发就绪通知 | 固定绑某个群 |
| `"none"` | 不主动绑，**任意首条消息即绑** | 不建议 —— 谁先说话谁抢到 |

`"none"` 是唯一没有握手的一档：任何通过白名单的人先开口，就拿到了这个 pi 会话的
指令权。配对码就是为了替掉它。

## 一个会话同时接私聊和群 @（`multiChat`）

默认一个 pi 会话只认一个对话，绑了私聊，群里 @ 它只会收到「已绑定到其他对话」。

想两边都要：

```json
{ "multiChat": true, "requireMention": true }
```

开启后每个回合的输出**回到触发它的那个对话** —— 流式卡片、补发的全文、审批卡片都是。

**群场景下 `requireMention` 必须是 `true`。** 为 `true` 时飞书侧的策略管道会把没
@ 机器人的群消息直接拒掉，根本到不了扩展这层，所以别人的闲聊不会进你的 agent 上下文。
设成 `false` 等于不看 @，群里每条消息都会变成给 agent 的 prompt。

### 开了 multiChat 还需要 bind 吗？需要，但作用变了

绑定没有被绕过，它从「唯一准入门」变成了另外两件事：

**1. 初次握手的门。** 入站处理的顺序是：未绑定且有待配对码时**只认配对码**，
`multiChat` 在这一步还不生效。也就是说第一条消息仍然必须是配对码 —— 谁握着终端，
谁决定这个会话归谁。配对成功绑上之后，`multiChat` 才开始放行其他对话。

**换句话说，配对码只保护第一次接触。** 之后凡是过了 `dmMode` / 白名单 / `requireMention`
的消息都能驱动这个 agent。你要清楚这个取舍再开 `multiChat`。

**2. 无来源回合的默认收件方。** 出站是 `resolveTarget(bound, to)` —— 有显式目标就发给它，
没有就回落到已绑定会话。终端自己敲的回合没有来源，输出正是靠这个回落找到去处。
所以即便开了 `multiChat`，也别去 `/feishu unbind` —— 解绑之后终端发起的回合会没地方发。

### 来源归属会在两处对不上

pi 的 `agent_start` 事件**不带「是哪条消息触发的」**，来源只能靠顺序推断（转发消息时
入队，回合开始时出队）。常规路径（含 followUp 排队）是对的，但：

1. **终端自己敲的回合没有来源** → 退回默认收件方（已绑定会话），不会乱发给上一个来源
2. **回合中途被另一个对话 `steer` 打断** → 输出仍回最初那个来源

同一个人从两个入口用，这两条都不构成问题。多人共用时第 2 条会让人困惑 —— 那种场景
该用 broker 模式做严格隔离。

## 谁能触达、谁能批准

这是两个独立的问题，别混。

**谁能让 agent 干活**：`dmMode` + `dmAllowlist` + `groupAllowlist` + `requireMention`，
由飞书 SDK 的策略管道执行。`dmMode: "open"` 意味着**租户内任何人**都能私聊驱动你的 agent。

**谁点审批的「允许」算数**：`approverAllowlist`，由扩展**自己**校验。

第二条必须自己做，因为飞书 SDK 只对 `im.message.receive_v1` 走完整策略管道；
`card.action.trigger`（卡片点击）**只有去重和串行化，没有任何白名单过滤**。不自己校验
的话，群里任何看得见卡片的人都能点「允许」—— 让 agent 干活的人自己批准自己，闸门等于没有。

卡片点击实际要过三层：点击人在 `approverAllowlist` 里、点击来自这张卡片发往的那个对话、
且（direct 档独有）来自**当前**绑定的会话。

## 审批档位

| 档位 | bash 判定 | 适合 |
|---|---|---|
| `strict` | 除 read/grep/find/ls 外一律要批 | 完全不信任的环境 |
| `balanced`（默认） | **白名单**：命令名 + 标志都在只读表里才放行 | 日常 |
| `relaxed` | **黑名单**：只拦明确破坏性的命令 | 信任 agent 与仓库环境时 |

`balanced` 和 `relaxed` 都基于 `shell-quote` 的**结构化解析**，不是在原始串上扫正则 ——
所以 `grep rm notes.txt` 不会因为出现 `rm` 被拦，`2>/dev/null` 不会被当成写 `/dev`。
解析不了的（glob、`$` 展开、命令替换）一律退回更保守的处理。

`relaxed` 的黑名单可以调：

```json
{
  "approvalMode": "relaxed",
  "denyPatterns": ["\\bterraform\\s+apply\\b"],
  "allowPatterns": ["\\bkill\\b"]
}
```

`allowPatterns` 是例外，**优先于所有 deny（包括内置）**，这是给内置规则开口子的办法。
两者都是正则字符串（JSON 里反斜杠写两遍），写错会在 `/feishu start` 时当场报错。

## 多个 pi 会话怎么办

**一个飞书应用只能有一条长连接。** 多个 pi 会话跑同一个 appId 会抢消息 —— 飞书把事件
推给哪条连接是不确定的，现象是「有的会话收不到，有的收到不该它管的」。

所以：

- **`autoStart` 保持 `false`**（默认），否则你在任意目录开 pi 都会自动连上来抢
- 要多个会话同时用飞书，**一个项目配一个飞书应用**：项目里放 `<项目>/.pi/feishu.json`
  写各自的 `appId` / `appSecret` / `approverAllowlist`，它会覆盖全局配置
- 不想为每个项目建应用，就换 [broker 模式](broker.md)

> `.pi/feishu.json` 里有 `appSecret`。放进 git 仓库前先把 `.pi/` 加进 `.gitignore`，
> 或者凭据走环境变量、只把非密钥项写文件。

## 排障

| 症状 | 原因 | 处置 |
|---|---|---|
| 飞书发消息没反应，日志有 `sender_not_allowed` | 你的 open_id 不在 `dmAllowlist` 里，或换了 appId 后 open_id 失效 | 用上面的 curl 重取 open_id |
| 日志有 `no im.message.message_read_v1 handle` | 已读回执事件没有 handler | 正常噪音，已被过滤；想根治就在开放平台取消该事件订阅 |
| 群里 @ 收到「该 pi 会话已绑定到其他对话」 | 会话绑在别处 | `/feishu unbind` 后重新配对，或开 `multiChat` |
| 群里不 @ 也触发 agent | `requireMention` 是 `false` | 改成 `true` |
| 有的会话收不到消息 | 多个 pi 会话共用同一个 appId 在抢 | `/feishu stop` 停掉多余的，或一项目一应用 |
| `/feishu start` 报「飞书连接失败」 | 凭据错或网络不通 | 核对 appId/appSecret；确认能出网到 `open.feishu.cn` |
| 配置改了不生效 | 配置在 `start()` 时读一次 | `/feishu stop` + `/feishu start` |
| 改了配置文件仍然不生效 | 改错了地方 | 路径是 `~/.pi/**agent**/feishu.json`，不是 `~/.pi/feishu.json` |

## direct 还是 broker

| | direct（默认） | broker |
|---|---|---|
| 额外进程 | 无 | 需要起、管、护一个常驻进程 |
| 一个飞书应用能配几个会话 | 1 个 | 多个 |
| 一个会话能接几个对话 | 多个（`multiChat`），共用一份上下文 | 1 个，各会话上下文独立 |
| 某个会话挂了 | 只影响它自己 | 只影响它自己 |
| broker 挂了 | 不涉及 | 挂在它上面的会话**全部**失联 |

只有一个会话用飞书、或愿意一项目一应用 → **direct**。
多个会话要共用同一个飞书身份、且需要各自独立上下文 → **broker**。

## 冒烟清单

改动涉及连接、审批、绑定行为时照着走一遍（需要真实飞书应用）：

- [ ] `/feishu start` → 终端出配对码 → 在对话里发码 → 回「配对成功」
- [ ] `/feishu status` 显示绑定会话的**名称**与 id
- [ ] 飞书发消息 → pi 起回合 → 流式卡片出现，含工具行与耗时/token 收尾
- [ ] 终端自己敲一句 → 飞书同步出现 `> 💻 终端：...`
- [ ] `!` 前缀能打断正在跑的回合
- [ ] 危险命令 → 弹审批卡片 → 允许/拒绝/本回合全部允许 三个按钮都按预期
- [ ] 不点，等超时 → 命令被拦，理由含「超时」
- [ ] 在 TUI 里确认 → 飞书卡片变「已在终端处理」
- [ ] 非 `approverAllowlist` 成员点卡片 → 无效，日志出现「忽略非授权审批人」
- [ ] 绑定后换个对话发消息 → 收到「已绑定到其他对话」（未开 `multiChat` 时）
- [ ] 开 `multiChat` 后：私聊与群 @ 各自的回合，输出各回各家
- [ ] 断网再恢复 → 日志出现重连并恢复，后续消息仍可用
- [ ] `/new` 重置会话 → 桥接断开；`/feishu start` 可重新绑定
- [ ] 故意填错 `appSecret` → 报中文的「飞书连接失败：…」而不是 pi 的通用错误
- [ ] 故意把配置写成非法 JSON → 报「不是合法的 JSON」而不是「缺少 appId」
