# pi-feishu

把当前 pi 会话桥接到飞书：终端上开的头，手机上接着聊。带流式输出、工具可见性和危险操作审批。

## 安装

```bash
pi install /path/to/pi-feishu     # 本地
pi install git:github.com/you/pi-feishu
```

## 配置

配置按 `~/.pi/agent/feishu.json` → `<项目>/.pi/feishu.json` → 环境变量的顺序合并，后者覆盖前者。

```json
{
  "appId": "cli_xxx",
  "dmAllowlist": ["ou_your_open_id"],
  "approvalMode": "balanced",
  "autoStart": false
}
```

密钥走环境变量：`FEISHU_APP_ID`、`FEISHU_APP_SECRET`。

| 键 | 默认 | 说明 |
|---|---|---|
| `appId` / `appSecret` | 必填 | 飞书应用凭据 |
| `autoStart` | `false` | 会话启动时自动连接。**多开 pi 会抢消息，保持 false 更安全** |
| `dmAllowlist` | `[]` | 允许单聊的 open_id |
| `groupAllowlist` | `[]` | 允许的群 chat_id |
| `requireMention` | `true` | 群聊是否需要 @ 机器人 |
| `approvalMode` | `"balanced"` | `balanced` 只拦破坏性操作；`strict` 所有 bash/write/edit 都要批 |
| `approvalTimeoutMs` | `120000` | 审批超时，超时即拒绝 |
| `repoRoot` | 当前 cwd | 判定「写到范围外」的基准 |

`dmAllowlist` 和 `groupAllowlist` 不能同时为空。

## 飞书应用配置

1. 开放平台创建企业自建应用，开启「机器人」能力
2. 事件订阅选**长连接**方式，订阅 `im.message.receive_v1` 和 `card.action.trigger`
3. 权限：`im:message`、`im:message:send_as_bot`、`im:resource`

## 使用

```
/feishu start     启动桥接
/feishu status    查看连接与绑定状态
/feishu stop      停止并解绑
```

首条通过白名单的消息会**绑定**该会话，之后其他对话的消息一律回绝。

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
- [ ] `/feishu stop` 后飞书消息不再进入 pi
