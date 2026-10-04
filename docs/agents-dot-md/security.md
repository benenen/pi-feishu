# 安全与审批
> 风险三档、外发准入、herdr 控制工具及卡片点击鉴权。

## 安全闸门一律 fail-closed
- `assessRisk` 抛错 → 按危险处理（`gateToolCall` 里有 try/catch，因为 async 函数的
  未捕获异常会变成 rejected promise 直接跳过 block 契约，结果是危险工具被放行）
- 审批超时 / 所有通道都挂 / 没有通道 → 一律拒绝
- 会话结束时所有未决审批一律拒绝，并把卡片收到终态

## 外发通道没有「默认放行」档
`feishu_send_image` 把本地文件送出这台机器，与写文件/跑命令不是一类风险：后两者坏在
「改坏了本地」，它坏在「发出去就收不回来」。所以它在 `risk.ts` 里单列 `EXFIL_TOOLS`，
**三个档位都判 risky**，`relaxed` 的 `allowPatterns` 也放不开它（那组只对 bash 生效）。

再往这个方向加工具（发文件、发日志、贴代码到外部）时照此办理：进 `EXFIL_TOOLS`，
别指望 `assessRisk` 末尾那句 `return "safe"`。

路径准入只有 `image.ts` 的 `gateImagePath` 一处，判完读成 Buffer 再递给网关。
**不要把路径直接交给 SDK** —— `MediaUploader` 有它自己的一套 `allowedFileDirs`
黑白名单，与本扩展的 `imageDirs` 不是一回事，两套并存就是两套各说各话的闸门。

## `/herdr` 是绕开审批闸门的第二条执行通道，必须单独设门
派给 herdr 里 claude/codex 的一句话，对方在里面跑什么、跑在哪里，`approvalMode`
一个字都看不见 —— 这条通道**不经过 pi 的 `tool_call` 钩子**。反过来，pi 侧的 herdr 工具
（`herdr_send_prompt` / `herdr_start_agent` / `herdr_stop_agent` / `herdr_send_keys`）
也会绕过默认那句 `return "safe"`，所以它们在 `risk.ts` 里单列 `HERDR_CONTROL_TOOLS`，
**三个档位都判 risky**（只读的 list/read/wait 不在此列）。往这个方向加工具照此办理。

飞书侧的 `/herdr` 只对 `approverAllowlist` 里的人生效（`msg.senderId`）——
群场景下不这么拦，任何能 @ 机器人的群友都拿到了一条不用审批的后门。
选 agent 卡片的点击同样三层鉴权（操作者名单 + 逐卡会话绑定 + 单会话档的绑定校验），
复用 `approval-card.ts` 的 `CardActionLike` / `CardSettlement` 与
`FeishuGateway.onCardAction`，**不要在网关里给第二类卡片另起一套鉴权**。

## 卡片点击必须自己鉴权
飞书 SDK 只对 `im.message.receive_v1` 走完整的策略管道；`card.action.trigger`
**只有去重和串行化，没有任何白名单过滤**。所以 cardAction handler 自己校验，
三层，缺一不可：

1. `operator.openId ∈ approverAllowlist` —— 防「群里任何看得见卡片的人都能点允许」，
   任何档位下都不能少
2. **逐卡的会话绑定**：卡片发往哪个对话，就只认那个对话里的点击。由 registry 在
   `settle` 那层强制，任何调用方绕不过去
3. `requireBoundChat`（点击必须来自**当前**绑定会话）—— **只在单会话档开**。
   multiChat 下卡片是故意发到触发这轮的那个对话的（可能是群），而 bound 还留在
   私聊，开着它群里的卡片谁都点不动，审批直接死锁到超时。它也是三层里最弱的一层：
   第 2 层比它更准。

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
