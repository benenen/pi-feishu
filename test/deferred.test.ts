import { test } from "node:test";
import assert from "node:assert/strict";
import { DeferredQueue, shouldDefer, MAX_DEFERRED } from "../extensions/feishu/deferred.ts";

test("空闲时一律不扣 —— 没有回合在跑，直接发就是了", () => {
  assert.equal(shouldDefer({ streaming: false, turnTarget: "oc_dm", chatId: "oc_group" }), false);
});

test("回合进行中、来自同一个对话 → 不扣", () => {
  // 它会作为 followUp 并进当前回合，而当前回合的流就发往这个对话，本来就是对的
  assert.equal(shouldDefer({ streaming: true, turnTarget: "oc_dm", chatId: "oc_dm" }), false);
});

test("回合进行中、来自另一个对话 → 扣住", () => {
  // 这是「私聊在跑，群里 @ 一句」：不扣的话答案整段进私聊，群里一个字都收不到
  assert.equal(shouldDefer({ streaming: true, turnTarget: "oc_dm", chatId: "oc_group" }), true);
});

test("回合没有明确目标时不扣 —— 没有要保护的对话", () => {
  assert.equal(shouldDefer({ streaming: true, turnTarget: undefined, chatId: "oc_group" }), false);
});

test("队列按先来后到出队", () => {
  const q = new DeferredQueue();
  q.push({ chatId: "oc_a", text: "第一条" });
  q.push({ chatId: "oc_b", text: "第二条" });
  assert.deepEqual(q.shift(), { chatId: "oc_a", text: "第一条" });
  assert.deepEqual(q.shift(), { chatId: "oc_b", text: "第二条" });
  assert.equal(q.shift(), undefined);
});

test("队列满时拒收新的，而不是挤掉旧的", () => {
  // 旧的那些已经答应过人家「稍后回复」，挤掉就是失约；拒收新的还能当场告诉他
  const q = new DeferredQueue();
  for (let i = 0; i < MAX_DEFERRED; i += 1) {
    assert.equal(q.push({ chatId: "oc_a", text: `第 ${i} 条` }), true);
  }
  assert.equal(q.push({ chatId: "oc_a", text: "溢出的" }), false);
  assert.deepEqual(q.shift(), { chatId: "oc_a", text: "第 0 条" }, "最早那条被挤掉了");
});

test("takeAll 取出全部并清空 —— 停止桥接时要挨个告知", () => {
  const q = new DeferredQueue();
  q.push({ chatId: "oc_a", text: "一" });
  q.push({ chatId: "oc_b", text: "二" });
  assert.equal(q.takeAll().length, 2);
  assert.equal(q.size, 0);
  assert.equal(q.shift(), undefined);
});
