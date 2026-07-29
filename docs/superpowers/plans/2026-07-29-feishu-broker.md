# pi-feishu Broker 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用一个独立 broker 进程持有唯一的飞书长连接，多个 pi 会话经本地 Unix socket 注册、用配对码各自绑定一个 chatId，从而一条连接服务所有私聊与群 @。

**Architecture:** broker 是常驻进程，只有它 `createLarkChannel`。pi 会话侧把 `FeishuGateway` 换成 `BrokerGateway` —— 它实现同一个 `GatewayLike` 接口，但所有出站调用改为经 Unix socket 发给 broker，入站消息由 broker 按 `chatId → 连接` 路由表投递。配对码逻辑整体上移到 broker（路由表在它手里），`Pairing` 模块原样复用。

**Tech Stack:** Node ≥ 24 原生类型剥离（无构建步骤）、`node:net`（Unix domain socket）、NDJSON 线协议、`node:test`。**不新增任何 npm 依赖。**

## Global Constraints

- Node ≥ 24，**没有构建步骤**，依赖原生类型剥离直接跑 `.ts`
- strip-only 模式：**不能用构造函数参数属性**（`constructor(private x)`），依赖写成显式字段；禁用 `enum` / `namespace` / 装饰器
- 模块间 import 必须带 `.ts` 后缀；`verbatimModuleSyntax` 开着，纯类型导入必须写 `import type`
- 日志一律走 `log.ts` 的 `createLogger()`，**绝不裸写 stderr/stdout**（broker 进程例外见 Task 7）
- 安全闸门一律 fail-closed；任何 gateway 调用的 rejection 都不能逃进 pi 的事件循环
- 测试与注释用中文，与现有风格一致
- 每个 Task 结束前必须 `npm test` + `npm run typecheck` 全绿
- 不改动 `bridge.ts` / `risk.ts` / `renderer.ts` / `approval.ts` / `approval-card.ts` / `turn-stream.ts` 的现有行为

## 传输与鉴权（贯穿全部 Task）

- socket 路径：`<getAgentDir()>/feishu-broker.sock`
- **鉴权靠文件权限**：broker 启动时 `chmod 0600` 该 socket 文件。同机其他用户连不上；不额外发 token
- 线协议：**NDJSON**，一行一个 JSON 对象，`\n` 分隔
- 需要返回值的调用带 `id`（单调递增字符串），响应回同一个 `id`

## File Structure

| 文件 | 职责 |
|---|---|
| `extensions/feishu/types.ts` | **新增**：把 `InboundMessage` 从 `feishu.ts` 抽出来。broker 侧需要这个类型，但绝不能因此把飞书 SDK 拖进 broker 的模块图 |
| `extensions/feishu/broker/protocol.ts` | 线协议：帧类型定义 + `encodeFrame` + `FrameReader`（处理粘包/半包）。纯函数，无 IO |
| `extensions/feishu/broker/registry.ts` | 路由表：`chatId ↔ 会话连接`、每会话的待配对码、断开清理。纯逻辑，注入 `Pairing` |
| `extensions/feishu/broker/server.ts` | broker 服务端：监听 socket、读帧、派发。飞书侧经注入的 `BrokerChannelLike` 接口，便于测试 |
| `extensions/feishu/broker/channel.ts` | 多会话版飞书网关：包住 `createLarkChannel`，**不持有 bound 概念**，所有出站方法都显式收 `chatId` |
| `extensions/feishu/broker-gateway.ts` | 客户端：实现 `GatewayLike`，把出站调用发给 broker |
| `bin/broker.ts` | broker 进程入口：读配置、建 channel、起 server、优雅退出 |
| `test/broker-protocol.test.ts` | Task 1 |
| `test/broker-registry.test.ts` | Task 2 |
| `test/broker-server.test.ts` | Task 3（用真实 socket + 假 channel） |
| `test/broker-gateway.test.ts` | Task 5（用真实 socket + 假 server） |

`channel.ts` 是 SDK 边界，不写单测（与现有 `feishu.ts` 一致）。

---

### Task 1: 线协议编解码

**Files:**
- Create: `extensions/feishu/broker/protocol.ts`
- Test: `test/broker-protocol.test.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `type ClientFrame` / `type ServerFrame`（下方联合类型）
  - `function encodeFrame(frame: ClientFrame | ServerFrame): string`
  - `class FrameReader { push(chunk: Buffer): (ClientFrame | ServerFrame)[] }`

- [ ] **Step 1: 写失败的测试**

```ts
// test/broker-protocol.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeFrame, FrameReader } from "../extensions/feishu/broker/protocol.ts";

test("编码后以换行结尾，且不含内嵌换行", () => {
  const line = encodeFrame({ t: "hello", cwd: "/w", label: "a\nb" });
  assert.equal(line.endsWith("\n"), true);
  assert.equal(line.slice(0, -1).includes("\n"), false, "内容里的换行必须被 JSON 转义");
});

test("一次 push 里的多帧全部解出", () => {
  const r = new FrameReader();
  const buf = Buffer.from(
    encodeFrame({ t: "unbind" }) + encodeFrame({ t: "stream_end", id: "1" }),
  );
  const frames = r.push(buf);
  assert.equal(frames.length, 2);
  assert.equal(frames[0]?.t, "unbind");
  assert.equal(frames[1]?.t, "stream_end");
});

test("半包：帧被拆成两次 push 也能拼回来", () => {
  const r = new FrameReader();
  const line = encodeFrame({ t: "send_text", id: "7", markdown: "你好" });
  const cut = Math.floor(line.length / 2);
  assert.deepEqual(r.push(Buffer.from(line.slice(0, cut))), [], "半包不应产出帧");
  const frames = r.push(Buffer.from(line.slice(cut)));
  assert.equal(frames.length, 1);
  assert.equal(frames[0]?.t, "send_text");
});

test("坏行被跳过，不影响后续帧", () => {
  const r = new FrameReader();
  const frames = r.push(Buffer.from("{不是合法 JSON}\n" + encodeFrame({ t: "unbind" })));
  assert.equal(frames.length, 1, "坏行丢弃，好行照常解出");
  assert.equal(frames[0]?.t, "unbind");
});

test("超长行被丢弃，防止对端把内存撑爆", () => {
  const r = new FrameReader();
  assert.deepEqual(r.push(Buffer.from("x".repeat(2_000_000))), []);
  // 丢弃后仍能从下一个换行处恢复
  const frames = r.push(Buffer.from("\n" + encodeFrame({ t: "unbind" })));
  assert.equal(frames.length, 1);
});

test("UTF-8 多字节字符被拆包也不会乱码", () => {
  const r = new FrameReader();
  const line = encodeFrame({ t: "send_text", id: "1", markdown: "中文字符" });
  const buf = Buffer.from(line);
  // 在一个多字节字符中间切开
  assert.deepEqual(r.push(buf.subarray(0, 20)), []);
  const frames = r.push(buf.subarray(20));
  assert.equal(frames.length, 1);
  assert.equal((frames[0] as { markdown: string }).markdown, "中文字符");
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test "test/broker-protocol.test.ts"`
Expected: FAIL —— `Cannot find module '.../broker/protocol.ts'`

- [ ] **Step 3: 先把 `InboundMessage` 抽成无依赖模块**

`feishu.ts` 导入了飞书 SDK。broker 侧要用 `InboundMessage`，但让 `broker/server.ts`
从 `feishu.ts` 导入，会把整个 SDK 拖进 broker 与其测试的模块图。抽出来：

```ts
// extensions/feishu/types.ts —— 本文件不得有任何 import
export interface InboundMessage {
  chatId: string;
  senderId: string;
  text: string;
  imageKeys: string[];
}
```

`feishu.ts` 里删掉原定义，改为 re-export（`bridge.ts` 现有的
`import type { InboundMessage } from "./feishu.ts"` 保持可用，不产生连锁改动）：

```ts
export type { InboundMessage } from "./types.ts";
```

跑 `npm run typecheck` 确认零改动通过。

- [ ] **Step 4: 写协议的最小实现**

```ts
// extensions/feishu/broker/protocol.ts
import { StringDecoder } from "node:string_decoder";

/** 单行上限。超过即丢弃该行 —— 对端异常时不能把 broker 的内存撑爆 */
const MAX_LINE_BYTES = 1_000_000;

export type ClientFrame =
  | { t: "hello"; cwd: string; label: string }
  | { t: "pair_request"; id: string }
  | { t: "unbind" }
  | { t: "send_text"; id: string; markdown: string; to?: string }
  | { t: "stream_begin"; id: string }
  | { t: "stream_chunk"; id: string; text: string }
  | { t: "stream_end"; id: string }
  | { t: "ask"; id: string; toolName: string; input: Record<string, unknown> }
  | { t: "ask_cancel"; id: string }
  | { t: "download_image"; id: string; fileKey: string }
  | { t: "describe_chat"; id: string };

export type ServerFrame =
  | { t: "hello_ok" }
  | { t: "pair_code"; id: string; code: string; expiresAt: number }
  | { t: "bound"; chatId: string }
  | { t: "unbound" }
  | { t: "message"; chatId: string; senderId: string; text: string; imageKeys: string[] }
  | { t: "ask_result"; id: string; allow: boolean; reason: string; scope?: "turn" }
  | { t: "ok"; id: string }
  | { t: "err"; id: string; message: string }
  | { t: "image"; id: string; base64?: string }
  | { t: "chat_desc"; id: string; label?: string };

export type Frame = ClientFrame | ServerFrame;

export function encodeFrame(frame: Frame): string {
  // JSON.stringify 会把内容里的换行转义成 \n 两个字符，行边界因此是安全的
  return `${JSON.stringify(frame)}\n`;
}

/**
 * 把字节流切成帧。
 *
 * 用 StringDecoder 而不是 chunk.toString()：一个多字节 UTF-8 字符可能横跨两个
 * chunk，逐块 toString 会在切口处产生替换字符，内容静默损坏。
 */
export class FrameReader {
  #decoder = new StringDecoder("utf8");
  #buf = "";
  /** 当前行已超长，丢弃直到下一个换行 */
  #skipping = false;

  push(chunk: Buffer): Frame[] {
    this.#buf += this.#decoder.write(chunk);
    const out: Frame[] = [];

    for (;;) {
      const nl = this.#buf.indexOf("\n");
      if (nl === -1) break;
      const line = this.#buf.slice(0, nl);
      this.#buf = this.#buf.slice(nl + 1);

      if (this.#skipping) {
        this.#skipping = false;
        continue;
      }
      if (line === "") continue;
      try {
        out.push(JSON.parse(line) as Frame);
      } catch {
        // 坏行直接丢，不能因为对端发了脏数据就断整条连接
      }
    }

    if (this.#buf.length > MAX_LINE_BYTES) {
      this.#buf = "";
      this.#skipping = true;
    }
    return out;
  }
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `node --test "test/broker-protocol.test.ts"` → 6 passed
Run: `npm test && npm run typecheck` → 全绿

- [ ] **Step 6: 提交**

```bash
git add extensions/feishu/types.ts extensions/feishu/feishu.ts \
        extensions/feishu/broker/protocol.ts test/broker-protocol.test.ts
git commit -m "feat(broker): NDJSON 线协议编解码，InboundMessage 抽成无依赖模块"
```

---

### Task 2: 路由表

**Files:**
- Create: `extensions/feishu/broker/registry.ts`
- Test: `test/broker-registry.test.ts`

**Interfaces:**
- Consumes: `Pairing` from `../pairing.ts`
- Produces:
  - `interface SessionHandle { id: string; label: string; cwd: string }`
  - `class SessionRegistry`：`add(handle)` / `remove(id)` / `issueCode(id)` / `matchCode(text)` / `bind(id, chatId)` / `unbind(id)` / `byChat(chatId)` / `byId(id)` / `boundChatOf(id)` / `list()`

- [ ] **Step 1: 写失败的测试**

```ts
// test/broker-registry.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { SessionRegistry } from "../extensions/feishu/broker/registry.ts";

/** 固定随机源，码可预期；固定时钟，过期可控 */
function makeRegistry(now = () => 0) {
  let n = 0;
  return new SessionRegistry({
    now,
    randomInt: () => (n++ % 31),
    pairingTtlMs: 600_000,
  });
}

const A = { id: "s1", label: "项目A", cwd: "/a" };
const B = { id: "s2", label: "项目B", cwd: "/b" };

test("绑定后能按 chatId 找回会话", () => {
  const r = makeRegistry();
  r.add(A);
  r.bind("s1", "oc_1");
  assert.equal(r.byChat("oc_1")?.id, "s1");
  assert.equal(r.boundChatOf("s1"), "oc_1");
});

test("未绑定的 chatId 查不到会话", () => {
  const r = makeRegistry();
  r.add(A);
  assert.equal(r.byChat("oc_unknown"), undefined);
});

test("配对码匹配后返回该会话，且完成绑定", () => {
  const r = makeRegistry();
  r.add(A);
  const code = r.issueCode("s1");
  assert.equal(r.matchCode(code)?.id, "s1");
  // matchCode 只负责认人，绑定由调用方带 chatId 做
  r.bind("s1", "oc_9");
  assert.equal(r.byChat("oc_9")?.id, "s1");
});

test("配对码是一次性的", () => {
  const r = makeRegistry();
  r.add(A);
  const code = r.issueCode("s1");
  assert.equal(r.matchCode(code)?.id, "s1");
  assert.equal(r.matchCode(code), undefined, "第二次不该再认");
});

test("两个会话各自的码互不串台", () => {
  const r = makeRegistry();
  r.add(A);
  r.add(B);
  const ca = r.issueCode("s1");
  const cb = r.issueCode("s2");
  assert.notEqual(ca, cb);
  assert.equal(r.matchCode(cb)?.id, "s2");
  assert.equal(r.matchCode(ca)?.id, "s1");
});

test("一个 chatId 只能绑一个会话：后绑的把先绑的顶掉", () => {
  const r = makeRegistry();
  r.add(A);
  r.add(B);
  r.bind("s1", "oc_1");
  r.bind("s2", "oc_1");
  assert.equal(r.byChat("oc_1")?.id, "s2");
  assert.equal(r.boundChatOf("s1"), undefined, "被顶掉的会话应视为未绑定");
});

test("一个会话换绑新 chatId 时，旧 chatId 的路由要清掉", () => {
  const r = makeRegistry();
  r.add(A);
  r.bind("s1", "oc_1");
  r.bind("s1", "oc_2");
  assert.equal(r.byChat("oc_1"), undefined, "旧路由必须清掉，否则消息投给一个不再关心它的会话");
  assert.equal(r.byChat("oc_2")?.id, "s1");
});

test("会话断开时，它的绑定与待配对码一并清除", () => {
  const r = makeRegistry();
  r.add(A);
  const code = r.issueCode("s1");
  r.bind("s1", "oc_1");
  r.remove("s1");
  assert.equal(r.byChat("oc_1"), undefined);
  assert.equal(r.matchCode(code), undefined, "断开会话的码不能还能用");
  assert.equal(r.byId("s1"), undefined);
});

test("配对码过期后不再匹配", () => {
  let t = 0;
  let n = 0;
  const r = new SessionRegistry({
    now: () => t,
    randomInt: () => (n++ % 31),
    pairingTtlMs: 1000,
  });
  r.add(A);
  const code = r.issueCode("s1");
  t = 1001;
  assert.equal(r.matchCode(code), undefined);
});

test("重新签发作废旧码", () => {
  const r = makeRegistry();
  r.add(A);
  const first = r.issueCode("s1");
  const second = r.issueCode("s1");
  assert.equal(r.matchCode(first), undefined);
  assert.equal(r.matchCode(second)?.id, "s1");
});

test("list 列出全部会话及其绑定", () => {
  const r = makeRegistry();
  r.add(A);
  r.add(B);
  r.bind("s1", "oc_1");
  const rows = r.list();
  assert.equal(rows.length, 2);
  assert.equal(rows.find((x) => x.id === "s1")?.chatId, "oc_1");
  assert.equal(rows.find((x) => x.id === "s2")?.chatId, undefined);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test "test/broker-registry.test.ts"`
Expected: FAIL —— `Cannot find module '.../broker/registry.ts'`

- [ ] **Step 3: 写最小实现**

```ts
// extensions/feishu/broker/registry.ts
import { Pairing } from "../pairing.ts";

export interface SessionHandle {
  id: string;
  label: string;
  cwd: string;
}

export interface RegistryOptions {
  now: () => number;
  randomInt: (n: number) => number;
  pairingTtlMs: number;
}

interface Entry {
  handle: SessionHandle;
  pairing: Pairing;
  chatId?: string;
}

/**
 * chatId ↔ 会话 的双向路由表，外加每个会话自己的待配对码。
 *
 * 两条不变量：
 * - 一个 chatId 至多映射到一个会话（后绑顶掉先绑），否则一条消息会喂给两个 agent
 * - 一个会话换绑时必须清掉旧 chatId 的路由，否则旧对话的消息会继续投给它
 */
export class SessionRegistry {
  #entries = new Map<string, Entry>();
  #byChat = new Map<string, string>();

  // strip-only 模式不支持构造函数参数属性，依赖写成显式字段
  readonly #opts: RegistryOptions;

  constructor(opts: RegistryOptions) {
    this.#opts = opts;
  }

  add(handle: SessionHandle): void {
    this.#entries.set(handle.id, {
      handle,
      pairing: new Pairing({
        now: this.#opts.now,
        randomInt: this.#opts.randomInt,
        ttlMs: this.#opts.pairingTtlMs,
      }),
    });
  }

  remove(id: string): void {
    const e = this.#entries.get(id);
    if (!e) return;
    if (e.chatId !== undefined) this.#byChat.delete(e.chatId);
    e.pairing.cancel();
    this.#entries.delete(id);
  }

  byId(id: string): SessionHandle | undefined {
    return this.#entries.get(id)?.handle;
  }

  byChat(chatId: string): SessionHandle | undefined {
    const id = this.#byChat.get(chatId);
    return id === undefined ? undefined : this.#entries.get(id)?.handle;
  }

  boundChatOf(id: string): string | undefined {
    return this.#entries.get(id)?.chatId;
  }

  issueCode(id: string): string {
    const e = this.#entries.get(id);
    if (!e) throw new Error(`未知会话 ${id}`);
    return e.pairing.issue();
  }

  /** 逐个会话试；命中即消耗掉该码 */
  matchCode(text: string): SessionHandle | undefined {
    for (const e of this.#entries.values()) {
      if (e.pairing.match(text)) return e.handle;
    }
    return undefined;
  }

  bind(id: string, chatId: string): void {
    const e = this.#entries.get(id);
    if (!e) return;

    // 该 chatId 原先属于别的会话 —— 把那个会话置为未绑定
    const prevOwner = this.#byChat.get(chatId);
    if (prevOwner !== undefined && prevOwner !== id) {
      const prev = this.#entries.get(prevOwner);
      if (prev) prev.chatId = undefined;
    }
    // 本会话原先绑着别的 chat —— 清掉旧路由
    if (e.chatId !== undefined && e.chatId !== chatId) this.#byChat.delete(e.chatId);

    e.chatId = chatId;
    this.#byChat.set(chatId, id);
  }

  unbind(id: string): void {
    const e = this.#entries.get(id);
    if (!e || e.chatId === undefined) return;
    this.#byChat.delete(e.chatId);
    e.chatId = undefined;
  }

  list(): Array<{ id: string; label: string; cwd: string; chatId?: string }> {
    return [...this.#entries.values()].map((e) => ({
      id: e.handle.id,
      label: e.handle.label,
      cwd: e.handle.cwd,
      chatId: e.chatId,
    }));
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test "test/broker-registry.test.ts"` → 11 passed
Run: `npm test && npm run typecheck` → 全绿

- [ ] **Step 5: 提交**

```bash
git add extensions/feishu/broker/registry.ts test/broker-registry.test.ts
git commit -m "feat(broker): chatId ↔ 会话路由表与每会话配对码"
```

---

### Task 3: Broker 服务端

**Files:**
- Create: `extensions/feishu/broker/server.ts`
- Test: `test/broker-server.test.ts`

**Interfaces:**
- Consumes: `FrameReader` / `encodeFrame` / `ClientFrame` / `ServerFrame`（Task 1）、`SessionRegistry`（Task 2）
- Produces:
  - `interface BrokerChannelLike`：`sendText(chatId, markdown)` / `streamTo(chatId, run)` / `askCard(chatId, req, signal)` / `downloadImage(fileKey)` / `describeChat(chatId)`
  - `class BrokerServer`：`listen(socketPath)` / `close()` / `deliver(msg)` / `get sessionCount()`

飞书侧经 `BrokerChannelLike` 注入，测试用假实现，真实现见 Task 4。

- [ ] **Step 1: 写失败的测试**

```ts
// test/broker-server.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BrokerServer, type BrokerChannelLike } from "../extensions/feishu/broker/server.ts";
import { encodeFrame, FrameReader, type ServerFrame } from "../extensions/feishu/broker/protocol.ts";

function tmpSock(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pi-feishu-broker-")), "s.sock");
}

function fakeChannel(sent: Array<{ chatId: string; text: string }>): BrokerChannelLike {
  return {
    async sendText(chatId, markdown) {
      sent.push({ chatId, text: markdown });
    },
    async streamTo(chatId, run) {
      await run({ append: async (c) => void sent.push({ chatId, text: c }) });
    },
    async askCard() {
      return { allow: false, reason: "假通道" };
    },
    async downloadImage() {
      return undefined;
    },
    async describeChat() {
      return "假会话";
    },
  };
}

/** 连上 broker，收集收到的帧 */
async function connect(sockPath: string) {
  const sock = net.createConnection(sockPath);
  await new Promise<void>((r) => sock.once("connect", () => r()));
  const reader = new FrameReader();
  const frames: ServerFrame[] = [];
  sock.on("data", (b: Buffer) => frames.push(...(reader.push(b) as ServerFrame[])));
  return {
    sock,
    frames,
    send: (f: unknown) => sock.write(encodeFrame(f as never)),
    async waitFor(t: string, ms = 2000): Promise<ServerFrame> {
      const until = Date.now() + ms;
      for (;;) {
        const hit = frames.find((f) => f.t === t);
        if (hit) return hit;
        if (Date.now() > until) throw new Error(`等 ${t} 超时，已收到：${frames.map((f) => f.t).join(",")}`);
        await new Promise((r) => setTimeout(r, 10));
      }
    },
  };
}

test("hello 之后回 hello_ok，会话计入注册表", async () => {
  const server = new BrokerServer({ channel: fakeChannel([]), pairingTtlMs: 600_000, log: () => {} });
  const p = tmpSock();
  await server.listen(p);
  const c = await connect(p);
  c.send({ t: "hello", cwd: "/w", label: "A" });
  await c.waitFor("hello_ok");
  assert.equal(server.sessionCount, 1);
  c.sock.destroy();
  await server.close();
});

test("socket 文件权限是 0600 —— 鉴权全靠它", async () => {
  const server = new BrokerServer({ channel: fakeChannel([]), pairingTtlMs: 600_000, log: () => {} });
  const p = tmpSock();
  await server.listen(p);
  assert.equal(fs.statSync(p).mode & 0o777, 0o600);
  await server.close();
});

test("配对码匹配的入站消息完成绑定，之后该 chat 的消息投给该会话", async () => {
  const server = new BrokerServer({ channel: fakeChannel([]), pairingTtlMs: 600_000, log: () => {} });
  const p = tmpSock();
  await server.listen(p);
  const c = await connect(p);
  c.send({ t: "hello", cwd: "/w", label: "A" });
  await c.waitFor("hello_ok");
  c.send({ t: "pair_request", id: "1" });
  const code = (await c.waitFor("pair_code")) as { code: string };

  server.deliver({ chatId: "oc_1", senderId: "ou_1", text: code.code, imageKeys: [] });
  const bound = (await c.waitFor("bound")) as { chatId: string };
  assert.equal(bound.chatId, "oc_1");

  server.deliver({ chatId: "oc_1", senderId: "ou_1", text: "跑测试", imageKeys: [] });
  const msg = (await c.waitFor("message")) as { text: string };
  assert.equal(msg.text, "跑测试");

  c.sock.destroy();
  await server.close();
});

test("未绑定 chat 的消息不会投给任何会话", async () => {
  const sent: Array<{ chatId: string; text: string }> = [];
  const server = new BrokerServer({ channel: fakeChannel(sent), pairingTtlMs: 600_000, log: () => {} });
  const p = tmpSock();
  await server.listen(p);
  const c = await connect(p);
  c.send({ t: "hello", cwd: "/w", label: "A" });
  await c.waitFor("hello_ok");

  server.deliver({ chatId: "oc_x", senderId: "ou_1", text: "在吗", imageKeys: [] });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(c.frames.some((f) => f.t === "message"), false, "不该投递");
  assert.ok(sent.some((s) => s.chatId === "oc_x"), "应回一句提示，告诉对方需要配对码");

  c.sock.destroy();
  await server.close();
});

test("send_text 转发到 channel 并回 ok", async () => {
  const sent: Array<{ chatId: string; text: string }> = [];
  const server = new BrokerServer({ channel: fakeChannel(sent), pairingTtlMs: 600_000, log: () => {} });
  const p = tmpSock();
  await server.listen(p);
  const c = await connect(p);
  c.send({ t: "hello", cwd: "/w", label: "A" });
  await c.waitFor("hello_ok");
  c.send({ t: "pair_request", id: "1" });
  const code = (await c.waitFor("pair_code")) as { code: string };
  server.deliver({ chatId: "oc_1", senderId: "ou_1", text: code.code, imageKeys: [] });
  await c.waitFor("bound");

  c.send({ t: "send_text", id: "9", markdown: "结果" });
  await c.waitFor("ok");
  assert.deepEqual(sent.at(-1), { chatId: "oc_1", text: "结果" });

  c.sock.destroy();
  await server.close();
});

test("未绑定时 send_text 回 err，而不是静默丢弃", async () => {
  const server = new BrokerServer({ channel: fakeChannel([]), pairingTtlMs: 600_000, log: () => {} });
  const p = tmpSock();
  await server.listen(p);
  const c = await connect(p);
  c.send({ t: "hello", cwd: "/w", label: "A" });
  await c.waitFor("hello_ok");
  c.send({ t: "send_text", id: "9", markdown: "结果" });
  const err = (await c.waitFor("err")) as { message: string };
  assert.ok(err.message.includes("未绑定"));
  c.sock.destroy();
  await server.close();
});

test("会话断开后，它绑的 chat 变成未绑定", async () => {
  const server = new BrokerServer({ channel: fakeChannel([]), pairingTtlMs: 600_000, log: () => {} });
  const p = tmpSock();
  await server.listen(p);
  const c = await connect(p);
  c.send({ t: "hello", cwd: "/w", label: "A" });
  await c.waitFor("hello_ok");
  c.send({ t: "pair_request", id: "1" });
  const code = (await c.waitFor("pair_code")) as { code: string };
  server.deliver({ chatId: "oc_1", senderId: "ou_1", text: code.code, imageKeys: [] });
  await c.waitFor("bound");

  c.sock.destroy();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(server.sessionCount, 0);
  await server.close();
});

test("流式：begin/chunk/end 依次转成 channel 的 append", async () => {
  const sent: Array<{ chatId: string; text: string }> = [];
  const server = new BrokerServer({ channel: fakeChannel(sent), pairingTtlMs: 600_000, log: () => {} });
  const p = tmpSock();
  await server.listen(p);
  const c = await connect(p);
  c.send({ t: "hello", cwd: "/w", label: "A" });
  await c.waitFor("hello_ok");
  c.send({ t: "pair_request", id: "1" });
  const code = (await c.waitFor("pair_code")) as { code: string };
  server.deliver({ chatId: "oc_1", senderId: "ou_1", text: code.code, imageKeys: [] });
  await c.waitFor("bound");

  c.send({ t: "stream_begin", id: "s" });
  c.send({ t: "stream_chunk", id: "s", text: "前半" });
  c.send({ t: "stream_chunk", id: "s", text: "后半" });
  c.send({ t: "stream_end", id: "s" });
  await c.waitFor("ok");
  assert.equal(sent.map((x) => x.text).join(""), "前半后半");

  c.sock.destroy();
  await server.close();
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test "test/broker-server.test.ts"`
Expected: FAIL —— `Cannot find module '.../broker/server.ts'`

- [ ] **Step 3: 写最小实现**

```ts
// extensions/feishu/broker/server.ts
import net from "node:net";
import fs from "node:fs";
import { randomInt, randomUUID } from "node:crypto";
import { encodeFrame, FrameReader, type ClientFrame, type ServerFrame } from "./protocol.ts";
import { SessionRegistry } from "./registry.ts";
import { TurnStream, type AppendSink } from "../turn-stream.ts";
import type { ApprovalRequest, Decision } from "../approval.ts";
import type { LogFn } from "../log.ts";
import type { InboundMessage } from "../types.ts";

export type { InboundMessage };

/** broker 需要的飞书能力。真实现在 channel.ts，测试注入假实现 */
export interface BrokerChannelLike {
  sendText(chatId: string, markdown: string): Promise<void>;
  streamTo(chatId: string, run: (sink: AppendSink) => Promise<void>): Promise<void>;
  askCard(chatId: string, req: ApprovalRequest, signal: AbortSignal): Promise<Decision>;
  downloadImage(fileKey: string): Promise<Buffer | undefined>;
  describeChat(chatId: string): Promise<string | undefined>;
}

export interface BrokerServerOptions {
  channel: BrokerChannelLike;
  pairingTtlMs: number;
  log: LogFn;
}

interface Conn {
  id: string;
  socket: net.Socket;
  reader: FrameReader;
  streams: Map<string, { stream: TurnStream; done: Promise<void> }>;
  asks: Map<string, AbortController>;
}

export class BrokerServer {
  #server: net.Server | undefined;
  #conns = new Map<string, Conn>();
  #registry: SessionRegistry;

  readonly #channel: BrokerChannelLike;
  readonly #log: LogFn;

  constructor(opts: BrokerServerOptions) {
    this.#channel = opts.channel;
    this.#log = opts.log;
    this.#registry = new SessionRegistry({
      now: () => Date.now(),
      randomInt,
      pairingTtlMs: opts.pairingTtlMs,
    });
  }

  get sessionCount(): number {
    return this.#conns.size;
  }

  async listen(socketPath: string): Promise<void> {
    // 上次非正常退出会留下 socket 文件，不清掉会 EADDRINUSE
    fs.rmSync(socketPath, { force: true });

    const server = net.createServer((socket) => this.#onConnection(socket));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => resolve());
    });
    // 鉴权全靠文件权限：同机其他用户不得连入
    fs.chmodSync(socketPath, 0o600);
    this.#server = server;
  }

  async close(): Promise<void> {
    for (const c of this.#conns.values()) c.socket.destroy();
    this.#conns.clear();
    const s = this.#server;
    this.#server = undefined;
    if (s) await new Promise<void>((r) => s.close(() => r()));
  }

  /** 飞书侧收到消息时调用 */
  deliver(msg: InboundMessage): void {
    const owner = this.#registry.byChat(msg.chatId);
    if (owner) {
      this.#send(owner.id, {
        t: "message",
        chatId: msg.chatId,
        senderId: msg.senderId,
        text: msg.text,
        imageKeys: msg.imageKeys,
      });
      return;
    }

    const paired = this.#registry.matchCode(msg.text);
    if (paired) {
      this.#registry.bind(paired.id, msg.chatId);
      this.#send(paired.id, { t: "bound", chatId: msg.chatId });
      void this.#safe(() =>
        this.#channel.sendText(msg.chatId, `配对成功，本对话已绑定 pi 会话：${paired.label}`),
      );
      return;
    }

    void this.#safe(() =>
      this.#channel.sendText(msg.chatId, "该对话尚未绑定 pi 会话，请发送终端上显示的配对码。"),
    );
  }

  #onConnection(socket: net.Socket): void {
    const id = randomUUID();
    const conn: Conn = { id, socket, reader: new FrameReader(), streams: new Map(), asks: new Map() };
    this.#conns.set(id, conn);

    socket.on("data", (chunk: Buffer) => {
      for (const f of conn.reader.push(chunk)) {
        void this.#safe(() => this.#handle(conn, f as ClientFrame));
      }
    });
    const drop = () => {
      for (const a of conn.asks.values()) a.abort();
      this.#registry.remove(id);
      this.#conns.delete(id);
    };
    socket.on("close", drop);
    socket.on("error", drop);
  }

  async #handle(conn: Conn, f: ClientFrame): Promise<void> {
    switch (f.t) {
      case "hello":
        this.#registry.add({ id: conn.id, label: f.label, cwd: f.cwd });
        this.#send(conn.id, { t: "hello_ok" });
        return;

      case "pair_request": {
        const code = this.#registry.issueCode(conn.id);
        this.#send(conn.id, { t: "pair_code", id: f.id, code, expiresAt: 0 });
        return;
      }

      case "unbind":
        this.#registry.unbind(conn.id);
        this.#send(conn.id, { t: "unbound" });
        return;

      case "send_text": {
        const chatId = f.to ?? this.#registry.boundChatOf(conn.id);
        if (chatId === undefined) return this.#send(conn.id, { t: "err", id: f.id, message: "未绑定会话" });
        await this.#channel.sendText(chatId, f.markdown);
        this.#send(conn.id, { t: "ok", id: f.id });
        return;
      }

      case "stream_begin": {
        const chatId = this.#registry.boundChatOf(conn.id);
        if (chatId === undefined) return this.#send(conn.id, { t: "err", id: f.id, message: "未绑定会话" });
        const stream = new TurnStream();
        // channel.stream 是拉模型，这里让它从 TurnStream 拉；
        // 会话推来的 chunk 往同一个 TurnStream 推 —— 现成的推拉适配器跨进程复用
        const done = this.#channel.streamTo(chatId, (sink) => stream.pump(sink));
        conn.streams.set(f.id, { stream, done });
        return;
      }

      case "stream_chunk":
        conn.streams.get(f.id)?.stream.push(f.text);
        return;

      case "stream_end": {
        const entry = conn.streams.get(f.id);
        conn.streams.delete(f.id);
        if (!entry) return this.#send(conn.id, { t: "ok", id: f.id });
        entry.stream.finish();
        try {
          await entry.done;
          this.#send(conn.id, { t: "ok", id: f.id });
        } catch (err) {
          this.#send(conn.id, { t: "err", id: f.id, message: String(err) });
        }
        return;
      }

      case "ask": {
        const chatId = this.#registry.boundChatOf(conn.id);
        if (chatId === undefined) {
          // fail-closed：拿不到会话就是拒绝，绝不放行
          this.#send(conn.id, { t: "ask_result", id: f.id, allow: false, reason: "未绑定会话" });
          return;
        }
        const ac = new AbortController();
        conn.asks.set(f.id, ac);
        try {
          const d = await this.#channel.askCard(chatId, { toolName: f.toolName, input: f.input }, ac.signal);
          this.#send(conn.id, {
            t: "ask_result",
            id: f.id,
            allow: d.allow,
            reason: d.reason,
            ...(d.scope === "turn" ? { scope: "turn" as const } : {}),
          });
        } catch (err) {
          this.#send(conn.id, { t: "ask_result", id: f.id, allow: false, reason: `审批通道异常：${String(err)}` });
        } finally {
          conn.asks.delete(f.id);
        }
        return;
      }

      case "ask_cancel":
        conn.asks.get(f.id)?.abort();
        conn.asks.delete(f.id);
        return;

      case "download_image": {
        const buf = await this.#channel.downloadImage(f.fileKey);
        this.#send(conn.id, { t: "image", id: f.id, base64: buf?.toString("base64") });
        return;
      }

      case "describe_chat": {
        const chatId = this.#registry.boundChatOf(conn.id);
        const label = chatId === undefined ? undefined : await this.#channel.describeChat(chatId);
        this.#send(conn.id, { t: "chat_desc", id: f.id, label });
        return;
      }
    }
  }

  #send(connId: string, frame: ServerFrame): void {
    const c = this.#conns.get(connId);
    if (!c) return;
    try {
      c.socket.write(encodeFrame(frame));
    } catch {
      // 对端已断开，忽略；close 事件会清理注册表
    }
  }

  /** 任何异步失败只记日志，绝不让它冒成 unhandledRejection 把 broker 打死 */
  async #safe(work: () => Promise<unknown> | unknown): Promise<void> {
    try {
      await work();
    } catch (err) {
      this.#log(`broker 处理失败：${String(err)}`, "error");
    }
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test "test/broker-server.test.ts"` → 8 passed
Run: `npm test && npm run typecheck` → 全绿

- [ ] **Step 5: 提交**

```bash
git add extensions/feishu/broker/server.ts test/broker-server.test.ts
git commit -m "feat(broker): 服务端骨架，socket 0600 鉴权与多会话路由"
```

---

### Task 4: 多会话版飞书通道

**Files:**
- Create: `extensions/feishu/broker/channel.ts`

**Interfaces:**
- Consumes: `BrokerChannelLike`（Task 3）、`createSdkLogger`（`../log.ts`）、`buildApprovalCard` / `buildSettledCard` / `parseApprovalAction` / `ApprovalRegistry`（`../approval-card.ts`）
- Produces: `class BrokerChannel implements BrokerChannelLike`，附加 `connect()` / `disconnect()` / `onMessage(handler)`

本文件是 SDK 边界，与现有 `feishu.ts` 一样不写单测；正确性由 Task 6 的冒烟清单覆盖。

- [ ] **Step 1: 实现（无单测，照 feishu.ts 的既有写法）**

```ts
// extensions/feishu/broker/channel.ts
import { randomUUID } from "node:crypto";
import { createLarkChannel, LoggerLevel } from "@larksuiteoapi/node-sdk";
import type { LarkChannel } from "@larksuiteoapi/node-sdk";
import { createSdkLogger, type LogFn } from "../log.ts";
import { chatLabel } from "../renderer.ts";
import type { AppendSink } from "../turn-stream.ts";
import type { ApprovalRequest, Decision } from "../approval.ts";
import type { Config } from "../config.ts";
import {
  ApprovalRegistry,
  buildApprovalCard,
  buildSettledCard,
  parseApprovalAction,
} from "../approval-card.ts";
import type { BrokerChannelLike } from "./server.ts";
import type { InboundMessage } from "../types.ts";

/**
 * 与 FeishuGateway 的区别：**不持有 bound 概念**。broker 服务所有对话，
 * 收件人一律由调用方显式传入，绑定关系记在 SessionRegistry 里。
 */
export class BrokerChannel implements BrokerChannelLike {
  #channel: LarkChannel | undefined;
  #messageHandler: ((msg: InboundMessage) => void) | undefined;
  #approvals = new ApprovalRegistry();

  readonly #config: Config;
  readonly #log: LogFn;

  constructor(config: Config, log: LogFn) {
    this.#config = config;
    this.#log = log;
  }

  onMessage(handler: (msg: InboundMessage) => void): void {
    this.#messageHandler = handler;
  }

  async connect(): Promise<void> {
    if (this.#channel) return;
    const channel = createLarkChannel({
      appId: this.#config.appId,
      appSecret: this.#config.appSecret,
      transport: "websocket",
      source: "pi-feishu-broker",
      policy: {
        dmMode: this.#config.dmMode,
        dmAllowlist: this.#config.dmAllowlist,
        groupAllowlist: this.#config.groupAllowlist,
        requireMention: this.#config.requireMention,
        respondToMentionAll: false,
      },
      outbound: { markdownConverter: "builtin" },
      logger: createSdkLogger(this.#log),
      loggerLevel: LoggerLevel.warn,
    });

    channel.on("message", (msg) => {
      this.#messageHandler?.({
        chatId: msg.chatId,
        senderId: msg.senderId,
        text: msg.content,
        imageKeys: msg.resources.filter((r) => r.type === "image").map((r) => r.fileKey),
      });
    });

    channel.on("cardAction", (evt) => {
      const action = parseApprovalAction(evt.action.value);
      if (!action) return;
      // 卡片回调不经飞书的策略管道，必须自己鉴权；
      // broker 服务多个对话，所以只校验操作人，不校验 chatId
      if (!this.#config.approverAllowlist.includes(evt.operator.openId)) {
        this.#log(`忽略非授权审批人的卡片点击：${evt.operator.openId}`, "warning");
        return;
      }
      const messageId = this.#approvals.settle(action.id, {
        allow: action.allow,
        reason: action.scope === "turn" ? "飞书批准（本回合全部允许）" : action.allow ? "飞书批准" : "飞书拒绝",
        ...(action.scope === "turn" ? { scope: "turn" as const } : {}),
      });
      if (messageId) {
        void this.#settleCard(messageId, action.scope === "turn" ? "已批准（本回合全部允许）" : action.allow ? "已批准" : "已拒绝");
      }
    });

    channel.on("reject", (evt) => this.#log(`飞书拒收消息：${evt.reason}`, "warning"));
    channel.on("error", (err) => this.#log(`飞书错误：${err.code} ${err.message}`, "error"));
    channel.on("reconnecting", () => this.#log("飞书连接断开，重连中", "warning"));
    channel.on("reconnected", () => this.#log("飞书连接已恢复"));

    await channel.connect();
    this.#channel = channel;
  }

  async disconnect(): Promise<void> {
    const stranded = this.#approvals.cancelAll({ allow: false, reason: "broker 已停止" });
    for (const messageId of stranded) await this.#settleCard(messageId, "broker 已停止");
    const channel = this.#channel;
    this.#channel = undefined;
    if (channel) {
      await channel.disconnect().catch((err: unknown) => {
        this.#log(`飞书断开连接时出错：${String(err)}`, "warning");
      });
    }
  }

  async sendText(chatId: string, markdown: string): Promise<void> {
    await this.#channel?.send(chatId, { markdown });
  }

  async streamTo(chatId: string, run: (sink: AppendSink) => Promise<void>): Promise<void> {
    const channel = this.#channel;
    if (!channel) return;
    await channel.stream(chatId, { markdown: async (controller) => run(controller) });
  }

  async downloadImage(fileKey: string): Promise<Buffer | undefined> {
    try {
      return await this.#channel?.downloadResource(fileKey, "image");
    } catch (err) {
      this.#log(`图片下载失败 ${fileKey}：${String(err)}`, "warning");
      return undefined;
    }
  }

  async describeChat(chatId: string): Promise<string | undefined> {
    try {
      const info = await this.#channel?.getChatInfo(chatId);
      return info ? chatLabel(info) : undefined;
    } catch (err) {
      this.#log(`查询会话名称失败：${String(err)}`, "warning");
      return undefined;
    }
  }

  async askCard(chatId: string, req: ApprovalRequest, signal: AbortSignal): Promise<Decision> {
    const channel = this.#channel;
    if (!channel) throw new Error("飞书未连接");
    if (signal.aborted) return { allow: false, reason: "已由其他通道处理" };

    let aborted = false;
    let onAbort: (() => void) | undefined;
    const abortedEarly = new Promise<void>((resolve) => {
      onAbort = () => {
        aborted = true;
        resolve();
      };
      signal.addEventListener("abort", onAbort, { once: true });
    });

    const id = `ap-${randomUUID()}`;
    try {
      const result = await channel.send(chatId, { card: buildApprovalCard(id, req) });
      if (aborted) {
        await this.#settleCard(result.messageId, "已在终端处理");
        return { allow: false, reason: "已由其他通道处理" };
      }
      const pending = this.#approvals.register(id, result.messageId);
      void abortedEarly.then(() => {
        const messageId = this.#approvals.cancel(id, { allow: false, reason: "已由其他通道处理" });
        if (messageId) void this.#settleCard(messageId, "已在终端处理");
      });
      return await pending;
    } finally {
      if (onAbort) signal.removeEventListener("abort", onAbort);
    }
  }

  async #settleCard(messageId: string, status: string): Promise<void> {
    try {
      await this.#channel?.updateCard(messageId, buildSettledCard(status));
    } catch (err) {
      this.#log(`审批卡片收尾失败：${String(err)}`, "error");
    }
  }
}
```

- [ ] **Step 2: 跑全量验证**

Run: `npm test && npm run typecheck`
Expected: 全绿（本任务不新增测试，只保证不破坏既有的）

- [ ] **Step 3: 提交**

```bash
git add extensions/feishu/broker/channel.ts
git commit -m "feat(broker): 多会话版飞书通道，收件人显式传入"
```

---

### Task 5: 客户端网关

**Files:**
- Create: `extensions/feishu/broker-gateway.ts`
- Test: `test/broker-gateway.test.ts`

**Interfaces:**
- Consumes: Task 1 的协议、`GatewayLike`（`./bridge.ts`）
- Produces: `class BrokerGateway implements GatewayLike`，附加 `connect(socketPath, label, cwd)` / `disconnect()` / `requestPairingCode()` / `describeBoundChat()` / `unbind()`

- [ ] **Step 1: 写失败的测试**

```ts
// test/broker-gateway.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BrokerGateway } from "../extensions/feishu/broker-gateway.ts";
import { encodeFrame, FrameReader, type ClientFrame } from "../extensions/feishu/broker/protocol.ts";

function tmpSock(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pi-feishu-gw-")), "s.sock");
}

/** 一个只会照剧本回话的假 broker */
function fakeBroker(sockPath: string, onFrame: (f: ClientFrame, reply: (x: unknown) => void) => void) {
  const server = net.createServer((socket) => {
    const reader = new FrameReader();
    socket.on("data", (b: Buffer) => {
      for (const f of reader.push(b)) {
        onFrame(f as ClientFrame, (x) => socket.write(encodeFrame(x as never)));
      }
    });
  });
  return {
    server,
    listen: () => new Promise<void>((r) => server.listen(sockPath, () => r())),
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

test("connect 发 hello 并等 hello_ok", async () => {
  const p = tmpSock();
  const seen: ClientFrame[] = [];
  const b = fakeBroker(p, (f, reply) => {
    seen.push(f);
    if (f.t === "hello") reply({ t: "hello_ok" });
  });
  await b.listen();

  const gw = new BrokerGateway(() => {});
  await gw.connect(p, "项目A", "/a");
  assert.equal(seen[0]?.t, "hello");
  await gw.disconnect();
  await b.close();
});

test("sendText 等 ok 才 resolve", async () => {
  const p = tmpSock();
  const b = fakeBroker(p, (f, reply) => {
    if (f.t === "hello") reply({ t: "hello_ok" });
    if (f.t === "send_text") reply({ t: "ok", id: f.id });
  });
  await b.listen();

  const gw = new BrokerGateway(() => {});
  await gw.connect(p, "A", "/a");
  await gw.sendText("你好"); // 不 resolve 就会超时失败
  await gw.disconnect();
  await b.close();
});

test("broker 回 err 时 sendText reject —— 由 bridge 侧兜底，不能静默成功", async () => {
  const p = tmpSock();
  const b = fakeBroker(p, (f, reply) => {
    if (f.t === "hello") reply({ t: "hello_ok" });
    if (f.t === "send_text") reply({ t: "err", id: f.id, message: "未绑定会话" });
  });
  await b.listen();

  const gw = new BrokerGateway(() => {});
  await gw.connect(p, "A", "/a");
  await assert.rejects(() => gw.sendText("你好"), /未绑定会话/);
  await gw.disconnect();
  await b.close();
});

test("入站 message 帧交给 onMessage 处理器", async () => {
  const p = tmpSock();
  let reply: ((x: unknown) => void) | undefined;
  const b = fakeBroker(p, (f, r) => {
    reply = r;
    if (f.t === "hello") r({ t: "hello_ok" });
  });
  await b.listen();

  const gw = new BrokerGateway(() => {});
  const got: string[] = [];
  gw.onMessage((m) => got.push(m.text));
  await gw.connect(p, "A", "/a");
  reply?.({ t: "message", chatId: "oc_1", senderId: "ou_1", text: "跑测试", imageKeys: [] });
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(got, ["跑测试"]);
  await gw.disconnect();
  await b.close();
});

test("bound 帧更新 boundChatId", async () => {
  const p = tmpSock();
  let reply: ((x: unknown) => void) | undefined;
  const b = fakeBroker(p, (f, r) => {
    reply = r;
    if (f.t === "hello") r({ t: "hello_ok" });
  });
  await b.listen();

  const gw = new BrokerGateway(() => {});
  await gw.connect(p, "A", "/a");
  assert.equal(gw.boundChatId, undefined);
  reply?.({ t: "bound", chatId: "oc_9" });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(gw.boundChatId, "oc_9");
  await gw.disconnect();
  await b.close();
});

test("streamTurn 把 append 转成 stream_chunk，收尾发 stream_end", async () => {
  const p = tmpSock();
  const chunks: string[] = [];
  let ended = false;
  const b = fakeBroker(p, (f, reply) => {
    if (f.t === "hello") reply({ t: "hello_ok" });
    if (f.t === "stream_chunk") chunks.push(f.text);
    if (f.t === "stream_end") {
      ended = true;
      reply({ t: "ok", id: f.id });
    }
  });
  await b.listen();

  const gw = new BrokerGateway(() => {});
  await gw.connect(p, "A", "/a");
  await gw.streamTurn(async (sink) => {
    await sink.append("前半");
    await sink.append("后半");
  });
  assert.deepEqual(chunks, ["前半", "后半"]);
  assert.equal(ended, true);
  await gw.disconnect();
  await b.close();
});

test("cardAsker 把请求发给 broker 并用回来的裁决 resolve", async () => {
  const p = tmpSock();
  const b = fakeBroker(p, (f, reply) => {
    if (f.t === "hello") reply({ t: "hello_ok" });
    if (f.t === "ask") reply({ t: "ask_result", id: f.id, allow: true, reason: "飞书批准", scope: "turn" });
  });
  await b.listen();

  const gw = new BrokerGateway(() => {});
  await gw.connect(p, "A", "/a");
  const d = await gw.cardAsker({ toolName: "bash", input: { command: "rm -rf x" } }, new AbortController().signal);
  assert.deepEqual(d, { allow: true, reason: "飞书批准", scope: "turn" });
  await gw.disconnect();
  await b.close();
});

test("连接断开时未决的请求一律 reject，不能永久挂住", async () => {
  const p = tmpSock();
  const b = fakeBroker(p, (f, reply) => {
    if (f.t === "hello") reply({ t: "hello_ok" });
    // send_text 故意不回应
  });
  await b.listen();

  const gw = new BrokerGateway(() => {});
  await gw.connect(p, "A", "/a");
  const pending = gw.sendText("你好");
  await gw.disconnect();
  await assert.rejects(() => pending, /broker/);
  await b.close();
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test "test/broker-gateway.test.ts"`
Expected: FAIL —— `Cannot find module '.../broker-gateway.ts'`

- [ ] **Step 3: 写最小实现**

```ts
// extensions/feishu/broker-gateway.ts
import net from "node:net";
import { encodeFrame, FrameReader, type ClientFrame, type ServerFrame } from "./broker/protocol.ts";
import { TurnStream, type AppendSink } from "./turn-stream.ts";
import type { GatewayLike } from "./bridge.ts";
import type { InboundMessage } from "./types.ts";
import type { Asker, Decision } from "./approval.ts";
import type { LogFn } from "./log.ts";

interface Pending {
  resolve: (f: ServerFrame) => void;
  reject: (err: Error) => void;
}

/**
 * GatewayLike 的 broker 实现：所有出站调用经 Unix socket 交给 broker，
 * 入站消息由 broker 按 chatId 路由过来。
 *
 * 与 FeishuGateway 的契约保持一致：**出站调用刻意不自我包含异常**，
 * 由 bridge.ts 侧统一兜底。
 */
export class BrokerGateway implements GatewayLike {
  #socket: net.Socket | undefined;
  #reader = new FrameReader();
  #pending = new Map<string, Pending>();
  #seq = 0;
  #bound: string | undefined;
  #messageHandler: ((msg: InboundMessage) => void) | undefined;

  readonly #log: LogFn;

  constructor(log: LogFn) {
    this.#log = log;
  }

  get boundChatId(): string | undefined {
    return this.#bound;
  }

  bind(chatId: string): void {
    // 绑定权在 broker 手里；本地只记录它告知的结果
    this.#bound = chatId;
  }

  unbind(): void {
    this.#bound = undefined;
    this.#post({ t: "unbind" });
  }

  onMessage(handler: (msg: InboundMessage) => void): void {
    this.#messageHandler = handler;
  }

  async connect(socketPath: string, label: string, cwd: string): Promise<void> {
    const socket = net.createConnection(socketPath);
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", () => resolve());
      socket.once("error", reject);
    });
    socket.on("data", (chunk: Buffer) => {
      for (const f of this.#reader.push(chunk)) this.#onFrame(f as ServerFrame);
    });
    const fail = () => this.#failAllPending("broker 连接已断开");
    socket.on("close", fail);
    socket.on("error", fail);
    this.#socket = socket;

    this.#post({ t: "hello", cwd, label });
    await this.#await("hello_ok");
  }

  async disconnect(): Promise<void> {
    const s = this.#socket;
    this.#socket = undefined;
    s?.destroy();
    this.#failAllPending("broker 连接已关闭");
  }

  async requestPairingCode(): Promise<string> {
    const id = this.#nextId();
    this.#post({ t: "pair_request", id });
    const f = (await this.#awaitId(id)) as { code: string };
    return f.code;
  }

  async sendText(markdown: string, to?: string): Promise<void> {
    const id = this.#nextId();
    this.#post({ t: "send_text", id, markdown, ...(to === undefined ? {} : { to }) });
    await this.#awaitId(id);
  }

  async streamTurn(run: (sink: AppendSink) => Promise<void>): Promise<void> {
    const id = this.#nextId();
    this.#post({ t: "stream_begin", id });
    const sink: AppendSink = {
      append: async (chunk: string) => {
        this.#post({ t: "stream_chunk", id, text: chunk });
      },
    };
    try {
      await run(sink);
    } finally {
      this.#post({ t: "stream_end", id });
    }
    await this.#awaitId(id);
  }

  async downloadImage(fileKey: string): Promise<Buffer | undefined> {
    const id = this.#nextId();
    this.#post({ t: "download_image", id, fileKey });
    const f = (await this.#awaitId(id)) as { base64?: string };
    return f.base64 === undefined ? undefined : Buffer.from(f.base64, "base64");
  }

  async describeBoundChat(): Promise<string | undefined> {
    const id = this.#nextId();
    this.#post({ t: "describe_chat", id });
    const f = (await this.#awaitId(id)) as { label?: string };
    return f.label;
  }

  cardAsker: Asker = async (req, signal): Promise<Decision> => {
    const id = this.#nextId();
    if (signal.aborted) return { allow: false, reason: "已由其他通道处理" };
    const onAbort = () => this.#post({ t: "ask_cancel", id });
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      this.#post({ t: "ask", id, toolName: req.toolName, input: req.input });
      const f = (await this.#awaitId(id)) as { allow: boolean; reason: string; scope?: "turn" };
      return { allow: f.allow, reason: f.reason, ...(f.scope === "turn" ? { scope: "turn" as const } : {}) };
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  };

  #onFrame(f: ServerFrame): void {
    switch (f.t) {
      case "message":
        this.#messageHandler?.({
          chatId: f.chatId,
          senderId: f.senderId,
          text: f.text,
          imageKeys: f.imageKeys,
        });
        return;
      case "bound":
        this.#bound = f.chatId;
        return;
      case "unbound":
        this.#bound = undefined;
        return;
      case "hello_ok":
        this.#pending.get("hello_ok")?.resolve(f);
        this.#pending.delete("hello_ok");
        return;
      default: {
        const id = (f as { id?: string }).id;
        if (id === undefined) return;
        const p = this.#pending.get(id);
        if (!p) return;
        this.#pending.delete(id);
        if (f.t === "err") p.reject(new Error(f.message));
        else p.resolve(f);
      }
    }
  }

  #nextId(): string {
    this.#seq += 1;
    return String(this.#seq);
  }

  #post(frame: ClientFrame): void {
    try {
      this.#socket?.write(encodeFrame(frame));
    } catch (err) {
      this.#log(`向 broker 发送失败：${String(err)}`, "warning");
    }
  }

  #await(key: string): Promise<ServerFrame> {
    return new Promise<ServerFrame>((resolve, reject) => {
      this.#pending.set(key, { resolve, reject });
    });
  }

  #awaitId(id: string): Promise<ServerFrame> {
    return this.#await(id);
  }

  /** 断线时把所有在途请求一次性拒掉 —— 挂住的 promise 会把整个回合冻住 */
  #failAllPending(reason: string): void {
    for (const [, p] of this.#pending) p.reject(new Error(reason));
    this.#pending.clear();
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test "test/broker-gateway.test.ts"` → 8 passed
Run: `npm test && npm run typecheck` → 全绿

- [ ] **Step 5: 提交**

```bash
git add extensions/feishu/broker-gateway.ts test/broker-gateway.test.ts
git commit -m "feat(broker): 客户端网关，GatewayLike 的 socket 实现"
```

---

### Task 6: 配置项与扩展接线

**Files:**
- Modify: `extensions/feishu/config.ts`（新增 `transport`、`brokerSocket`）
- Modify: `extensions/feishu/index.ts`（按 `transport` 选网关）
- Modify: `test/config.test.ts`
- Modify: `test/bridge.test.ts` / `test/renderer.test.ts`（fixture 补字段）

**Interfaces:**
- Consumes: `BrokerGateway`（Task 5）
- Produces: `Config.transport: "direct" | "broker"`、`Config.brokerSocket: string`

- [ ] **Step 1: 写失败的测试**

```ts
// 追加到 test/config.test.ts
test("transport 默认 direct —— 不改变存量行为", () => {
  assert.equal(loadConfig({ files: [base], env: {}, cwd: "/w" }).transport, "direct");
});

test("transport 接受 broker", () => {
  assert.equal(
    loadConfig({ files: [{ ...base, transport: "broker" }], env: {}, cwd: "/w" }).transport,
    "broker",
  );
});

test("transport 拒绝乱填的值", () => {
  const e = throwsConfigError(() =>
    loadConfig({ files: [{ ...base, transport: "socket" }], env: {}, cwd: "/w" }),
  );
  assert.ok(e.problems.some((p) => p.includes("transport")));
});

test("brokerSocket 默认在 agentDir 下", () => {
  const c = loadConfig({ files: [base], env: {}, cwd: "/w" });
  assert.ok(c.brokerSocket.endsWith("feishu-broker.sock"), c.brokerSocket);
});

test("brokerSocket 可以显式指定", () => {
  const c = loadConfig({ files: [{ ...base, brokerSocket: "/tmp/x.sock" }], env: {}, cwd: "/w" });
  assert.equal(c.brokerSocket, "/tmp/x.sock");
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test "test/config.test.ts"`
Expected: 5 条新用例 FAIL（`transport` / `brokerSocket` 是 undefined）

- [ ] **Step 3: 改 config.ts**

在 `Config` 接口里加：

```ts
  /** direct：会话自己连飞书（默认）；broker：经本地 broker 进程共用一条连接 */
  transport: "direct" | "broker";
  /** broker 档下的 Unix socket 路径 */
  brokerSocket: string;
```

在 `loadConfig` 里（放在 `bindTarget` 解析之后）：

```ts
  let transport: "direct" | "broker" = "direct";
  if (merged.transport !== undefined) {
    if (merged.transport === "direct" || merged.transport === "broker") transport = merged.transport;
    else problems.push('transport 必须是 "direct" 或 "broker"');
  }

  const brokerSocket =
    typeof merged.brokerSocket === "string"
      ? merged.brokerSocket
      : path.join(agentDir, "feishu-broker.sock");
```

`LoadConfigArgs` 增加 **可选** 字段 `agentDir?: string`——`config.test.ts` 里已有 36 处
`loadConfig({files, env, cwd})` 调用，加成必填会全部编译不过。缺省时退回 `cwd`：

```ts
  const brokerSocket =
    typeof merged.brokerSocket === "string"
      ? merged.brokerSocket
      : path.join(agentDir ?? cwd, "feishu-broker.sock");
```

`index.ts` 的 `resolveConfig` 传 `agentDir: getAgentDir()`。返回值里加上 `transport` 与 `brokerSocket`。

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test` → config 用例全绿（fixture 需要补 `transport` / `brokerSocket` 字段）
Run: `npm run typecheck` → 全绿

- [ ] **Step 5: 改 index.ts 接线**

`startInner` 里按 `transport` 选网关。原来的：

```ts
    const gw = new FeishuGateway(cfg, log);
```

改成：

```ts
    // GatewayLike 是唯一的耦合面，两种传输在这里分叉，
    // Bridge 及其下游（renderer / risk / approval）完全无感
    const gw =
      cfg.transport === "broker" ? new BrokerGateway(log) : new FeishuGateway(cfg, log);
```

`gw.connect()` 的调用点也要分叉（broker 版签名不同）：

```ts
    try {
      if (gw instanceof BrokerGateway) await gw.connect(cfg.brokerSocket, path.basename(cwd), cwd);
      else await gw.connect();
    } catch (err) {
      notify(`飞书连接失败：${String(err)}`);
      return;
    }
```

broker 档下 `bindTarget` 只支持 `code`（绑定权在 broker），因此签发配对码改为向 broker 请求：

```ts
    if (cfg.transport === "broker") {
      const code = await (gw as BrokerGateway).requestPairingCode();
      notify(`飞书桥接已启动（broker 模式），在要绑定的对话里发送配对码：\n\n    ${code}\n`);
      return;
    }
```

- [ ] **Step 6: 跑全量验证**

Run: `npm test && npm run typecheck` → 全绿

- [ ] **Step 7: 提交**

```bash
git add extensions/feishu/config.ts extensions/feishu/index.ts test/
git commit -m "feat(broker): transport 配置项，扩展按档选网关"
```

---

### Task 7: broker 进程入口与文档

**Files:**
- Create: `bin/broker.ts`
- Modify: `package.json`（`bin` 字段）
- Modify: `README.md`

**Interfaces:**
- Consumes: `BrokerChannel`（Task 4）、`BrokerServer`（Task 3）、`loadConfig`（Task 6）
- Produces: 可执行入口 `pi-feishu-broker`

- [ ] **Step 1: 写入口**

```ts
// bin/broker.ts
#!/usr/bin/env node
import path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { loadConfig, readConfigFile, ConfigError } from "../extensions/feishu/config.ts";
import { BrokerChannel } from "../extensions/feishu/broker/channel.ts";
import { BrokerServer } from "../extensions/feishu/broker/server.ts";

// broker 是独立进程，没有 pi 的 TUI 可冲，所以这里写 stderr 是对的 ——
// 这是 log.ts「绝不裸写 stderr」那条规则的唯一例外，且仅限本文件
const log = (msg: string, level: string = "info") => {
  process.stderr.write(`[broker][${level}] ${msg}\n`);
};

const cwd = process.cwd();
let config;
try {
  config = loadConfig({
    files: [
      readConfigFile(path.join(getAgentDir(), "feishu.json")),
      readConfigFile(path.join(cwd, ".pi", "feishu.json")),
    ],
    env: process.env,
    cwd,
    agentDir: getAgentDir(),
  });
} catch (err) {
  log(err instanceof ConfigError ? err.message : String(err), "error");
  process.exit(1);
}

const channel = new BrokerChannel(config, log);
const server = new BrokerServer({
  channel,
  pairingTtlMs: config.pairingTtlMs,
  log,
});
channel.onMessage((msg) => server.deliver(msg));

await channel.connect();
await server.listen(config.brokerSocket);
log(`broker 已就绪：${config.brokerSocket}`);

let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  log("正在停止…");
  await server.close();
  await channel.disconnect();
  process.exit(0);
};
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
```

- [ ] **Step 2: 加 bin 字段**

`package.json` 增加：

```json
  "bin": { "pi-feishu-broker": "./bin/broker.ts" },
```

- [ ] **Step 3: 手动冒烟（需要真实飞书应用）**

```bash
# 终端 1
node --experimental-strip-types bin/broker.ts
# 期望：打印「broker 已就绪：/root/.pi/agent/feishu-broker.sock」

# 终端 2：确认权限
stat -c '%a' /root/.pi/agent/feishu-broker.sock   # 期望 600

# 终端 3：在项目里配 transport: "broker" 后启动 pi，跑 /feishu start
# 期望：终端打印配对码；在飞书对话里发送该码 → 回「配对成功」
```

- [ ] **Step 4: 补 README**

在「一个 pi 会话配一个 bot」一节后追加 broker 模式说明：部署方式、`transport` 配置、socket 权限即鉴权、broker 挂掉的表现、与 direct 模式的取舍。

- [ ] **Step 5: 跑全量验证并提交**

```bash
npm test && npm run typecheck
git add bin/broker.ts package.json README.md
git commit -m "feat(broker): 进程入口与文档"
```

---

## 已知取舍与未覆盖项

- **broker 挂掉 = 所有会话失联**。当前设计不做自动重连：`BrokerGateway` 断线后把在途请求全部 reject，会话侧退回「飞书不可用」，需要人工重启 broker 并重新 `/feishu start`。自动重连留待后续。
- **鉴权只有文件权限**。同一用户下的其他进程可以连上 broker 冒充会话。防同用户提权不在本轮范围内 —— 真要防得加 token 或 `SO_PEERCRED` 校验。
- **Windows 未验证**。`net` 在 Windows 上要用命名管道路径（`\\.\pipe\...`），且没有 `chmod` 语义。broker 模式先只声明支持 Linux/macOS。
- **图片经 base64 走 socket**。大图会在两端各占一份内存副本；当前图片本来就要整块读进内存，没有变差，但不适合超大文件。
- `bindTarget` 的 `operator` / `oc_xxx` / `none` 三档在 broker 模式下**不生效**，只支持配对码。绑定权在 broker，会话侧无法单方面决定绑谁。

---

## 实施后遗留（终审复审记录，非阻塞）

本计划已实施完毕并通过整支分支终审。以下三条是终审复审明确判为「可下一波处理」的遗留项，
记录在此以免随过程台账一起丢失：

1. **卡片鉴权仍有一个未覆盖场景**：会话绑定 chat X 时弹出审批卡片 → 操作员改绑到 chat Y →
   X 里那张陈旧卡片仍可被 `approverAllowlist` 内的人点「允许」并生效。
   `ApprovalRegistry` 现在按 chatId 登记，但这张卡片本来就发往 X、来自 X 的点击与登记一致，
   所以挡不住。风险边界清楚（仅限已授权审批人、且仅限该会话曾经绑过的对话，不是权限外溢）。
   最小修法不是「解绑时撤销全部未决审批」，而是**登记时一并记下发起 ask 的连接 id，
   settle 时复查 `registry.boundChatOf(connId) === event.chatId`** —— `server.ts` 在那个位置
   已经拿得到这个值。

2. **`server.ts` 里 `#send(displaced, {t:"unbound"})` 当前不可达**：`deliver()` 会先命中
   `byChat` 直接投给 owner，轮不到 `matchCode` 分支。`registry.bind()` 返回被顶掉会话 id
   这个契约本身是对的且有真测试，所以代码该留而不是删 —— 它是给将来放开
   「已绑对话内换绑」时的防御。**但调用点缺一句注释说明这一点**，现在只写在测试注释里。

3. **`#dispatch` 的 docstring 措辞不精确**：写的是「带 id 的请求必须收到 ok/err 之一」，
   但 `stream_begin` 的成功路径刻意不回响应（响应挂在 `stream_end` 的同 id 上）。
   客户端不 await 它，不会挂起，但注释该说清楚这个例外。
