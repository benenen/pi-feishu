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

test("配对成功会给该 chat 发一句确认文案，不能让用户输完码没有任何反馈", async () => {
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

  const confirm = sent.find((s) => s.chatId === "oc_1");
  assert.ok(confirm, "应该给绑定的 chat 发一句配对成功的确认");
  assert.ok(confirm?.text.includes("配对成功"));

  c.sock.destroy();
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
  // 绑定成功会往 sent 里塞一条确认文案（见上一个测试）；这里只关心流式本身，
  // 清空掉避免两个各自独立的行为互相污染断言。
  sent.length = 0;

  c.send({ t: "stream_begin", id: "s" });
  c.send({ t: "stream_chunk", id: "s", text: "前半" });
  c.send({ t: "stream_chunk", id: "s", text: "后半" });
  c.send({ t: "stream_end", id: "s" });
  await c.waitFor("ok");
  assert.equal(sent.map((x) => x.text).join(""), "前半后半");

  c.sock.destroy();
  await server.close();
});

test("连接在流式中途断开：孤儿流不会变成 unhandledRejection", async () => {
  // 关键点：streamTo 的失败要设计成与 run(sink)/pump 是否收尾无关 —— 真实网络里，
  // 底层连接失败不会等本地缓冲区排空。如果这里写成 `await run(sink); throw ...`，
  // 那么在没打这个补丁之前 pump() 会永远卡住（没人再 push/finish），streamTo 的
  // promise 也就永远不会走到 throw 这一步、永远不会 reject —— 测试会因为
  // "根本没发生 reject" 而假绿，测不出 unhandledRejection 这个症状。
  // 所以用一个独立的定时器模拟"断线之后过一会儿才失败"，不依赖 pump 是否结束。
  const channel: BrokerChannelLike = {
    async sendText() {},
    async streamTo(_chatId, run) {
      void run({ append: async () => {} });
      await new Promise<void>((_resolve, reject) => {
        setTimeout(() => reject(new Error("连接抖动导致流式发送失败")), 20);
      });
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

  let rejections = 0;
  const onUnhandledRejection = () => {
    rejections += 1;
  };
  process.on("unhandledRejection", onUnhandledRejection);

  const server = new BrokerServer({ channel, pairingTtlMs: 600_000, log: () => {} });
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
  c.send({ t: "stream_chunk", id: "s", text: "写到一半" });
  // 不等 stream_end，直接断线 —— stream_end 永远不会再来了
  c.sock.destroy();

  // 给 streamTo 的假失败和 drop() 的清理都留够时间跑完
  await new Promise((r) => setTimeout(r, 100));

  process.removeListener("unhandledRejection", onUnhandledRejection);
  assert.equal(rejections, 0, "孤儿流的 rejection 必须被 drop() 兜住，不能冒成 unhandledRejection");

  await server.close();
});

test("流式中途失败但连接没断：done 的 rejection 不能冒成 unhandledRejection", async () => {
  // 上一条测试靠 sock.destroy() 让 drop() 抢先给 done 挂上 catch，覆盖的是断线路径。
  // 这一条覆盖**不断线**的普通路径：飞书限流 / 卡片元素超限 / 网络抖动会让 streamTo
  // 在几十毫秒内 reject，而客户端的 stream_end 要等整个回合跑完（数秒到数分钟）才发出。
  // 那段窗口里 done 没有任何 handler —— Node 在当前事件循环末尾判定 unhandledRejection，
  // bin/broker.ts 的处理器直接 process.exit(1)：一次普通的流式失败打死整个 broker，
  // 挂在它上面的所有会话同时失联。
  const channel: BrokerChannelLike = {
    async sendText() {},
    async streamTo(_chatId, run) {
      // 失败与 pump 是否收尾无关 —— 真实网络里底层连接失败不会等本地缓冲区排空
      void run({ append: async () => {} });
      await new Promise<void>((_resolve, reject) => {
        setTimeout(() => reject(new Error("飞书限流，流式发送失败")), 20);
      });
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

  let rejections = 0;
  const onUnhandledRejection = () => {
    rejections += 1;
  };
  process.on("unhandledRejection", onUnhandledRejection);

  const server = new BrokerServer({ channel, pairingTtlMs: 600_000, log: () => {} });
  const p = tmpSock();
  await server.listen(p);
  const c = await connect(p);
  c.send({ t: "hello", cwd: "/w", label: "A" });
  await c.waitFor("hello_ok");
  c.send({ t: "pair_request", id: "1" });
  const code = (await c.waitFor("pair_code")) as { code: string };
  server.deliver({ chatId: "oc_1", senderId: "ou_1", text: code.code, imageKeys: [] });
  await c.waitFor("bound");

  try {
    c.send({ t: "stream_begin", id: "s" });
    c.send({ t: "stream_chunk", id: "s", text: "写到一半" });
    // 连接**不断**，只是回合还没结束：模拟长回合里 stream_end 迟迟不来
    await new Promise((r) => setTimeout(r, 120));

    process.removeListener("unhandledRejection", onUnhandledRejection);
    assert.equal(rejections, 0, "回合进行中的流式失败必须已被标记处理，不能打死 broker");

    // 标记已处理不等于吞掉结果：stream_end 到达时仍要把失败如实告诉客户端，
    // 否则 bridge 会以为流式成功而不补发全文
    c.send({ t: "stream_end", id: "s" });
    const err = (await c.waitFor("err")) as { message: string };
    assert.match(err.message, /飞书限流/);
  } finally {
    // 断言失败也必须收拾干净：留着 socket/server 不关，node:test 会因为句柄
    // 没释放而整个挂住 —— 那样连「红」都看不到
    process.removeListener("unhandledRejection", onUnhandledRejection);
    c.sock.destroy();
    await server.close();
  }
});

test("channel 抛错时回 err —— 既不回 ok 也不回 err 会让客户端永久挂起", async () => {
  // send_text 里 await channel.sendText() 一旦 reject（飞书 429 / 参数错 / 网络抖），
  // 客户端那个 promise 永不 settle：Bridge.endTurn() 的补发全文那步会一直等下去，
  // pi 的 agent_end 处理器永不返回，整个回合冻住。
  const channel: BrokerChannelLike = {
    ...fakeChannel([]),
    async sendText() {
      throw new Error("飞书 API 429");
    },
  };
  const server = new BrokerServer({ channel, pairingTtlMs: 600_000, log: () => {} });
  const p = tmpSock();
  await server.listen(p);
  const c = await connect(p);
  c.send({ t: "hello", cwd: "/w", label: "A" });
  await c.waitFor("hello_ok");
  c.send({ t: "pair_request", id: "1" });
  const code = (await c.waitFor("pair_code")) as { code: string };
  server.deliver({ chatId: "oc_1", senderId: "ou_1", text: code.code, imageKeys: [] });
  await c.waitFor("bound");

  try {
    c.send({ t: "send_text", id: "9", markdown: "结果" });
    const err = (await c.waitFor("err")) as { id: string; message: string };
    assert.equal(err.id, "9", "err 必须带回请求的 id，否则客户端认不出是哪个 pending");
    assert.match(err.message, /429/);
  } finally {
    c.sock.destroy();
    await server.close();
  }
});

test("registry 抛错的请求同样要回 err —— 否则 requestPairingCode 永久挂起", async () => {
  // 没 hello 就 pair_request：registry.issueCode 对未知会话 throw。
  // 这条路径不回帧的话，扩展侧 startInner 里的 requestPairingCode() 永不返回，
  // 会话永远卡在「飞书桥接正在启动中」。
  const server = new BrokerServer({ channel: fakeChannel([]), pairingTtlMs: 600_000, log: () => {} });
  const p = tmpSock();
  await server.listen(p);
  const c = await connect(p);

  try {
    c.send({ t: "pair_request", id: "7" });
    const err = (await c.waitFor("err")) as { id: string; message: string };
    assert.equal(err.id, "7");
    assert.match(err.message, /未知会话/);
  } finally {
    c.sock.destroy();
    await server.close();
  }
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

test("对已被占用的 socket 再次 listen 会被拒绝，且原 server 仍可用", async () => {
  const serverA = new BrokerServer({ channel: fakeChannel([]), pairingTtlMs: 600_000, log: () => {} });
  const p = tmpSock();
  await serverA.listen(p);

  const serverB = new BrokerServer({ channel: fakeChannel([]), pairingTtlMs: 600_000, log: () => {} });
  await assert.rejects(() => serverB.listen(p), /已被另一个 broker 占用/);

  // 关键断言：第二次 listen 失败不能连累第一个 —— 它必须还活着，
  // 还能正常接受新连接、走完整个握手。
  const c = await connect(p);
  c.send({ t: "hello", cwd: "/w", label: "A" });
  await c.waitFor("hello_ok");
  assert.equal(serverA.sessionCount, 1);

  c.sock.destroy();
  await serverA.close();
});

test("崩溃残留的死 socket 文件（没有活着的监听者）仍然会被正常清理并 listen 成功", async () => {
  const p = tmpSock();
  // 模拟「上次非正常退出」：路径上有个文件，但没有任何进程在监听它
  fs.writeFileSync(p, "残留文件，不是真的 socket");

  const server = new BrokerServer({ channel: fakeChannel([]), pairingTtlMs: 600_000, log: () => {} });
  await server.listen(p);
  assert.equal(fs.statSync(p).mode & 0o777, 0o600);

  await server.close();
});

test("孤儿 stream_chunk / stream_end 各留一条 warning，stream_end 仍照常回 ok", async () => {
  const logs: Array<{ msg: string; level?: string }> = [];
  const server = new BrokerServer({
    channel: fakeChannel([]),
    pairingTtlMs: 600_000,
    log: (msg, level) => void logs.push({ msg, level }),
  });
  const p = tmpSock();
  await server.listen(p);
  const c = await connect(p);
  c.send({ t: "hello", cwd: "/w", label: "A" });
  await c.waitFor("hello_ok");

  // 没发过 stream_begin，这个 id 从一开始就是野的（id 打错，或 stream_end/断线
  // 清理已经跑过）——静默丢弃排查起来会很痛苦，至少要留痕
  c.send({ t: "stream_chunk", id: "野id", text: "没人接" });
  c.send({ t: "stream_end", id: "野id" });
  await c.waitFor("ok"); // stream_end 依然要回 ok，不能让客户端以为发送失败

  assert.ok(
    logs.some((l) => l.msg.includes("stream_chunk") && l.msg.includes("野id")),
    "孤儿 stream_chunk 要留痕",
  );
  assert.ok(
    logs.some((l) => l.msg.includes("stream_end") && l.msg.includes("野id")),
    "孤儿 stream_end 要留痕",
  );

  c.sock.destroy();
  await server.close();
});

test("孤儿 stream_chunk 每个 id 只记一次日志 —— 不能一个回合刷几百条", async () => {
  // broker 档下未配对时，会话侧每个回合都会把整回合的 delta 推过来。
  // 每块记一条 warning 的话，200 个 delta 就是 200 条 —— 日志被冲得没法看。
  const logs: Array<{ msg: string; level?: string }> = [];
  const server = new BrokerServer({
    channel: fakeChannel([]),
    pairingTtlMs: 600_000,
    log: (msg, level) => void logs.push({ msg, level }),
  });
  const p = tmpSock();
  await server.listen(p);
  const c = await connect(p);
  try {
    c.send({ t: "hello", cwd: "/w", label: "A" });
    await c.waitFor("hello_ok");

    for (let i = 0; i < 30; i += 1) c.send({ t: "stream_chunk", id: "野id", text: `第${i}块` });
    c.send({ t: "stream_chunk", id: "另一个野id", text: "别的流" });
    // 帧是按序处理的：等这条的响应到手，就说明上面的 chunk 都处理完了
    c.send({ t: "send_text", id: "屏障", markdown: "x" });
    await c.waitFor("err");

    const chunkLogs = logs.filter((l) => l.msg.includes("stream_chunk"));
    assert.equal(chunkLogs.length, 2, `每个 id 一条，实际 ${chunkLogs.length} 条`);
    assert.ok(chunkLogs.some((l) => l.msg.includes("野id")));
    assert.ok(chunkLogs.some((l) => l.msg.includes("另一个野id")));
  } finally {
    c.sock.destroy();
    await server.close();
  }
});
