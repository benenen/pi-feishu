# broker 模式操作手册

README 里那节讲的是「为什么这么设计」，这份讲「怎么用」。

## 先判断你需不需要它

| 你的情况 | 用哪个 |
|---|---|
| 同一时刻只有一个 pi 会话用飞书 | **direct**（默认），别装 broker |
| 多个项目，愿意各配一个飞书应用 | **direct**，一项目一应用 |
| 多个 pi 会话要共用**同一个**飞书应用/机器人 | **broker** |

direct 模式做不到最后一种，根子在飞书：**同一个 appId 只能有一条长连接**，多开就抢消息，
而且飞书把事件推给哪条连接是不确定的。broker 的全部意义就是把那条唯一的连接拿出来独占，
再按 chatId 分发给各个会话。

代价是多养一个常驻进程，且它挂了所有会话一起失联。**只有一个会话用飞书时上 broker 是纯亏。**

## 五分钟上手

### 1. 起 broker

```bash
cd /root/workspace/master/pi-feishu
node bin/broker.ts
```

看到这行就是好了：

```
[broker][info] broker 已就绪：/root/.pi/agent/feishu-broker.sock
```

它读的配置跟扩展侧是同一套（`~/.pi/agent/feishu.json` → `<项目>/.pi/feishu.json`），
所以 appId / appSecret / 白名单这些不用重复配。

配置有问题会当场以非零码退出并列出全部问题，不会带着半吊子状态跑起来。

### 2. 让 pi 会话走 broker

在要接飞书的那个项目里建 `<项目>/.pi/feishu.json`：

```json
{ "transport": "broker" }
```

其余键继承 `~/.pi/agent/feishu.json`。`brokerSocket` 通常不用填 —— 两边都按
`getAgentDir()` 算，默认都是 `/root/.pi/agent/feishu-broker.sock`。

> 只有当 broker 和 pi 会话跑在**不同的 agent 目录或不同用户**下时，才需要在两边都显式写
> 同一个绝对路径，否则连不上。

### 3. 配对

在该项目的 pi 会话里：

```
/feishu start
```

终端会打出：

```
飞书桥接已启动（broker 模式）。在要绑定的对话里发送配对码：

    6RYXSZSS
```

把这串码发到你想绑的飞书对话（私聊或群都行），机器人回「配对成功」即完成。
**在哪个对话里发，就绑哪个对话。**

第二个、第三个会话重复第 2、3 步即可 —— 各拿各的码，绑各自的对话，共用同一个 bot。

## 用 supervisor 托管

broker 自己不会重连也不会自愈，生产上交给进程管理器。

`/etc/supervisor/conf.d/pi-feishu-broker.conf`：

```ini
[program:pi-feishu-broker]
command=/usr/bin/node /root/workspace/master/pi-feishu/bin/broker.ts
directory=/root/workspace/master/pi-feishu
user=root
autostart=true
autorestart=true
startsecs=5
stopwaitsecs=15
stopsignal=TERM
stdout_logfile=/var/log/pi-feishu-broker/out.log
stderr_logfile=/var/log/pi-feishu-broker/err.log
stdout_logfile_maxbytes=10MB
stderr_logfile_maxbytes=10MB
```

```bash
mkdir -p /var/log/pi-feishu-broker
supervisorctl reread && supervisorctl update
supervisorctl status pi-feishu-broker
```

`stopsignal=TERM` 是必须的 —— broker 接 `SIGTERM` 会先关 socket 服务端、再断飞书连接、
再退出。用 `KILL` 会留下一个 socket 文件（下次启动会探活、发现是死文件后自动清理，
所以不至于起不来，但没必要）。

`startsecs=5` 给飞书连接留出握手时间；连不上飞书时进程会挂在那里等，别设太短导致反复重启。

## 日常操作

| 想做什么 | 怎么做 |
|---|---|
| 看某个会话的状态 | 在 pi 里 `/feishu status`，「传输」一行会写 `broker` 还是 `direct` |
| 换绑到别的对话 | `/feishu unbind` → 回终端 `/feishu pair` 取新码 → 在新对话里发 |
| 重新取一个配对码 | 终端 `/feishu pair`（未绑定时才有效） |
| 加一个新会话 | 该项目建 `.pi/feishu.json` 写 `transport: "broker"`，`/feishu start` 取码 |
| 临时改回直连 | 把该项目的 `transport` 删掉或改成 `"direct"`，重启桥接 |
| 停 broker | `supervisorctl stop pi-feishu-broker`，或前台 `Ctrl-C` |

**注意：配对关系不持久化。** broker 重启后所有会话都要重新 `/feishu start` 走一遍配对。

## 排障

| 症状 | 原因 | 处置 |
|---|---|---|
| `/feishu start` 报「飞书连接失败：connect ENOENT …sock」 | broker 没起，或 socket 路径两边对不上 | 先确认 broker 在跑；再核对两边算出来的 `brokerSocket` 是否同一个 |
| 启动时报「该 socket 已被另一个 broker 占用」 | 已经有一个 broker 活着 | 这是**保护**不是故障。`supervisorctl status` 找到在跑的那个，别再起第二个 |
| `/feishu status` 显示 `broker · 连接已断开` | broker 挂了或被停了 | 拉起 broker，然后在**每个**受影响的会话里重新 `/feishu start` 并重新配对 |
| 会话侧一直报「飞书流式发送失败」 | 多半是 broker 掉了 | 先看 `/feishu status` 的「传输」一行，它能一眼分清是 broker 掉了还是飞书那边的问题 |
| 在飞书里输了配对码没反应 | 码过期（默认 10 分钟）、或输到了别的 bot | 终端 `/feishu pair` 重新取码；确认发给的是配置里那个 appId 对应的机器人 |
| 飞书里发 `/feishu unbind` 后干等着没有新码 | 设计如此 | 签发只能从终端发起，回终端跑 `/feishu pair` |
| 某会话收不到消息但 status 说「已绑定」 | 该 chatId 被另一个会话抢绑了 | 被顶掉的会话会收到 `unbound`；重新配对即可 |
| broker 日志刷「孤儿 stream_chunk」 | 会话在未绑定状态下跑了回合 | 正常提示，配对后消失；每个流最多刷 64 条 |

看 broker 日志：

```bash
supervisorctl tail -f pi-feishu-broker stderr
# 前台跑的话直接看终端
```

## 边界与已知限制

**鉴权只有一层：socket 文件 `0600`。** 同一 Linux 用户下的**任何**进程都能连上这个 socket，
冒充某个已配对的 pi 会话收发消息、发起审批。broker 模式默认信任「同用户即自己人」，
没有 token、没有 `SO_PEERCRED` 校验。**别在多人共用同一个 Linux 账号的机器上用。**

**没有自动重连。** broker 挂了，会话侧把在途请求全部 reject、清掉本地绑定、在消息区报一条
error，然后就停在那里等人。重连、重试队列都留待后续。

**broker 活着但卡死也兜得住。** 会话侧每个请求 30 秒上限，超时即 reject —— 没有这层的话
`Bridge.endTurn()` 会一直等，整个 agent 回合冻住只能重启 pi。审批是例外，由
`approvalTimeoutMs` 管（人点按钮本来就可能慢）。

**`bindTarget` 只有 `"code"` 生效。** `operator` / `oc_xxx` / `none` 三档配了也不起作用 ——
绑定权在 broker 的路由表手里，会话侧没法单方面决定绑谁。

## 已知遗留项

整支分支终审时明确判为「可下一波处理」的三条，记在这里以免丢失：

**1. 换绑后旧审批卡片仍可兑现。** 会话绑着 chat X 时弹出的审批卡片，在改绑到 chat Y 之后，
X 里那张旧卡片**仍可**被 `approverAllowlist` 里的人点「允许」并生效。`ApprovalRegistry` 现在
按 chatId 登记，但这张卡片本来就发往 X、来自 X 的点击与登记一致，所以挡不住。

风险边界是清楚的：仅限**已授权的审批人**、且仅限该会话**曾经绑过**的对话 —— 不是权限外溢。

最小修法不是「解绑时撤销全部未决审批」，而是**登记时一并记下发起 ask 的连接 id，settle 时
复查 `registry.boundChatOf(connId) === event.chatId`** —— `broker/server.ts` 在那个位置已经
拿得到这个值。

**2. `server.ts` 的 `#send(displaced, {t:"unbound"})` 当前不可达。** `deliver()` 会先命中
`byChat` 直接投给 owner，轮不到 `matchCode` 分支。`registry.bind()` 返回被顶掉会话 id 这个
契约本身是对的且有真测试，所以代码该留而不是删 —— 它是给将来放开「已绑对话内换绑」时的
防御。但调用点缺一句注释说明这一点，目前只写在测试注释里。

**3. `#dispatch` 的 docstring 措辞不精确。** 写的是「带 id 的请求必须收到 ok/err 之一」，
但 `stream_begin` 的成功路径刻意不回响应（响应挂在 `stream_end` 的同 id 上）。客户端不 await
它，不会挂起，但注释该说清楚这个例外。

## 冒烟清单

改动涉及 broker 时照着走一遍（需要真实飞书应用）：

- [ ] `node bin/broker.ts` 打印「broker 已就绪」
- [ ] `stat -c '%a' /root/.pi/agent/feishu-broker.sock` → `600`
- [ ] 再起一个 broker → 报「已被另一个 broker 占用」并拒绝启动，第一个不受影响
- [ ] 会话 A `/feishu start` → 终端出配对码 → 在对话 X 发码 → 回「配对成功」
- [ ] 在 X 里发消息 → A 收到并开始回合 → 流式卡片正常
- [ ] 会话 B 重复上述，绑对话 Y → **A 与 B 互不串台**
- [ ] 危险命令 → 弹审批卡片 → 点「允许」生效、点「拒绝」被拦
- [ ] 非 `approverAllowlist` 成员点卡片 → 无效，日志出现「忽略非授权审批人」
- [ ] `Ctrl-C` 停 broker → 两个会话的 `/feishu status` 都显示「连接已断开」
- [ ] 重启 broker → 两个会话各自重新 `/feishu start` + 配对 → 恢复正常
