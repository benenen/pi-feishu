# 日志、网关与 SDK 契约
> TUI 日志保护、出站异常兜底、参数转发与累计流式输出。

## 日志绝不能裸写 stderr/stdout
pi 的 TUI 不接管 stderr，`console.error` 会直接打进渲染区（光标所在的输入框那一片），
把界面冲花 —— 出错时日志一多，整个会话没法操作。

所有日志走 `log.ts` 的 `createLogger()`，它经 `ctx.ui.notify` 进 pi 的消息区，
只在 headless（`hasUI === false`）或 runner 已停用时才退回 stderr。

飞书 SDK 自己的 `defaultLogger` 也是直接写 `console.log` 的，`createLarkChannel`
必须传 `logger: createSdkLogger(...)` 把它接管掉。

`ExtensionContext` 的属性全是惰性 getter，存下引用晚点读拿到的是**当前**的 UI；
但 runner 停用后读它会 **throw**，而 `log` 是从 catch 块和 SDK 回调里调的 ——
所以日志函数整段包在 try/catch 里，自己绝不抛异常。

## gateway 出站调用的异常必须在 bridge 侧兜住
`feishu.ts` 的 `streamTurn`/`sendText` 刻意**不**自我包含异常（会 reject）。
`bridge.ts` 侧统一兜底 —— 任何 gateway 调用的 rejection 都不能逃进 pi 的事件循环。
新增 gateway 调用点时，照着现有调用点的写法包好。

## `implements GatewayLike` 挡不住「少写一个可选参数」
网关声明了 `implements GatewayLike`，但 TypeScript 的方法参数是可以**少**的：
接口写 `streamTurn(run, to?)`，实现写成 `streamTurn(run)` 照样通过编译，多传的
实参被静默丢掉。群里 @ 的回复一路发到私聊，就是这么来的 —— 接口和调用方都改了，
实现没改，全绿。

改 `GatewayLike` 的签名时，必须同步检查所有实现是否接收并实际转发新参数。
当前实现是 `FeishuGateway`。新增参数时补契约断言，可用 `Function.length` 检查形参，
并验证参数真正传到出站 API。

## 飞书 SDK 的流式 append 不能直接喂增量
`channel.stream()` 给的 controller 不知道生产者给的是增量还是累计，它在 `append()`
里靠 `mergeStreamingText`（@larksuiteoapi/node-sdk 1.71.1 的 `lib/index.js:96096`）
**猜**：新块以已有内容开头就当累计，否则取已有内容的尾巴与新块头部的最长重叠去重。

本扩展给的恰恰是增量，于是这个去重会**静默吞字**：`**lnny**` 被切成 `**ln` +
`ny**` 时，尾巴的 `n` 与新块头部的 `n` 重叠，第二个 n 被吞掉，飞书上显示成粗体的
`lny`。新块正好是已有内容的前缀时（`prev.startsWith(next)`）更狠，整块丢掉。
两种情况都不报错、也不在日志里留痕。

所以把 controller 交给 `run()` 之前一律包一层 `cumulativeSink()`（`turn-stream.ts`），
每次给累计全文，`next.startsWith(prev)` 恒成立，SDK 走精确分支。当前入口是 `feishu.ts` 的 `streamTurn`，新增流式出口时照做。

**注意这不是 markdown 转义问题** —— 排查时极容易看成「名字里的 `**` 没转义」而
去改 renderer，方向就全错了。名字确实也要中和（`plain()`），但那是另一回事。
