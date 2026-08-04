import { test } from "node:test";
import assert from "node:assert/strict";
import { createLarkChannel, LoggerLevel } from "@larksuiteoapi/node-sdk";
import { cumulativeSink } from "../extensions/feishu/turn-stream.ts";

/**
 * 对着**真实的 SDK 对象**跑流式，只把最外层的 HTTP 打掉。
 *
 * turn-stream.test.ts 里那个替身是手抄的合并算法，SDK 一改它就悄悄失真；这里
 * 直接驱动 `channel.stream()`，断言真正 PATCH 给飞书的正文与我们想发的一字不差。
 * 换 SDK 版本后如果它的合并策略变了，这条会当场红。
 */
function offlineChannel() {
  const channel = createLarkChannel({
    appId: "cli_test",
    appSecret: "test",
    transport: "websocket",
    source: "pi-feishu-test",
    policy: {
      dmMode: "open",
      dmAllowlist: [],
      groupAllowlist: [],
      requireMention: true,
      respondToMentionAll: false,
    },
    outbound: { markdownConverter: "builtin" },
    logger: { debug() {}, info() {}, warn() {}, error() {}, trace() {} },
    loggerLevel: LoggerLevel.warn,
  });

  const patched: string[] = [];
  const uploads: Array<{ image_type?: string; image?: unknown }> = [];
  const messages: Array<{ msg_type?: string; content?: string }> = [];
  const raw = channel.rawClient as unknown as {
    cardkit: {
      v1: {
        card: { create: unknown; settings: unknown };
        cardElement: { content: unknown };
      };
    };
    im: { v1: { message: { create: unknown; reply: unknown }; image: { create: unknown } } };
  };
  const replies: Array<{ message_id?: string; reply_in_thread?: boolean }> = [];
  raw.im.v1.message.reply = async (req: {
    path?: { message_id?: string };
    data?: { reply_in_thread?: boolean };
  }) => {
    replies.push({ message_id: req.path?.message_id, reply_in_thread: req.data?.reply_in_thread });
    return { data: { message_id: "om_reply" } };
  };
  raw.cardkit.v1.card.create = async () => ({ data: { card_id: "card_1" } });
  raw.cardkit.v1.card.settings = async () => ({ code: 0 });
  raw.cardkit.v1.cardElement.content = async (req: { data?: { content?: string } }) => {
    patched.push(req.data?.content ?? "");
    return { code: 0 };
  };
  raw.im.v1.message.create = async (req: { data?: { msg_type?: string; content?: string } }) => {
    messages.push({ msg_type: req.data?.msg_type, content: req.data?.content });
    return { data: { message_id: "om_1", chat_id: "oc_1" } };
  };
  // codegen 客户端会把外层信封剥掉，image_key 直接在顶层 —— 替身照这个形状回
  raw.im.v1.image.create = async (req: { data?: { image_type?: string; image?: unknown } }) => {
    uploads.push({ image_type: req.data?.image_type, image: req.data?.image });
    return { image_key: "img_test_1" };
  };

  return { channel, patched, uploads, messages, replies };
}

test("真 SDK：包了 cumulativeSink 之后，切在重复字符中间也一字不差", async () => {
  const { channel, patched } = offlineChannel();
  await channel.stream("oc_1", {
    markdown: async (controller) => {
      const sink = cumulativeSink(controller);
      await sink.append("会话名 **ln");
      await sink.append("ny** 跑完了");
    },
  });
  assert.equal(patched.at(-1), "会话名 **lnny** 跑完了");
});

test("真 SDK：裸喂增量会丢字 —— 这就是 cumulativeSink 存在的理由", async () => {
  const { channel, patched } = offlineChannel();
  await channel.stream("oc_1", {
    markdown: async (controller) => {
      await controller.append("会话名 **ln");
      await controller.append("ny** 跑完了");
    },
  });
  // 1.71.1 的 mergeStreamingText 把重叠的 n 去掉了。哪天 SDK 自己修好了这条会红，
  // 那时可以重新评估 cumulativeSink 还要不要留 —— 但别在没看过新实现前就删。
  assert.equal(patched.at(-1), "会话名 **lny** 跑完了");
});

test("真 SDK：发图片走 im/v1/images 上传 + msg_type=image，不是发链接", async () => {
  const { channel, uploads, messages } = offlineChannel();
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  await channel.send("oc_1", { image: { source: png } });

  assert.equal(uploads.length, 1, "应该先把图上传成 image_key");
  assert.equal(uploads[0].image_type, "message");
  assert.ok(Buffer.isBuffer(uploads[0].image), "上传的是图片字节本身");
  assert.equal(messages.at(-1)?.msg_type, "image");
  assert.deepEqual(JSON.parse(messages.at(-1)?.content ?? "{}"), { image_key: "img_test_1" });
});

test("真 SDK：带 replyTo 时改走 im.v1.message.reply，并带上 reply_in_thread", async () => {
  const { channel, replies, messages } = offlineChannel();
  await channel.send("oc_1", { markdown: "在话题里回一句" }, { replyTo: "om_ask", replyInThread: true });

  assert.equal(messages.length, 0, "有 replyTo 就不该走 message.create，否则会另起一个话题");
  assert.equal(replies.length, 1);
  assert.equal(replies[0].message_id, "om_ask", "回复挂在触发这轮的那条消息上");
  assert.equal(replies[0].reply_in_thread, true);
});

test("真 SDK：不带 replyTo 时仍走 message.create —— 普通群行为不变", async () => {
  const { channel, replies, messages } = offlineChannel();
  await channel.send("oc_1", { markdown: "普通群回一句" });
  assert.equal(replies.length, 0);
  assert.equal(messages.length, 1);
});

test("真 SDK：多段增量按序拼回，不重不漏", async () => {
  const { channel, patched } = offlineChannel();
  const parts = ["# 标题\n", "正文", "文字", "\n\n", "\n\n", "尾巴"];
  await channel.stream("oc_1", {
    markdown: async (controller) => {
      const sink = cumulativeSink(controller);
      for (const p of parts) await sink.append(p);
    },
  });
  assert.equal(patched.at(-1), parts.join(""));
});
