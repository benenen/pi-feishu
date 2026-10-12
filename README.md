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

配置键按用途分组如下。

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
| `approvalMode` | `"balanced"` | `strict` 除 read/grep/find/ls 外全批；`balanced` 只放行只读命令白名单；`relaxed` 只拦黑名单；`auto-except-delete` 只拦删除文件。详见「审批档位」 |
| `approverAllowlist` | 同 `dmAllowlist` | **谁点卡片的「允许」算数**。飞书 SDK 不对卡片回调做白名单过滤，**任何档位下解析后都不能为空** —— `dmMode: open` 时它是唯一挡住「谁都能批准自己」的东西 |
| `denyPatterns` | `[]` | **仅 relaxed 档**：追加到内置黑名单之上的正则（字符串形式，JSON 里反斜杠写两遍）|
| `allowPatterns` | `[]` | **仅 relaxed 档**：例外，命中即放行，**优先于所有 deny（含内置）** |
| `approvalTimeoutMs` | `120000` | 审批超时，超时即拒绝 |

`denyPatterns` / `allowPatterns` 里的正则在 `/feishu start` 时就编译校验，写错会当场报错 ——
而不是等某条命令恰好走到判定时才炸（那时 fail-closed 会把一切判危险，根因极难定位）。

### 其他

| 键 | 默认 | 说明 |
|---|---|---|
| `toolWaitMs` | `10000` | 工具同步等待期限（毫秒），超过后交给独立 watcher，完成后由 agent 总结再回原飞书会话；不是执行超时，需 pi 核心补丁 |
| `autoStart` | `false` | 会话启动时自动连接。**多开 pi 会抢消息** —— 同一个 appId 只有一条长连接，飞书把事件推给哪一条不确定，保持 `false` 更安全 |
| `repoRoot` | 当前 cwd | 判定「写到范围外」的基准，也是 `feishu_send_image` 默认允许的发图范围 |
| `imageDirs` | `[]` | 除仓库根外，还允许 `feishu_send_image` 发图的目录。相对路径按 cwd 展开。**空数组是「只允许仓库内」，不是「不限」** —— 与 `groupAllowlist` 相反，那边放宽的是谁能找机器人说话，这边放宽的是什么文件能离开这台机器 |

### herdr 并行派活

| 键 | 默认 | 说明 |
|---|---|---|
| `herdrBin` | `HERDR_BIN` → `PATH` | `/herdr` 用的 herdr 二进制。不填就按环境变量 → `PATH` 找 |
| `herdrDefaultAgent` | 无 | 还没 `/herdr use` 过时，本对话默认派给哪个 agent。不填时从已有空闲 agent 中按任务相关性选择；没有可用目标就报错，不自动新建 |
| `herdrTaskTimeoutMs` | `3600000` | 单个任务最多等多久（毫秒）。到点仍在跑就回报「还在跑」，不无限挂着 |

> direct 模式的完整操作手册见 [`docs/direct.md`](docs/direct.md)：上手、命令、绑定方式、排障、冒烟清单。

## 审批档位

| 档位 | bash 判定模型 | 适用 |
|---|---|---|
| `strict` | 除 read/grep/find/ls 外一律要批 | 完全不信任的环境 |
| `balanced`（默认） | **白名单**：命令名 + 标志都在只读表里才放行 | 日常 |
| `relaxed` | **黑名单**：只拦明确破坏性的命令 | 你信任 agent 与仓库环境时 |
| `auto-except-delete` | **黑名单，只拦删除文件**：`rm`/`rmdir`/`shred`/`unlink`/`truncate`/`find -delete`/`git rm`/`rsync --delete` 仍要批，其余全放行 | 只想拦住不可逆的删除时 |

`auto-except-delete` 比 `relaxed` 还宽一档：它连 `relaxed` 都拦的那批也放行
（`sudo` / `chmod` / `git push` / `curl | sh` / 往仓库外写文件），**也放行
`feishu_send_image` 与 herdr 控制工具** —— 这两组在其余三档都要人点头。
它同样基于结构化解析，判不出 argv 时（glob、`$` 展开、拿不到命令）退回在原始串上扫
`rm|rmdir|shred|unlink|truncate`，宁可多弹一次卡片。
黑名单必然有漏网（`shred` 之外的覆写工具、自定义 MCP 删除工具），这是它的代价。

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

当前回合所在的**同一会话、同一话题**里的消息前缀 `!` 表示立即打断（steer）；同群的
另一个话题也不能插队。其他普通消息会等当前请求彻底结束后单独开启新回合和新卡片；
每张卡顶部带对应的飞书问题原文，避免连续提问时后一个答案只更新上方旧卡片、聊天底部
看起来没有回复。

### 话题（thread）

在**话题群**里 @ 机器人，回复会落回你提问的那个话题里 —— 正文流、补发的全文、审批卡片、
`/feishu status` 之类的回执，全都跟着走。

判定只看一件事：**触发这轮的那条消息有没有 `threadId`**。

- 有 → 出站以「回复那条消息 + `reply_in_thread`」的方式发（走 `im.v1.message.reply`）
- 没有 → 照旧直接发进会话（走 `im.v1.message.create`）

所以普通群和私聊的行为**一个字节都没变**。这条判定不能改成「一律按话题发」——
普通群里那样会把每条回答都变成一个新话题。

### 发图片：`feishu_send_image`

桥接启动后，agent 多一个工具 `feishu_send_image(path)`，把本地图片作为**图片消息**发进当前对话 ——
对方直接看到图，不是链接（内网链接对方打不开，这正是它存在的理由）。典型用途是把浏览器截图发过去。

三道闸门，缺一不可：

1. **目录白名单** —— 只能发仓库根内、或 `imageDirs` 列出的目录下的文件，**软链按 realpath 判定**，
   白名单目录里放个指向 `/etc` 的软链也带不出去
2. **文件头识别** —— 按魔数认 png / jpeg / gif / bmp / webp，把 `/etc/shadow` 改名成 `.png` 不好使
3. **人工审批** —— 工具名在 `risk.ts` 的 `EXFIL_TOOLS` 里，**除 `auto-except-delete` 外任何审批档位都要人点头**，
   包括 `relaxed`（`allowPatterns` 只对 bash 生效，放不开它）

写文件、跑命令坏在「改坏了本地」，发图坏在「发出去就收不回来」—— 所以这条通道没有「默认放行」档。

飞书单图上限 10MB。

## 长工具转后台

支持 pi **1.0.2**。在扩展仓库安装依赖后，应用公共工具执行点补丁：

```bash
npm install
npm run patch:pi
npm run patch:pi -- --check
```

脚本会同时检查本地依赖及 PATH 中的 pi 安装，修改核心模块和真实 CLI bundle，
保留 `.pi-feishu-background.bak` 备份；可以用 `npm run patch:pi -- --restore` 回滚。
其他版本会明确拒绝修改。升级或重新安装 pi 后须重新应用补丁。
**应用补丁后重启 pi**，再启动飞书桥接；仅 `/feishu stop` + `start` 不会加载新代码。
未加载补丁时会明确提示，工具继续按原来的同步方式执行。

bash、herdr、MCP 和其他扩展工具共用这条链路：工具先经过原有参数校验和审批，
在 `toolWaitMs` 内完成就返回原结果；超过期限则立即给模型后台登记回执，释放当前运行。
独立 watcher 继续等实际执行，完成或失败后把结果交给 pi **另开回合总结**。pi 正忙时，
总结任务与普通消息一起排队，等 `agent_settled` 后启动；不会并入正在运行的旧卡片。
总结卡片抬头显示对应的原始问题，正文先点明这条请求，再给结论、关键事实和来源链接，并如实说明失败或未完成情况，
发回调用时的原飞书对话/话题。用户不会收到原始日志、JSON 或 `call_...` 内部编号。
不要重复提交或轮询同一个后台任务；依赖结果的步骤需要等总结消息后再继续。

总结复用当前 pi 的模型配置。原始结果作为内部资料，文本或结构化 JSON 都可提供；
超过 24000 个字符时保留头尾并注明中间被截断，不把资料原样发给用户。
无飞书目标的工具继续同步执行。最多同时执行 16 个被管理的工具；停止桥接时发出取消信号，
晚到结果不再发送。第三方工具如果忽略取消信号，其实际工作可能仍在继续。

### 终端后台任务状态

TUI 状态栏显示 `background N [名称…] · watcher M [名称…]`。
输入框下方展示完整 Background / Watcher 列表，包含工具或 herdr 目标名、任务说明、
已运行时间与「等待工具完成／等待 agent 落地／提交总结」阶段。

短工具在同步等待阶段不会冒充后台任务；达到等待期限转后台后才入列表。
状态变化即时刷新，活动期间耗时每秒更新；完成、取消、停止桥接或切换会话时移除列表并清理刷新定时器。
这项显示通过 `setStatus` 和 `belowEditor` widget 接入，兼容已有 footer（包括 pi-usage）；
完整列表不受 footer 单行截断影响。headless / RPC 模式不启动终端状态刷新。

## 用 `/herdr` 并行派活

把活派给 [herdr](https://herdr.dev) 里的**其它 agent**（pi / claude / codex …），
自己这边的 pi 该干嘛干嘛。每个任务挂在各自的 agent 面板上，**完成时间互不影响** ——
这就是并行：三个 agent 同时做三件事，谁先做完谁先回。

```
/herdr                     列出所有 agent（卡片上直接点选）
/herdr use lnny            选定本对话默认派给谁
/herdr run 修一下登录页     派给选中的 agent（/herdr <任务> 同义）
/herdr task zgy 写测试      直接派给指定 agent，不改默认选择
/herdr new claude 审一下diff 新开一个 claude agent 并派活
/herdr status              本对话正在等哪些任务
/herdr read lnny           现在读一段它的输出
/herdr send lnny 继续      往它里面补一句话
/herdr keys lnny esc       送逻辑按键（ctrl+c / esc / enter），卡在选择框上时用
/herdr watch lnny          给一个已经在跑的 agent 补一个 watch
/herdr cancel ab12cd34     停止等待（不打断 agent 本身）
/herdr stop lnny           关掉它的 pane（终止它）
/herdr help                命令速查
```

默认复用现有 agent，只有用户明确要求新建（例如 `/herdr new`）才创建。新建工具的 `cwd`
使用用户指定的目录，未指定时使用用户主目录 `~`，不继承当前仓库。

模型调用 herdr 工具时，`target` 必须复制 `herdr_list_agents` 输出中的值。没有注册名字的 agent 用 pane id（如 `w2:p3`）；工作区标签、目录名和终端标题不能作为 target。

流程就是「发消息 → 选 agent → 开始执行 → 加 watch → 结果自己回来」：

1. `/herdr`（或 `/herdr list`）弹一张卡片，点一个 agent 选定
2. `/herdr run <任务>` 派活，立刻回一条回执（带 watch 编号）
3. 后台 watch 等它落地（`idle` / `done` / `blocked`）
4. 落地后交给 pi 独立总结，再把**总结**发回这个对话

pi agent 的结果优先从它的会话文件里抽**最后一条 assistant 回复**（干净），
claude / codex 这类没有会话文件可读的就退回面板输出。`blocked`（在等你回话）
会单独提示：可以先 `/herdr keys <agent> enter` 或 `/herdr send <agent> <回答>`，
答不了就切到 herdr 面板直接操作。

几条刻意的设计：

- **同一个 agent 上只挂一个任务**：它是一块终端面板，两句话同时塞进去会在里面打架。
  再派会被拒，换一个 agent 或等它完成。不同 agent 之间完全并行。
- **派活不经过 pi**：走本地处理直接指挥 herdr。若经 pi，所有任务会排进同一个 agent
  运行，「一次 `agent_start` = 一条飞书流」也意味着并行无从谈起。
- **到点仍在跑就回报「还在跑」**，不谎报完成，也不无限挂着。
- 结果发回**触发这条命令的那个话题**（与正常回复同一套话题规则）。

### 权限：`/herdr` 只对审批人开放

这条通道**绕过 pi 的审批闸门** —— 派给 claude agent 的一句话，在里面跑什么、
跑在哪里，`approvalMode` 一个字都看不见。所以它是单独的一条门：

- 只有 `approverAllowlist` 里的人能派活，其他人发 `/herdr` 只会收到拒绝
- 卡片点击同样三层鉴权（操作者名单 + 逐卡会话绑定 + 单会话档的绑定会话校验），
  `card.action.trigger` 在飞书 SDK 里**没有任何白名单过滤**，不自己判就是群友随便点

另外 pi 侧的 herdr 工具（`herdr_send_prompt` / `herdr_start_agent` / `herdr_stop_agent` /
`herdr_send_keys`）也单列进 `risk.ts`，**除 `auto-except-delete` 外任何审批档位都要人点头**，与 `feishu_send_image` 同理。
只读的 `herdr_list_agents` / `herdr_read_agent` 在 balanced 档免批。

> 还没装 herdr？用不到这一节。没有 herdr 时 `/herdr` 会明确报「找不到 herdr」，
> 其余功能完全不受影响。

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

- [ ] `/feishu start` 连接成功，`/feishu status` 显示运行中
- [ ] 飞书发一条消息 → pi 收到并开始回合 → 飞书出现流式卡片，顶部显示对应问题原文
- [ ] 当前回合未结束时在同一对话再发一问 → 收到排队回执，之后出现第二张独立卡片
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
- [ ] `/herdr` 弹 agent 卡片，点一个 → 卡片变「已选定 …」；非审批人点 → 无反应
- [ ] `/herdr run <任务>` → 回执带 watch 编号 → 任务完成后结果发回本对话
- [ ] 同一个 agent 上再 `/herdr run` → 被拒（提示已在等）
- [ ] 两个不同 agent 上各派一个 → 两边各自回结果，互不等待
- [ ] `/herdr status` 列出在等的任务；`/herdr cancel <id>` 之后不再回结果
- [ ] herdr 里给 agent 回一句「需要确认」类的话（blocked）→ 飞书收到「在等你回复」提示
- [ ] 非审批人发 `/herdr` → 收到「没有派活权限」
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
