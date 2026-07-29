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
    /** 绕过 encodeFrame 的类型约束，直接写入任意一行文本（用于构造畸形帧） */
    sendRaw: (line: string) => sock.write(`${line}\n`),
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

test("形状不对的畸形帧被静默忽略，不影响后续正常帧", async () => {
  // protocol.ts 的 FrameReader 只做 JSON.parse + 类型断言，不做运行时校验，
  // 所以 `42`、`{"t":"不存在的类型"}` 这类合法 JSON 但不是 Frame 的行会被当成
  // Frame 交给 #handle。#handle 的 switch 必须有 default 分支兜底，
  // 否则一个畸形帧就能让 broker 直接崩掉（TypeError 或 unhandled 分支）。
  const server = new BrokerServer({ channel: fakeChannel([]), pairingTtlMs: 600_000, log: () => {} });
  const p = tmpSock();
  await server.listen(p);
  const c = await connect(p);

  // 未知的 t
  c.sendRaw(JSON.stringify({ t: "不存在的类型" }));
  // 合法 JSON 但完全不是对象形状
  c.sendRaw(JSON.stringify(42));
  // 后续正常帧仍应被正常处理，证明 broker 没有崩
  c.send({ t: "hello", cwd: "/w", label: "A" });
  await c.waitFor("hello_ok");
  assert.equal(server.sessionCount, 1);

  c.sock.destroy();
  await server.close();
});
