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
  const raw = channel.rawClient as unknown as {
    cardkit: {
      v1: {
        card: { create: unknown; settings: unknown };
        cardElement: { content: unknown };
      };
    };
    im: { v1: { message: { create: unknown } } };
  };
  raw.cardkit.v1.card.create = async () => ({ data: { card_id: "card_1" } });
  raw.cardkit.v1.card.settings = async () => ({ code: 0 });
  raw.cardkit.v1.cardElement.content = async (req: { data?: { content?: string } }) => {
    patched.push(req.data?.content ?? "");
    return { code: 0 };
  };
  raw.im.v1.message.create = async () => ({ data: { message_id: "om_1", chat_id: "oc_1" } });

  return { channel, patched };
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
