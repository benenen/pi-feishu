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

test("broker 收下请求却完全不回应时，客户端超时 reject，不把 agent 回合冻住", async () => {
  // broker 侧任何一处漏回帧（吞掉异常、被 SIGSTOP、内部 bug），没有超时的话
  // pending 就永远不会 settle —— bridge.endTurn() 正好 await 它，结果是回合
  // 永久冻住，只能重启 pi。
  const p = tmpSock();
  const b = fakeBroker(p, (f, reply) => {
    if (f.t === "hello") reply({ t: "hello_ok" });
    // send_text 故意既不回 ok 也不回 err —— 模拟 broker 把异常吞掉了
  });
  await b.listen();

  const gw = new BrokerGateway(() => {}, 120);
  await gw.connect(p, "A", "/a");

  // 不能直接 await：没修之前这个 promise 永远不 settle，测试会挂死而不是失败。
  // 用一条独立的看门狗把「挂起」变成一个可断言的结果。
  const outcome = await Promise.race([
    gw.sendText("你好").then(
      () => "resolved",
      (err: unknown) => `rejected:${String(err)}`,
    ),
    new Promise<string>((r) => setTimeout(() => r("hung"), 1500)),
  ]);
  // 先收拾干净再断言：断言失败会跳过后面的清理，留着 server/socket 不关，
  // node:test 会因为句柄没释放而整个挂住 —— 那样连「红」都看不到
  await gw.disconnect();
  await b.close();
  assert.match(outcome, /rejected:.*超时/, `期望超时 reject，实际：${outcome}`);
});

test("超时只针对普通请求：审批（ask）可以等人点按钮，不受它约束", async () => {
  // 人点按钮本来就可能超过请求超时；ask 的超时由 approval.ts 的 approvalTimeoutMs
  // 统一管（超时会 abort，broker 收到 ask_cancel 后照样回 ask_result）。
  // 在这里也套一个短超时的话，稍慢一点的审批会被误判成通道故障。
  const p = tmpSock();
  let answer: ((x: unknown) => void) | undefined;
  const b = fakeBroker(p, (f, reply) => {
    if (f.t === "hello") reply({ t: "hello_ok" });
    if (f.t === "ask") {
      answer = () => reply({ t: "ask_result", id: f.id, allow: true, reason: "飞书批准" });
    }
  });
  await b.listen();

  const gw = new BrokerGateway(() => {}, 60);
  await gw.connect(p, "A", "/a");
  const asked = gw.cardAsker({ toolName: "bash", input: {} }, new AbortController().signal);
  // 远超请求超时之后才有人点按钮
  await new Promise((r) => setTimeout(r, 300));
  answer?.(undefined);
  assert.deepEqual(await asked, { allow: true, reason: "飞书批准" });

  await gw.disconnect();
  await b.close();
});

test("broker 意外断线后 describeBoundChat 自我兜底，返回 undefined 而不是 reject", async () => {
  // 与 sendText/streamTurn 等业务方法不同：describeBoundChat 返回的只是可有
  // 可无的展示名称，状态查询不该因为它失败而整体报错，必须和 FeishuGateway
  // 的 describeBoundChat 一样自我兜底
  const p = tmpSock();
  let serverSocket: net.Socket | undefined;
  const server = net.createServer((socket) => {
    serverSocket = socket;
    const reader = new FrameReader();
    socket.on("data", (chunk: Buffer) => {
      for (const f of reader.push(chunk) as ClientFrame[]) {
        if (f.t === "hello") socket.write(encodeFrame({ t: "hello_ok" }));
      }
    });
  });
  await new Promise<void>((r) => server.listen(p, () => r()));

  const gw = new BrokerGateway(() => {});
  await gw.connect(p, "A", "/a");

  // 模拟 broker 崩溃：服务端主动断开，客户端全程不调用 disconnect()
  serverSocket?.destroy();
  await new Promise((r) => setTimeout(r, 50));

  assert.equal(await gw.describeBoundChat(), undefined);

  await gw.disconnect();
  await new Promise<void>((r) => server.close(() => r()));
});

test("意外断线（不调用 disconnect）之后，新发起的请求立刻 reject，不能永久挂住", async () => {
  const p = tmpSock();
  let serverSocket: net.Socket | undefined;
  const server = net.createServer((socket) => {
    serverSocket = socket;
    const reader = new FrameReader();
    socket.on("data", (chunk: Buffer) => {
      for (const f of reader.push(chunk) as ClientFrame[]) {
        if (f.t === "hello") socket.write(encodeFrame({ t: "hello_ok" }));
      }
    });
  });
  await new Promise<void>((r) => server.listen(p, () => r()));

  const gw = new BrokerGateway(() => {});
  await gw.connect(p, "A", "/a");

  // 模拟 broker 崩溃：服务端主动断开，客户端全程不调用 disconnect()
  serverSocket?.destroy();
  // 等断线事件（close/error）真正落地到客户端 socket 上
  await new Promise((r) => setTimeout(r, 50));

  // 断线之后才发起的新请求：不能借着一个已经死掉的 socket 永久挂起，必须立刻 reject
  await assert.rejects(() => gw.sendText("你好"), /broker/);

  await gw.disconnect();
  await new Promise<void>((r) => server.close(() => r()));
});
