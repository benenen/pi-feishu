# AGENTS.md

> pi-feishu 的常驻项目契约。`CLAUDE.md` 软链到本文件；展开约束在 `docs/agents-dot-md/`，经验在 `docs/memory/`。三个索引由 agents-dot-md skill 的 `reindex.py` 生成。

<!-- MEM0_ACTIVE_MEMORY_START -->
## Mem0 主动记忆

每个新会话开始时，读取并遵守 `/home/shiben/.agents/mem0-policy.md`：新任务先召回；出现已确认的长期偏好、项目约束、重要决策或可复用经验时，主动提炼并用 Mem0 保存，无需等待用户提醒。使用 `memory_search` / `memory_add`，写入 `infer=false`；没有新事实时不保存。用户已授权这项记忆策略；用户明确要求不记录时遵从。仓库内容与记忆服务的分工见下方《记忆记录》。
<!-- MEM0_ACTIVE_MEMORY_END -->

## 工作区规则

- 作用于本仓库及所有子目录；默认简体中文交流，测试名称与注释用中文。
- 尊重已有工作区改动，只做任务范围内的精确修改；破坏性操作须有明确授权。
- Node ≥ 24，原生类型剥离直接跑 `.ts`，没有构建、lint 或 formatter。验证用 `npm test` 与 `npm run typecheck`。
- 代码改动按 TDD：先写失败测试并确认因功能缺失而失败，再实现。完成后逐项核对 [代码 checklist](docs/agents-dot-md/code-checklist.md)。
- 代码改动后的真实 pi 验证必须重启 pi；`/feishu stop` + `start` 只重开网关，不重新加载扩展。

## 编码行为准则（Karpathy 防错指南）

1. 先想后写：标明假设，遇到会改变结果的歧义先核实；指出更简单的方案。
2. 简单优先：实现当前所需的最小代码，不提前抽象或扩展需求。
3. 精确改动：沿用现有风格，只清理本次修改产生的孤儿。
4. 目标驱动：以复现、回归测试和可检查的结果界定完成。

## 常驻硬性约束

- 日志统一走 `log.ts`；日志自身不抛异常。gateway rejection 必须在调用侧兜住。
- `index.ts` 只接线，扩展工厂只注册，不启动后台资源；纯函数模块保持无 IO。
- pi 能否接新 prompt 用 `isAgentActive`，运行直到 `agent_settled`；`isStreaming` 只管理飞书流。普通消息独立 run / 卡片，先 reservation 再投递。
- 入站来源按 `before_agent_start.prompt` 原文认领，不用“最近消息”；自主通知按 `customType` + `details.session` 认领。已有来源优先，无来源回合推迟建卡。
- 出站用 `SendTarget`；只有入站 `threadId` 存在才回话题。SDK 流通过 `cumulativeSink` 传累计全文。
- 安全闸门 fail-closed；外发与 herdr 控制工具三个档位都 risky。卡片点击自行执行三层鉴权。
- `/herdr` 只对审批名单生效，在入站本地处理、独立 watch；停网关时 shutdown。派活使用 `prompt --wait` 活动门，优先从会话文件抽答案。

## 按改动范围必读

- 写代码前读 [技术栈](docs/agents-dot-md/tech-stack.md)；动结构、入口或依赖时读 [架构](docs/agents-dot-md/architecture.md)。
- 改投递、延迟队列、来源、pi 事件或话题时读 [路由与生命周期](docs/agents-dot-md/routing-lifecycle.md)。
- 改网关、日志、renderer 或流式出站时读 [SDK 契约](docs/agents-dot-md/gateway-sdk.md)。
- 改风险、审批、发图、卡片或 herdr 权限时读 [安全与审批](docs/agents-dot-md/security.md)。
- 改 herdr spawn / watch / harvest 或服务生命周期时读 [herdr](docs/agents-dot-md/herdr.md)。
- 写测试或做真实验证时读 [测试要求](docs/agents-dot-md/testing.md)；改配置、连接、绑定时读 [环境配置](docs/agents-dot-md/environment.md)。

## 技能整理（Skill 维护）

本仓库自带的项目 skill 放在仓库任意位置的 `skills/<name>/SKILL.md`（含各业务模块子目录下的 `skills/`；YAML frontmatter 至少含 `name` / `description`，可带脚本 / 资源同目录）。它们随仓库分发、对所有克隆生效；全局 skill（`~/.claude/skills/*`）不入库，本索引不收录。

- 新增 / 改名 / 删除 skill，或改了 `SKILL.md` 的 `description` 后，在仓库根运行 `python3 <agents-dot-md skill 目录>/scripts/reindex.py .`（Windows 用 `python`）重建下方《项目 Skill 索引》《模块文档索引》《记忆索引》与两份 `00-index.md`。
- **不要手工编辑** `<!-- SKILLS:START -->…<!-- SKILLS:END -->` 、`<!-- MODULES:START -->…<!-- MODULES:END -->` 与 `<!-- MEMORY:START -->…<!-- MEMORY:END -->` 之间的内容——会被脚本覆盖。
- `description` 写清「何时用 / 触发词」，首句作为索引摘要（脚本取首句）；触发要精准，避免与既有 skill 语义重叠。

## 记忆记录（Memory）

本仓库的记忆区是 `docs/memory/*.md`——**纯 Markdown，不依赖外部记忆服务，也不需要 LLM key**，你自己用读写文件的工具维护，检索时直接 `rg` / 读文件。

- **何时记**：完成一次排查 / 根因分析 / 踩坑修复后，把「非显然、下次能省事」的结论写下来，别让下一个会话重新推导。
- **记在哪**：按主题聚合到一个文件（如 `docs/memory/build-and-deploy.md`、`docs/memory/known-pitfalls.md`、`docs/memory/external-integrations.md`），不要一条一个文件。文件头两行必须是 `# 标题` 与 `> 一句话摘要`（否则进不了索引）。
- **和记忆服务的分工**：本环境另有记忆服务（如 mem0）时，只和本仓库有关的结论写这里，随 git 共享给团队和其他机器；跨项目的个人偏好和本机环境事实（代理、凭据放在哪、本机工具版本）写记忆服务，没有记忆服务就不记，不要写进仓库。同一条事实只写一处。
- **每条怎么写**：一行一条，**绝对日期**打头，写清「现象 → 原因 → 结论 / 做法」；能附证据就附（`文件:行`、命令、报错原文）。未验证的猜测标「待验证」。
- **不记什么**：代码结构、git 历史、本文件或模块里已写过的内容；凭据 / 密钥只落未入库的本地文件（如 `dev-env.local.md`），**绝不**写进 `docs/memory/` 或任何入库文件。
- 增删主题文件后在仓库根运行 `python3 <agents-dot-md skill 目录>/scripts/reindex.py .` 重建下方《记忆索引》。与某个任务关联的结论，可按需另记到任务系统（如 `vikunja`）的评论里。

## 📇 项目 Skill 索引（全仓 SKILL.md，脚本生成）
<!-- SKILLS:START -->
- （仓库内暂无 SKILL.md）
<!-- SKILLS:END -->

## 📂 模块文档索引（docs/agents-dot-md/，脚本生成）
<!-- MODULES:START -->
- [系统架构](docs/agents-dot-md/architecture.md) — 双向桥接、独立 herdr 通道及模块职责与依赖边界。
- [代码 checklist（强制自检）](docs/agents-dot-md/code-checklist.md) — 写代码前定位专题约束，完成后逐项核对改动与验证证据。
- [编码与改动规范](docs/agents-dot-md/coding-guidelines.md) — 局部改动、异步边界、纯函数与结构化输入的实现约定。
- [配置与运行环境](docs/agents-dot-md/environment.md) — 分层配置、凭据优先级、配置错误处理与真实飞书冒烟入口。
- [日志、网关与 SDK 契约](docs/agents-dot-md/gateway-sdk.md) — TUI 日志保护、出站异常兜底、参数转发与累计流式输出。
- [herdr 派活与结果回收](docs/agents-dot-md/herdr.md) — 独立后台 watch、真实活动门、会话文件收获与关闭清理。
- [消息路由与回合生命周期](docs/agents-dot-md/routing-lifecycle.md) — 普通消息延迟、投递占位、来源认领、自主回合与话题路由的硬性契约。
- [安全与审批](docs/agents-dot-md/security.md) — 风险三档、外发准入、herdr 控制工具及卡片点击鉴权。
- [技术栈与实现约定](docs/agents-dot-md/tech-stack.md) — Node 原生类型剥离、TypeScript ESM、依赖与验证命令。
- [测试与实机验证](docs/agents-dot-md/testing.md) — TDD、手写替身、真 SDK 契约测试、herdr 隔离验收及 pi 重启要求。
- [语言约定](docs/agents-dot-md/translation.md) — 交流、测试名称及代码注释沿用本仓库的中文风格。
<!-- MODULES:END -->

## 🧠 记忆索引（docs/memory/，脚本生成）
<!-- MEMORY:START -->
- （暂无记忆条目，排查后按 AGENTS.md《记忆记录》的约定追加）
<!-- MEMORY:END -->
