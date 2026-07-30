# pi-feishu

把当前 pi 会话桥接到飞书：终端上开的头，手机上接着聊。带流式输出、工具可见性和危险操作审批。

## 安装

```bash
pi install /path/to/pi-feishu     # 本地
pi install git:github.com/you/pi-feishu
```

## 配置

配置按 `~/.pi/agent/feishu.json` → `<项目>/.pi/feishu.json` 的顺序合并，后者覆盖前者。
注意是 `~/.pi/**agent**/`，不是 `~/.pi/` —— 放错地方不会报错，只是永远不生效。

凭据两项（`appId` / `appSecret`）可走环境变量 `FEISHU_APP_ID` / `FEISHU_APP_SECRET`，
且**优先级最高**；其余键只能写在配置文件里。

配置文件如果存在但 JSON 有语法错，会明确报「不是合法的 JSON」，不会被当成「文件不存在」
悄悄跳过 —— 否则你只会看到一句莫名其妙的「缺少 appId」，或者更糟：白名单悄悄退回空数组。

```json
{
  "appId": "cli_xxx",
  "appSecret": "xxx",
  "bindTarget": "code",
  "approverAllowlist": ["ou_your_open_id"],
  "approvalMode": "balanced",
  "autoStart": false
}
```

一共 18 个键，按用途分五组。

### 凭据

| 键 | 默认 | 说明 |
|---|---|---|
| `appId` | **必填** | 飞书应用 id。也可用环境变量 `FEISHU_APP_ID` |
| `appSecret` | **必填** | 应用密钥。也可用 `FEISHU_APP_SECRET` |

### 谁能触达机器人

| 键 | 默认 | 说明 |
|---|---|---|
| `dmMode` | 见右 | `open` 所有人可私聊；`allowlist` 只认名单。**一个白名单键都没配时默认 `open`**，配了 `dmAllowlist`/`groupAllowlist` 则自动切 `allowlist`（老配置不会被悄悄放开）|
| `dmAllowlist` | `[]` | 允许私聊的 open_id（`ou_` 开头）。**open_id 按应用隔离** —— 换了 appId 就得重新取 |
| `groupAllowlist` | `[]` | 允许的群 chat_id（`oc_` 开头）。**空数组表示「不限」，不是「全部禁止」** |
| `readReceiptEmoji` | `"GLANCE"` | 开始处理一条消息时给它加的表情回应，充当「已读/在处理」信号。取值是**飞书的具名表情 key**（不是 Unicode 表情）；置空字符串关闭 |
| `multiChat` | `false` | **仅 direct 档**：一个 pi 会话同时服务多个对话（私聊 + 群 @），回复回到消息来源。开启后不再做会话级绑定过滤，谁能触达完全由 `dmMode` / 白名单 / `requireMention` 决定 |
| `requireMention` | `true` | 群里是否必须 @ 机器人。**群里拉了多个 bot 时必须保持 `true`** —— 设成 `false` 等于不看 @，每条群消息会同时喂给群里所有 bot，多个 agent 一起干活、一起刷屏。只对群生效，私聊不受影响 |

`dmMode` 为 `allowlist` 时，`dmAllowlist` 和 `groupAllowlist` 不能同时为空。

### 绑定哪个会话

| 键 | 默认 | 说明 |
|---|---|---|
| `bindTarget` | `"operator"` | `operator` 私信操作员并绑定该私聊；`code` 终端显示配对码、谁输对谁绑上（**推荐**，见下方「配对码绑定」）；`none` 不主动绑、任意首条消息即绑；`oc_xxx` 直接绑定该群 |
| `operatorOpenId` | `approverAllowlist[0]` | `operator` 档主动私信谁。填 `ou_` 开头的 open_id |
| `pairingTtlMs` | `600000` | 配对码有效期（毫秒）。仅 `code` 档用 |

一个 pi 会话同时只认一个会话 id。绑了私聊之后群里 @ 它只会收到「该 pi 会话已绑定到其他对话」。

### 审批闸门

| 键 | 默认 | 说明 |
|---|---|---|
| `approvalMode` | `"balanced"` | `strict` 除 read/grep/find/ls 外全批；`balanced` 只放行只读命令白名单；`relaxed` 只拦黑名单。详见「审批档位」 |
| `approverAllowlist` | 同 `dmAllowlist` | **谁点卡片的「允许」算数**。飞书 SDK 不对卡片回调做白名单过滤，**任何档位下解析后都不能为空** —— `dmMode: open` 时它是唯一挡住「谁都能批准自己」的东西 |
| `denyPatterns` | `[]` | **仅 relaxed 档**：追加到内置黑名单之上的正则（字符串形式，JSON 里反斜杠写两遍）|
| `allowPatterns` | `[]` | **仅 relaxed 档**：例外，命中即放行，**优先于所有 deny（含内置）** |
| `approvalTimeoutMs` | `120000` | 审批超时，超时即拒绝 |

`denyPatterns` / `allowPatterns` 里的正则在 `/feishu start` 时就编译校验，写错会当场报错 ——
而不是等某条命令恰好走到判定时才炸（那时 fail-closed 会把一切判危险，根因极难定位）。

### 其他

| 键 | 默认 | 说明 |
|---|---|---|
| `autoStart` | `false` | 会话启动时自动连接。**多开 pi 会抢消息** —— 同一个 appId 只有一条长连接，飞书把事件推给哪一条不确定，保持 `false` 更安全 |
| `repoRoot` | 当前 cwd | 判定「写到范围外」的基准 |
| `transport` | `"direct"` | `direct` 会话自己连飞书；`broker` 经本地 broker 进程共用一条长连接，多个会话可共用同一个飞书应用。详见下方「broker 模式」 |
| `brokerSocket` | `<agentDir>/feishu-broker.sock` | 仅 `transport: "broker"` 用到。broker 进程监听的 Unix socket 路径。默认按 `getAgentDir()` 算出，**不是 cwd** —— broker 进程和各 pi 会话必须算出同一个路径才连得上，跨用户/跨 agent 目录部署时要显式填成同一个绝对路径 |
| `autoStartBroker` | `true` | **仅 broker 档**：会话启动时若发现 broker 没在跑就自动拉起。交给 supervisor 托管时设为 `false` |

> direct 模式的完整操作手册见 [`docs/direct.md`](docs/direct.md)：上手、命令、绑定方式、排障、冒烟清单。

## 审批档位

| 档位 | bash 判定模型 | 适用 |
|---|---|---|
| `strict` | 除 read/grep/find/ls 外一律要批 | 完全不信任的环境 |
| `balanced`（默认） | **白名单**：命令名 + 标志都在只读表里才放行 | 日常 |
| `relaxed` | **黑名单**：只拦明确破坏性的命令 | 你信任 agent 与仓库环境时 |

`balanced` 支持管道与 `&&` / `||` / `;` 串联 —— 每一段都必须自己过白名单，
所以 `grep -rn foo . | head -20` 放行，而 `ls | sh` 照样死在 `sh` 上。
重定向（`>` `>>` `<`）和未加引号的 glob 仍一律要批：前者能把任意内容写进任意路径，
后者展开成什么在判定时看不见。

`relaxed` 是**黑名单**模型，与另两档相反 —— 枚举危险必然有漏网，这正是它用便利换来的代价。
它仍然保留 write/edit 的仓库边界检查。

内置黑名单难免误伤（`2>/dev/null` 曾被当成写系统目录、`systemctl show-environment`
曾被当成改服务），所以它是可调的：

```json
{
  "approvalMode": "relaxed",
  "denyPatterns": ["\\bterraform\\s+apply\\b"],
  "allowPatterns": ["\\bkill\\b"]
}
```

- `denyPatterns` **追加**到内置之上，用来加自己的禁忌
- `allowPatterns` 是**例外**，命中即放行，**优先于所有 deny（包括内置）** —— 用来给内置规则开口子
- 两者都是正则的字符串形式，JSON 里反斜杠要写两遍
- 非法正则在 `/feishu start` 时就报错，不会拖到某条命令走到判定时才炸

写得太宽的 `allowPatterns`（比如 `".*"`）会让整道闸门失效，这是你自己的取舍。
`/feishu status` 会显示当前加载了几条自定义规则，可以拿它确认配置生效了。

审批卡片上有三个按钮：**允许** / **本回合全部允许** / **拒绝**。
中间那个只在当前 agent 回合内有效，回合一结束立即失效，不跨回合、不跨会话。
密集操作时点它，省得一条条批。

## 一个 pi 会话配一个 bot

`/feishu start` 成功后按 `bindTarget` 决定绑谁：默认 `operator`，即**主动私信 `operatorOpenId`
并当场绑定那个私聊**，不用你先发消息。绑不上（机器人对你没有可用性、你还没添加它）不会让
start 失败，只是退回等第一条入站消息来绑定。

**要在群里用就别让它绑私聊** —— 一个会话同时只认一个 chatId，绑了私聊之后群里 @ 它只会收到
「该 pi 会话已绑定到其他对话」。群场景把 `bindTarget` 设成群的 `oc_xxx`（启动即绑该群），
或设成 `none` 等你在群里 @ 它时再绑。绑错了用 `/feishu unbind` 解开，不用重启会话。

群里拉多个 bot 时，`mentionedBot` 是拿 mention 的 open_id 跟**该 bot 自己的** open_id 比对的，
所以 @ 哪个 bot 就只有哪个 bot 的 pi 会话响应，不会串台 —— 前提是 `requireMention` 为 `true`。

多个 pi 会话要同时用，**每个会话必须用不同的飞书应用** —— 同一个 appId 开两条长连接，
飞书只把事件推给其中一条，推给哪条不确定，消息会随机丢给某个会话。

按项目分配即可，配置是 `~/.pi/agent/feishu.json` → `<项目>/.pi/feishu.json` 顺序合并、后者覆盖前者：

```
~/.pi/agent/feishu.json      公共部分：approvalMode、requireMention…
project-a/.pi/feishu.json    { "appId": "cli_A", "appSecret": "…", "approverAllowlist": ["ou_A"] }
project-b/.pi/feishu.json    { "appId": "cli_B", "appSecret": "…", "approverAllowlist": ["ou_B"] }
```

**open_id 按应用隔离** —— 同一个人在每个应用下的 open_id 都不同，`approverAllowlist`
必须各填各的。取当前应用下自己的 open_id：

```bash
TOKEN=$(curl -s -X POST https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal \
  -H 'Content-Type: application/json' \
  -d '{"app_id":"cli_xxx","app_secret":"yyy"}' | jq -r .tenant_access_token)
curl -s -H "Authorization: Bearer $TOKEN" \
  'https://open.feishu.cn/open-apis/contact/v3/scopes?user_id_type=open_id' | jq .data.user_ids
```

## broker 模式（`transport: "broker"`）

> 动手操作看 [`docs/broker.md`](docs/broker.md)：上手步骤、supervisor 托管、排障对照表、冒烟清单。

上一节的前提是「一个飞书应用配一个 pi 会话」，根子在于**同一个 appId 只能有一条长连接**，
飞书把事件推给哪条不确定。如果你就是想用**同一个飞书应用**同时服务多个 pi 会话（同一个人
在同一个飞书对话里切换着跟不同项目的会话聊），direct 模式做不到，得换成 broker 模式：
一个独立进程独占那条长连接，各 pi 会话经本地 Unix socket 接上它，收发消息和 chatId ↔ 会话的
路由都交给它。

### 部署方式

broker 是一个不依赖 pi 进程存活的独立可执行入口：

```bash
node bin/broker.ts
# 或作为已安装依赖的 bin 使用：
pi-feishu-broker
```

它读的是跟扩展侧同一套配置文件（`~/.pi/agent/feishu.json` → `<项目>/.pi/feishu.json`），启动时
连接飞书、在 `brokerSocket` 指定的路径监听，打印 `broker 已就绪：<socket 路径>` 后常驻，直到收到
`SIGINT`/`SIGTERM`（`Ctrl-C` 或 `kill`）才会先关 socket 服务端、再断开飞书连接、然后退出。
生产环境建议用 systemd / supervisor 之类的进程管理器托管，随机器重启自动拉起 —— broker 自己
不会自动重连或自愈（见下）。

各 pi 会话侧把 `transport` 配成 `"broker"` 即可，`brokerSocket` 通常不用填：默认按
`getAgentDir()` 算出的路径与 broker 进程一致；如果 broker 进程和 pi 会话跑在不同的 agent 目录
或不同用户下，两边必须显式配成同一个绝对路径，否则连不上。

### socket 权限即鉴权

broker 监听的 socket 文件建出来后立刻 `chmod 0600` —— 这是它**唯一**的鉴权手段：同一 Linux
用户下的进程都能连、其他用户一律连不上。这意味着：

- 同一用户下跑的**任何其他进程**（不限于 pi）只要连得上这个 socket，就能冒充某个已配对的
  pi 会话收发飞书消息、发起审批。broker 模式默认信任「同一用户下的一切都是你自己的」，
  不做更细粒度的进程级鉴权（没有 token，没有 `SO_PEERCRED` 校验）
- 不要在多人共用同一个 Linux 账号的机器上用 broker 模式，除非你能保证同用户下不会跑到别人
  的进程
- 需要保密的是「谁能以这个用户身份跑代码」，socket 路径本身不构成秘密

`send_text` 的收件方**受绑定关系约束**：显式指定的收件会话必须正是本会话已绑的那个，
否则 broker 回 err。少了这一条，`send_text` 就是一个跨会话写入原语 —— 一个从未配对的
连接也能以机器人身份往别人绑定的对话里发消息。

### 卡片审批在 broker 档下的鉴权

与 direct 档共用同一份实现（`approval-card.ts` 的 `handleCardAction`），两层：

- 点击人必须在 `approverAllowlist` 里
- 点击必须来自**这张卡片发往的那个对话** —— 登记未决审批时就把收件会话记下了，
  别的对话里的点击一概不认

direct 档在此之上还多一层：点击必须来自**当前**绑定的会话。broker 档没有这一层，
因为一个 broker 服务多个对话，「当前绑定」是每个 pi 会话各自的概念，不在这一层。

### broker 挂掉会怎样

broker 挂了等于挂在它上面的**所有** pi 会话同时失联，**当前不做自动重连**：

- 客户端网关发现连接断开后，把所有在途请求（发送中的消息、等待中的审批）一律 reject，
  会话侧退回「飞书不可用」
- 断线时会在 pi 的消息区报一条 error（「与 broker 的连接已断开…」），并清掉本地记着的
  绑定关系 —— 不清的话 `/feishu status` 会理直气壮地说「已绑定 oc_x」，而实际上什么都
  发不出去
- 断线后 `/feishu status` 的「传输」一行会显示 `broker · **连接已断开**`，这是判断
  「是 broker 挂了还是飞书那边出问题」最快的一眼
- 新连接不会自动重试；需要人工重新拉起 broker 进程，再在每个受影响的 pi 会话里重新执行
  `/feishu start`（配对关系不保留，要重新走一遍配对码）
- 自动重连、断线重试队列留待后续，目前是纯手工运维

broker **活着但不回帧**（进程被 SIGSTOP、内部卡死）也兜得住：会话侧每个请求有 30 秒上限，
超时即 reject。没有这层上限的话，`Bridge.endTurn()` 会一直等下去，整个 agent 回合冻住，
只能重启 pi。唯一的例外是审批 —— 人点按钮本来就可能更慢，它由 `approvalTimeoutMs` 管。

**不要同时启动两个 broker 进程指向同一个 socket** —— 常见场景是进程管理器重启时旧进程还没
退干净、或者手滑重复起了一个。`listen()` 会先探活：连得上说明有活着的 broker 正占用，直接
报错「该 socket 已被另一个 broker 占用」并拒绝启动，不会把它当成崩溃残留的死文件删掉重建（早
期版本会静默接管，导致旧进程被孤立但仍存活、仍握着飞书长连接——这正是 broker 模式本来要消灭
的「同一 appId 多条长连接抢消息」，在 broker 自己这一层原样复现了一遍）。只有真正连不上
（进程已经退出、文件是崩溃残留）才会当成死文件清理掉。

### `bindTarget` 的限制

broker 模式下 `bindTarget` **只有 `"code"`（配对码）生效**，`operator`、`oc_xxx`、`none`
三档配了也不生效 —— 因为绑定权在 broker 手里：一个飞书 chatId 该路由给哪个 pi 会话，只有
broker 的路由表知道，会话侧没法单方面替它决定绑谁。`/feishu start` 会直接向 broker 要一个
配对码并显示在终端，体验上与 direct 模式下 `bindTarget: "code"` 一致。

因此 broker 档下 `/feishu status` 里的「绑定会话」一栏不会去回显 `bindTarget`（那会说出
「启动时私信操作员绑定」这种根本没发生过的事），统一显示「由 broker 按配对码绑定」。

同理，在飞书里发 `/feishu unbind` **不会自动签发新配对码** —— 签发只能从终端发起。解绑的
回执会明确告诉你下一步是回终端跑 `/feishu pair` 取码，别在飞书里干等「下一条消息自动绑定」，
那在 broker 档下不会发生。

### 该用 direct 还是 broker

| | direct（默认） | broker |
|---|---|---|
| 部署 | 零额外进程，pi 会话自己连 | 需要单独起、管、护一个常驻进程 |
| 一个飞书应用能配几个 pi 会话 | 1 个（长连接不能共用） | 多个，经同一个 broker 共用一条长连接 |
| 某个 pi 会话挂了 | 只影响它自己 | 只影响它自己 |
| broker 挂了 | 不涉及 | 挂在它上面的会话**全部**失联，需人工重启并重新配对 |
| 鉴权 | 飞书侧白名单 + 卡片操作人白名单 | 前两者之外再加一层「同用户即信任」的 socket 权限 |
| 适合场景 | 单会话，或愿意为每个项目配独立飞书应用 | 想用同一个飞书身份服务多个项目/会话，能接受多运维一个进程 |

只有一个 pi 会话用飞书、或不介意一个项目配一个飞书应用时，direct 更简单，出问题的面更小。
真正需要多个会话共用同一个飞书应用时才值得上 broker 模式这份运维成本。

## 配对码绑定（`bindTarget: "code"`）

`none` 档下**任意一条入站消息都会绑定该会话** —— 谁先说话谁就拿到这个 pi 会话的
指令权。配对码把它换成一次显式握手：

1. `/feishu start` 后终端打印一串 8 位配对码
2. 你在**想绑定的那个**飞书对话（私聊或群）里把码发出去
3. 机器人回「配对成功」，该对话即绑定

```
/feishu pair      未绑定时重新签发一个配对码
/feishu unbind    解绑；code 档下会自动签发新码
```

几条性质是刻意的：

- **码只在终端显示，绝不发进飞书** —— 发出去就等于把钥匙挂门上
- **一次性**：用掉即失效，防止同一个码被重放绑到第二个会话
- **有时效**（默认 10 分钟）：终端上残留的旧码不该永远可用
- **重新签发即作废旧码**：否则 unbind 之后旧码还能绑回来
- 待配对期间，非配对码的消息只会收到「请发送配对码」，**不会**绑定
- 字母表剔除了 `0/O/1/I/l`，手机上不会输错

配对码是道安全边界：拿到它的人就能给你的 agent 下指令。别把它贴到群里。

## 飞书应用配置

1. 开放平台创建企业自建应用，开启「机器人」能力
2. 事件订阅选**长连接**方式，订阅 `im.message.receive_v1` 和 `card.action.trigger`
3. 权限：`im:message`、`im:message:send_as_bot`、`im:resource`

## 使用

终端里：

```
/feishu start     启动桥接
/feishu status    查看连接、绑定、策略、审批的完整状态
/feishu unbind    解绑当前会话，下一条消息重新绑定
/feishu stop      停止并解绑
```

飞书里有 `/feishu status`、`/feishu unbind`、`/feishu stop` —— **`start` 只能从终端发起**，建立长连接是拿着终端的人的决定。

首条通过白名单的消息会**绑定**该会话，之后其他对话的消息一律回绝（回执发到发起方那个会话，不是已绑定的那个）。

飞书侧消息前缀 `!` 表示打断当前回合（steer），否则排队到回合结束（followUp）。

## 开发

```bash
npm test          # node:test，无需构建
npm run typecheck
```

Node ≥ 24（依赖原生 TypeScript 类型剥离，无构建步骤）。

## 冒烟测试清单

真实飞书应用 + 真实 pi 会话，逐项验证。

> **先重启 pi 再验。** 扩展是 pi 启动时 import 一次的，改完代码 `/feishu stop` +
> `/feishu start` **不会**重新加载 —— 那只是把网关关掉再打开，跑的还是旧模块。
> broker 档另外还要重启 broker 进程（`node scripts/brokerctl.js restart`），
> 它是独立进程，跟会话各自持有各自的代码副本。不重启就测，看到的是修改前的行为。

- [ ] `/feishu start` 连接成功，`/feishu status` 显示运行中
- [ ] 飞书发一条消息 → pi 收到并开始回合 → 飞书出现流式卡片
- [ ] 卡片里能看到工具行（`⚙️ bash ...` 及 `✓ 耗时`）
- [ ] 回合结束卡片出现 `⏱ 耗时 · token`
- [ ] 让 agent 回一句带重复字母和连续空行的话（例如 `**lnny**`）→ 飞书上一字不差，
      不掉字、不粘连（流式追加的老毛病，见 CLAUDE.md 里那条约束）
- [ ] 终端里自己敲一句 → 飞书同步出现 `> 💻 终端：...` 及后续输出
- [ ] 危险命令（如 `rm -rf /tmp/x`）→ 飞书弹审批卡片
  - [ ] 点「允许」→ 命令执行，卡片变「已批准」
  - [ ] 点「拒绝」→ 命令被拦，卡片变「已拒绝」，正文出现 🚫
  - [ ] 不点，等超时 → 命令被拦，理由含「超时」
  - [ ] 在 TUI 里确认 → 飞书卡片变「已在终端处理」
- [ ] 安全命令（`ls`、`git status`）在 balanced 下**不**弹审批
- [ ] 非白名单账号发消息 → 无响应
- [ ] 绑定后换个会话发消息 → 收到「已绑定到其他对话」
- [ ] 断开网络再恢复 → 日志出现重连并恢复，后续消息仍可用
- [ ] `/new` 重置会话 → 桥接断开；`/feishu start` 可重新绑定
- [ ] 故意填错 `appSecret` → `/feishu start` 报出中文的「飞书连接失败：…」，而不是 pi 的通用错误
- [ ] 故意把 `feishu.json` 写成非法 JSON → 报「不是合法的 JSON」，而不是「缺少 appId」
- [ ] 在飞书里发 `/feishu stop` → **飞书这一侧**能收到「飞书桥接已停止」的回执
- [ ] 群场景：让**不在** `approverAllowlist` 里的成员点「允许」→ 无效，日志出现「忽略非授权审批人」
- [ ] 仓库里建一个指向仓库外的符号链接目录，让 agent 往它下面写新文件 → 弹审批
- [ ] `/feishu stop` 后飞书消息不再进入 pi

### broker 模式（`transport: "broker"`）

同样需要真实飞书应用；额外需要能起一个独立的长驻进程。逐项验证：

- [ ] 终端 1：`node bin/broker.ts`（或 `node --experimental-strip-types bin/broker.ts`，
      或安装后用 `pi-feishu-broker`）→ 打印 `broker 已就绪：<socket 路径>`
- [ ] 终端 2：`stat -c '%a' <socket 路径>` → 输出 `600`
- [ ] 项目 `.pi/feishu.json` 配 `transport: "broker"` 后启动 pi、跑 `/feishu start` →
      终端打印配对码；在要绑定的飞书对话里发送该码 → 收到「配对成功」
- [ ] 两个不同项目（或同一项目开两个终端）的 pi 会话都配同一个飞书应用 + `transport: "broker"`，
      分别用各自的配对码绑到两个不同的飞书对话 → 分别发消息，各回各的，不串台
- [ ] broker 模式下把 `bindTarget` 配成 `"operator"` 或某个 `oc_xxx` → 确认它被忽略，
      `/feishu start` 仍然走配对码流程
- [ ] 已配对的会话里跑 `/feishu status` → 「传输」一行显示 `broker · 已连接 · <socket 路径>`，
      「绑定会话」一栏说的是「由 broker 按配对码绑定」（不是 `bindTarget` 的原值）
- [ ] 在飞书里发 `/feishu unbind` → 回执明确说要回终端跑 `/feishu pair` 取码，
      而不是「下一条消息会重新绑定会话」
- [ ] 终端 1 按 `Ctrl-C` 停掉 broker 进程 → 已配对的 pi 会话再发消息应提示「飞书不可用」
      （不会自动重连）；pi 的消息区出现一条「与 broker 的连接已断开…」
- [ ] 停掉 broker 之后跑 `/feishu status` → 「传输」一行显示「连接已断开」，
      「绑定会话」不再显示旧的 chatId
- [ ] 未配对的会话里跑一个长回合（不要发配对码）→ broker 的 stderr 里每个流 id 只出现
      **一条**「收到未知流的 stream_chunk」，不是每个 delta 一条
- [ ] 已配对的会话里跑一个会输出很多内容的长回合，中途让飞书流式失败（例如临时断网几秒）
      → broker 进程**不退出**，回合结束后飞书里收到补发的全文
- [ ] 重新拉起 broker、在受影响的 pi 会话里重新跑 `/feishu start` → 恢复正常，需要重新配对
- [ ] 配置缺失（没有 `appId`/`appSecret`）时执行 `node bin/broker.ts` → 报出中文的
      「缺少 appId（配置文件 appId 或环境变量 FEISHU_APP_ID）」之类的问题清单，退出码非零
      （这一条不需要飞书凭据，随时可以自己跑）
