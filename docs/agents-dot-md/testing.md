# 测试与实机验证
> TDD、手写替身、真 SDK 契约测试、herdr 隔离验收及 pi 重启要求。

`test/*.test.ts` 按模块组织；`index.ts` 接线由 `test/extensions-load.test.ts`
补充扩展加载与注册冒烟。`extensions/herdr/*.ts` 同样有自己的测试
（`test/herdr-*.test.ts`），而且**完全不依赖 pi 与飞书**：`HerdrCli` 与 `sleep`/`now`
都是注入的，假 `run` 演 herdr、假时钟把等待压掉。用 `node:test` + `node:assert/strict`，
无 mock 框架，需要替身时手写假对象（见 `test/bridge.test.ts` 的 `fakeGateway`）。

Node ≥ 24 是硬要求（原生类型剥离）。执行前用 `node --version` 确认；
使用当前环境的 Node 24+ 运行 `npm test`，不依赖固定安装路径。

本仓库按 TDD 开发：**先写失败的测试，确认它因功能缺失而失败，再写实现**。
安全相关的改动尤其如此 —— `risk.test.ts` 里「回归 v1 / v2」那两组是历史上真实
逃逸过的用例，改判定逻辑时它们必须保持绿。

测试与注释用中文，与现有风格保持一致。

涉及飞书 SDK 行为的，除了手写替身，再补一条**对着真 SDK 跑**的用例
（`test/lark-stream-contract.test.ts`：createLarkChannel 之后把 rawClient 上那
几个 HTTP 方法打掉，驱动 `channel.stream()`，断言真正 PATCH 出去的正文）。
手抄的替身会随 SDK 升级悄悄失真 —— 流式吞字那次就是替身对了、真链路没验。

herdr 侧同理，但**不写成测试**（herdr 不是本仓库的依赖，CI 上必无）：改动
`extensions/herdr/` 的链路（spawn 分支、watch、harvest）时，用一个隔离命名 session
对着真二进制跑一次：`herdr --session <名> server` 起个单独 server，
`workspace create` + `agent start --kind pi`，再用 `promptAndWatch` 派一句
“只回复 PONG”。验证点是**抽出来的正文就是 `PONG`**（而不是满屏 TUI 边框）。
验完 `herdr session stop <名>` 并删掉 session 目录。

**改完代码要重启 pi 才生效**：扩展在 pi 启动时 import 一次，`/feishu stop` +
`start` 只是关开网关，模块还是旧的。
不重启就上飞书验，看到的是改之前的行为 —— 已经因此白排查过一轮。
