import { test } from "node:test";
import assert from "node:assert/strict";
import { DeferredQueue, shouldDefer, MAX_DEFERRED } from "../extensions/feishu/deferred.ts";

test("空闲时一律不扣 —— 没有回合在跑，直接发就是了", () => {
  assert.equal(shouldDefer({
    streaming: false,
    turnTarget: { chatId: "oc_dm" },
    incomingTarget: { chatId: "oc_group" },
  }), false);
});

test("回合进行中、来自同一个对话 → 也扣住，下一条回复要另开卡片", () => {
  // followUp 会并进当前 agent run，只更新先前那张卡片；后来这条消息下面不会出现
  // 新回复，看起来就像机器人没回。扣住后单独成回合，才能得到一问一卡。
  assert.equal(shouldDefer({
    streaming: true,
    turnTarget: { chatId: "oc_dm" },
    incomingTarget: { chatId: "oc_dm" },
  }), true);
});

test("回合进行中、来自另一个对话 → 扣住", () => {
  // 这是「私聊在跑，群里 @ 一句」：不扣的话答案整段进私聊，群里一个字都收不到
  assert.equal(shouldDefer({
    streaming: true,
    turnTarget: { chatId: "oc_dm" },
    incomingTarget: { chatId: "oc_group" },
  }), true);
});

test("显式 ! 打断仍然立即 steer，不为一问一卡改成排队", () => {
  assert.equal(
    shouldDefer({
      streaming: true,
      turnTarget: { chatId: "oc_dm" },
      incomingTarget: { chatId: "oc_dm" },
      deliverAs: "steer",
    }),
    false,
  );
});

test("另一个对话的 ! 不能劫持当前回合，仍然扣住", () => {
  assert.equal(
    shouldDefer({
      streaming: true,
      turnTarget: { chatId: "oc_dm" },
      incomingTarget: { chatId: "oc_group" },
      deliverAs: "steer",
    }),
    true,
  );
});

test("同一群不同话题的 ! 不能劫持当前回合", () => {
  assert.equal(
    shouldDefer({
      streaming: true,
      turnTarget: { chatId: "oc_group", threadId: "omt_A" },
      incomingTarget: { chatId: "oc_group", threadId: "omt_B" },
      deliverAs: "steer",
    }),
    true,
  );
});

test("同一群同一话题的 ! 仍可立即 steer", () => {
  assert.equal(
    shouldDefer({
      streaming: true,
      turnTarget: { chatId: "oc_group", threadId: "omt_A" },
      incomingTarget: { chatId: "oc_group", threadId: "omt_A" },
      deliverAs: "steer",
    }),
    false,
  );
});

test("回合没有明确目标时不扣 —— 没有要保护的对话", () => {
  assert.equal(shouldDefer({
    streaming: true,
    turnTarget: undefined,
    incomingTarget: { chatId: "oc_group" },
  }), false);
});

test("队列按先来后到出队", () => {
  const q = new DeferredQueue();
  q.push({ messageId: "om_x", chatId: "oc_a", text: "第一条" });
  q.push({ messageId: "om_x", chatId: "oc_b", text: "第二条" });
  assert.deepEqual(q.shift(), { messageId: "om_x", chatId: "oc_a", text: "第一条" });
  assert.deepEqual(q.shift(), { messageId: "om_x", chatId: "oc_b", text: "第二条" });
  assert.equal(q.shift(), undefined);
});

test("队列满时拒收新的，而不是挤掉旧的", () => {
  // 旧的那些已经答应过人家「稍后回复」，挤掉就是失约；拒收新的还能当场告诉他
  const q = new DeferredQueue();
  for (let i = 0; i < MAX_DEFERRED; i += 1) {
    assert.equal(q.push({ messageId: "om_x", chatId: "oc_a", text: `第 ${i} 条` }), true);
  }
  assert.equal(q.push({ messageId: "om_x", chatId: "oc_a", text: "溢出的" }), false);
  assert.deepEqual(q.shift(), { messageId: "om_x", chatId: "oc_a", text: "第 0 条" }, "最早那条被挤掉了");
});

test("takeAll 取出全部并清空 —— 停止桥接时要挨个告知", () => {
  const q = new DeferredQueue();
  q.push({ messageId: "om_x", chatId: "oc_a", text: "一" });
  q.push({ messageId: "om_x", chatId: "oc_b", text: "二" });
  assert.equal(q.takeAll().length, 2);
  assert.equal(q.size, 0);
  assert.equal(q.shift(), undefined);
});
