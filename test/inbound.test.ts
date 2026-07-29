import { test } from "node:test";
import assert from "node:assert/strict";
import { ChatNameCache, toInbound } from "../extensions/feishu/inbound.ts";

function sdkMsg(over: Record<string, unknown> = {}) {
  return {
    messageId: "om_1",
    chatId: "oc_1",
    chatType: "group" as const,
    senderId: "ou_1",
    senderName: "张三",
    content: "你好",
    resources: [],
    ...over,
  };
}

test("SDK 消息映射：名字与 id 都带上", () => {
  const msg = toInbound(sdkMsg(), "后端组");
  assert.equal(msg.chatName, "后端组");
  assert.equal(msg.senderName, "张三");
  assert.equal(msg.chatId, "oc_1");
  assert.equal(msg.senderId, "ou_1");
  assert.equal(msg.text, "你好");
});

test("SDK 没给发送者名字时留空，绝不编一个", () => {
  const msg = toInbound(sdkMsg({ senderName: undefined }), "后端组");
  assert.equal(msg.senderName, undefined);
});

test("只挑图片资源 —— 文件/音频不是本扩展能转成 prompt 的东西", () => {
  const msg = toInbound(
    sdkMsg({
      resources: [
        { type: "image", fileKey: "img_1" },
        { type: "file", fileKey: "f_1" },
        { type: "image", fileKey: "img_2" },
      ],
    }),
    undefined,
  );
  assert.deepEqual(msg.imageKeys, ["img_1", "img_2"]);
});

test("群聊查一次就记住，第二条消息不再打 API", async () => {
  let calls = 0;
  const cache = new ChatNameCache(async () => {
    calls += 1;
    return { name: "后端组", chatType: "group" as const };
  });
  assert.equal(await cache.resolve("oc_1", "group"), "后端组");
  assert.equal(await cache.resolve("oc_1", "group"), "后端组");
  assert.equal(calls, 1, `打了 ${calls} 次 API —— 每条消息一次查询换一个装饰性字段不值得`);
});

test("私聊根本不查 API —— 飞书那边私聊没有名字，查了也是空", async () => {
  let calls = 0;
  const cache = new ChatNameCache(async () => {
    calls += 1;
    return { chatType: "p2p" as const };
  });
  assert.equal(await cache.resolve("oc_dm", "p2p"), "私聊");
  assert.equal(calls, 0, "为一个必然为空的字段多打一次网络请求");
});

test("查询失败不抛，退回按类型的说法 —— 名字查不到不该让消息处理不下去", async () => {
  const cache = new ChatNameCache(async () => {
    throw new Error("permission denied");
  });
  assert.equal(await cache.resolve("oc_1", "group"), "群聊");
});

test("查询失败也记住结果，不为一个装饰性字段每条消息重试一次", async () => {
  let calls = 0;
  const cache = new ChatNameCache(async () => {
    calls += 1;
    throw new Error("permission denied");
  });
  await cache.resolve("oc_1", "group");
  await cache.resolve("oc_1", "group");
  assert.equal(calls, 1);
});

test("同一对话的并发查询共用一次调用，且按到达顺序返回", async () => {
  // 这个查询插在「收到消息」和「投给 pi」之间，两条紧挨着的消息若在这里
  // 抢跑，用户在飞书里说的两句话会倒着进 agent 上下文
  let calls = 0;
  let release: ((v: { name: string }) => void) | undefined;
  const cache = new ChatNameCache(() => {
    calls += 1;
    return new Promise((r) => {
      release = r;
    });
  });

  const order: number[] = [];
  const first = cache.resolve("oc_1", "group").then(() => void order.push(1));
  const second = cache.resolve("oc_1", "group").then(() => void order.push(2));
  release?.({ name: "后端组" });
  await Promise.all([first, second]);

  assert.equal(calls, 1, "同一个对话的两条消息各查了一次");
  assert.deepEqual(order, [1, 2], "后到的消息先拿到结果，会把两句话的顺序颠倒");
});
