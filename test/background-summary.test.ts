import { test } from "node:test";
import assert from "node:assert/strict";
import { Bridge, type GatewayLike } from "../extensions/feishu/bridge.ts";
import { loadConfig } from "../extensions/feishu/config.ts";

function setup() {
  const sent: { text: string; to: unknown }[] = [];
  const gateway: GatewayLike = {
    boundChatId: "其他对话",
    bind() {},
    onMessage() {},
    async sendText(text, to) { sent.push({ text, to }); },
    async streamTurn(run, to) { await run({ append: async (text) => { sent.push({ text, to }); } }); },
    askerFor: () => async () => ({ allow: false, reason: "拒绝" }),
    async downloadImage() { return undefined; },
  };
  const config = loadConfig({ files: [{ appId: "a", appSecret: "s", approverAllowlist: ["u"], multiChat: true }], env: {}, cwd: "/repo" });
  const bridge = new Bridge(config, gateway, () => {});
  return { bridge, sent };
}
const to = { chatId: "原群", replyTo: "原飞书问题", inThread: true };
const completed = { id: "call_00_task", name: "herdr_send_prompt", to, threadId: "原话题", question: "今天有哪些新闻？", body: "原始日志：新闻甲，新闻乙；来源 https://example.com/news", failed: false };

test("watcher 完成只排总结任务，忙时不发送原始日志，独立回合回答原话题", async () => {
  const { bridge, sent } = setup();
  bridge.startTurn();
  assert.equal(bridge.enqueueBackgroundResult("summary-1", completed), true);
  assert.equal(sent.length, 0, "原始工具结果不能直接发给用户");
  await bridge.endTurn();
  assert.equal(bridge.isAgentActive, true, "agent_end 仍不能启动总结");
  bridge.settleAgent();
  const queued = bridge.takeDeferred()!;
  assert.match(queued.text, /总结/);
  assert.match(queued.text, /今天有哪些新闻/);
  assert.match(queued.text, /正文开头.*原始请求/);
  assert.match(queued.text, /https:\/\/example.com\/news/);
  assert.match(queued.text, /不要.*工具|不要重复执行/);
  assert.equal(queued.text.startsWith("原始日志"), false);
  let prompt = "";
  assert.deepEqual(bridge.dispatchToAgent(queued.messageId, queued.text, undefined, () => { prompt = queued.text; }), { kind: "sent" });
  bridge.claimTurnOrigin(prompt);
  bridge.startTurn();
  assert.deepEqual(bridge.turnSendTarget, to, "synthetic id 不能被用作飞书 replyTo");
  assert.equal(bridge.origins.questionOf(queued.messageId), completed.question);
  assert.ok(sent.some((item) => item.text.includes("问题：今天有哪些新闻？")), "卡片抬头必须能对应原始问题");
  assert.doesNotMatch(bridge.origins.questionOf(queued.messageId) ?? "", /call_00|原始日志/);
  sent.length = 0;
  bridge.onTextDelta("新闻总结：甲与乙。");
  await bridge.endTurn();
  assert.ok(sent.some((item) => item.text.includes("新闻总结")));
  assert.ok(sent.every((item) => JSON.stringify(item.to) === JSON.stringify(to)));
  assert.ok(sent.every((item) => !item.text.includes("原始日志")));
  bridge.settleAgent();
  assert.equal(bridge.origins.targetOf(queued.messageId), undefined);
});

test("多个工具结果按队列顺序独立总结，保留各自目标；队列满不泄漏原文或来源", () => {
  const { bridge, sent } = setup();
  bridge.enqueueBackgroundResult("summary-a", completed);
  bridge.enqueueBackgroundResult("summary-b", { ...completed, id: "call_b", question: "帮我检查编译错误", to: { chatId: "另一个群" }, threadId: undefined });
  assert.equal(bridge.takeDeferred()?.messageId, "summary-a");
  assert.equal(bridge.takeDeferred()?.messageId, "summary-b");
  assert.deepEqual(bridge.origins.targetOf("summary-a"), to);
  assert.deepEqual(bridge.origins.targetOf("summary-b"), { chatId: "另一个群" });
  assert.equal(bridge.origins.questionOf("summary-a"), "今天有哪些新闻？");
  assert.equal(bridge.origins.questionOf("summary-b"), "帮我检查编译错误");
  for (let n = 0; n < 20; n++) bridge.defer(`pending-${n}`, "c", "别的任务");
  assert.equal(bridge.enqueueBackgroundResult("overflow", completed), false);
  assert.equal(bridge.origins.targetOf("overflow"), undefined);
  assert.deepEqual(sent, []);
});

test("后台失败和被截断的长结果交给模型时明确标记，保留头尾与原始请求", () => {
  const { bridge } = setup();
  bridge.enqueueBackgroundResult("failure", { ...completed, failed: true, body: `开头${"x".repeat(30000)}结尾` });
  const prompt = bridge.takeDeferred()!.text;
  assert.match(prompt, /失败/);
  assert.match(prompt, /截断|省略/);
  assert.match(prompt, /开头/);
  assert.match(prompt, /结尾/);
  assert.ok(prompt.length < 27000);
});

test("后台总结沿用捕获目标，单会话之后改绑也不能把结果发给新会话", () => {
  // 后台来源必须优先于新的默认绑定。
  const config = loadConfig({ files: [{ appId: "a", appSecret: "s", approverAllowlist: ["u"], multiChat: false }], env: {}, cwd: "/repo" });
  const gateway: GatewayLike = { boundChatId: "新会话", bind() {}, onMessage() {}, async streamTurn() {}, async sendText() {}, async downloadImage() { return undefined; }, askerFor: () => async () => ({ allow: false, reason: "拒绝" }) };
  const single = new Bridge(config, gateway, () => {});
  single.enqueueBackgroundResult("summary-single", completed);
  const queued = single.takeDeferred()!;
  single.dispatchToAgent(queued.messageId, queued.text, undefined, () => {});
  single.claimTurnOrigin(queued.text);
  single.startTurn();
  assert.deepEqual(single.turnSendTarget, to);
  assert.deepEqual(single.turnConversation, { chatId: "原群", threadId: "原话题" });
});
