import { test } from "node:test";
import assert from "node:assert/strict";
import { MessageOriginRegistry, MAX_ORIGINS } from "../extensions/feishu/origin-registry.ts";

function reg() {
  let t = 0;
  const r = new MessageOriginRegistry(() => (t += 1));
  return r;
}

test("按 messageId 查得到来源", () => {
  const r = reg();
  r.record({ messageId: "om_1", chatId: "oc_群", senderId: "ou_1" }, "帮我看下");
  assert.equal(r.chatOf("om_1"), "oc_群");
  assert.equal(r.chatOf("om_没见过"), undefined);
});

test("按发给 pi 的原文认领触发这轮的消息", () => {
  // before_agent_start 带的 prompt 就是 sendUserMessage 传进去的原文，
  // 这是 pi 唯一提供的、能把「这个回合」和「哪条消息」对上的东西
  const r = reg();
  r.record({ messageId: "om_1", chatId: "oc_私聊", senderId: "ou_1" }, "第一件事");
  r.record({ messageId: "om_2", chatId: "oc_群", senderId: "ou_2" }, "第二件事");

  assert.equal(r.claimByPrompt("第二件事")?.chatId, "oc_群");
  assert.equal(r.claimByPrompt("第一件事")?.chatId, "oc_私聊");
});

test("认领不到就返回 undefined，绝不退回「最近那条」", () => {
  // 终端敲的字走的也是 before_agent_start，它认领不到任何消息 ——
  // 这时候必须是「没有来源」，退回最近那条就会把终端的回合发进飞书上一个对话
  const r = reg();
  r.record({ messageId: "om_1", chatId: "oc_群", senderId: "ou_1" }, "帮我看下");
  assert.equal(r.claimByPrompt("我在终端敲的"), undefined);
});

test("同一条原文只能被认领一次", () => {
  // 认领是一次性的，否则下一个回合会把上一个回合的消息再认一遍
  const r = reg();
  r.record({ messageId: "om_1", chatId: "oc_群", senderId: "ou_1" }, "跑测试");
  assert.equal(r.claimByPrompt("跑测试")?.messageId, "om_1");
  assert.equal(r.claimByPrompt("跑测试"), undefined);
});

test("两个对话发一模一样的话，按先来后到各认各的", () => {
  const r = reg();
  r.record({ messageId: "om_1", chatId: "oc_A", senderId: "ou_1" }, "你好");
  r.record({ messageId: "om_2", chatId: "oc_B", senderId: "ou_2" }, "你好");
  assert.equal(r.claimByPrompt("你好")?.chatId, "oc_A");
  assert.equal(r.claimByPrompt("你好")?.chatId, "oc_B");
  assert.equal(r.claimByPrompt("你好"), undefined);
});

test("认领之后仍然查得到 —— 出站要一直按 messageId 找回对话", () => {
  // claim 只是「这轮归它了」，不是把记录删掉；整个回合的出站都要靠它
  const r = reg();
  r.record({ messageId: "om_1", chatId: "oc_群", senderId: "ou_1" }, "跑测试");
  const claimed = r.claimByPrompt("跑测试");
  assert.equal(r.chatOf(claimed!.messageId), "oc_群");
});

test("工具调用绑到触发它的消息，能追回原始对话", () => {
  const r = reg();
  r.record({ messageId: "om_1", chatId: "oc_群", senderId: "ou_1" }, "跑测试");
  r.bindToolCall("tc_1", "om_1");
  assert.equal(r.chatOfToolCall("tc_1"), "oc_群");
  assert.equal(r.chatOfToolCall("tc_没绑过"), undefined);
});

test("绑到不存在的消息不会造出一个假对话", () => {
  const r = reg();
  r.bindToolCall("tc_1", "om_不存在");
  assert.equal(r.chatOfToolCall("tc_1"), undefined);
});

test("记录有上限，旧的先出 —— 长会话不能无限攒", () => {
  const r = reg();
  for (let i = 0; i < MAX_ORIGINS + 5; i += 1) {
    r.record({ messageId: `om_${i}`, chatId: "oc_群", senderId: "ou_1" }, `第 ${i} 条`);
  }
  assert.equal(r.size, MAX_ORIGINS);
  assert.equal(r.chatOf("om_0"), undefined, "最早的应该被挤掉");
  assert.equal(r.chatOf(`om_${MAX_ORIGINS + 4}`), "oc_群", "最新的必须还在");
});

test("被挤掉的记录不留下认领索引 —— 否则认领到一条查不到的消息", () => {
  const r = reg();
  for (let i = 0; i < MAX_ORIGINS + 1; i += 1) {
    r.record({ messageId: `om_${i}`, chatId: "oc_群", senderId: "ou_1" }, `第 ${i} 条`);
  }
  assert.equal(r.claimByPrompt("第 0 条"), undefined);
});

test("forget 只清一条，不动别的", () => {
  const r = reg();
  r.record({ messageId: "om_1", chatId: "oc_A", senderId: "ou_1" }, "一");
  r.record({ messageId: "om_2", chatId: "oc_B", senderId: "ou_2" }, "二");
  r.bindToolCall("tc_1", "om_1");

  r.forget("om_1");
  assert.equal(r.chatOf("om_1"), undefined);
  assert.equal(r.chatOfToolCall("tc_1"), undefined, "绑在它上面的工具调用也要一起清");
  assert.equal(r.chatOf("om_2"), "oc_B", "别的记录不能受牵连");
});

test("记下发送者和时间 —— 排查时要知道是谁什么时候说的", () => {
  const r = reg();
  r.record({ messageId: "om_1", chatId: "oc_群", senderId: "ou_张三" }, "跑测试");
  const origin = r.claimByPrompt("跑测试");
  assert.equal(origin?.senderId, "ou_张三");
  assert.equal(typeof origin?.ts, "number");
});

// ── 话题（thread）──────────────────────────────────────────────────

test("话题里的消息：出站目标带 replyTo 和 inThread", () => {
  const r = new MessageOriginRegistry();
  r.record({ messageId: "om_1", chatId: "oc_1", senderId: "ou_1", threadId: "omt_9" });
  assert.deepEqual(r.targetOf("om_1"), { chatId: "oc_1", replyTo: "om_1", inThread: true });
});

test("普通消息：出站目标只有 chatId，行为与加话题之前一致", () => {
  const r = new MessageOriginRegistry();
  r.record({ messageId: "om_1", chatId: "oc_1", senderId: "ou_1" });
  assert.deepEqual(r.targetOf("om_1"), { chatId: "oc_1" });
});

test("查不到的消息没有出站目标", () => {
  const r = new MessageOriginRegistry();
  assert.equal(r.targetOf("om_nope"), undefined);
  assert.equal(r.targetOf(undefined), undefined);
});

test("工具调用也能回查到话题目标 —— 审批卡片要弹在话题里", () => {
  const r = new MessageOriginRegistry();
  r.record({ messageId: "om_1", chatId: "oc_1", senderId: "ou_1", threadId: "omt_9" });
  r.bindToolCall("call_1", "om_1");
  assert.deepEqual(r.targetOfToolCall("call_1"), { chatId: "oc_1", replyTo: "om_1", inThread: true });
});
