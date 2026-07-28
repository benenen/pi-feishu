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

一共 16 个键，按用途分四组。

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

真实飞书应用 + 真实 pi 会话，逐项验证：

- [ ] `/feishu start` 连接成功，`/feishu status` 显示运行中
- [ ] 飞书发一条消息 → pi 收到并开始回合 → 飞书出现流式卡片
- [ ] 卡片里能看到工具行（`⚙️ bash ...` 及 `✓ 耗时`）
- [ ] 回合结束卡片出现 `⏱ 耗时 · token`
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
