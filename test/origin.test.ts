import { test } from "node:test";
import assert from "node:assert/strict";
import { ORIGIN_ENTRY_TYPE, resolveOrigin } from "../extensions/feishu/origin.ts";

/** 会话条目的最小形状，够判定用即可 */
const origin = (chatId: string) => ({ type: "custom", customType: ORIGIN_ENTRY_TYPE, data: { chatId } });
const other = (t: string) => ({ type: "custom", customType: t, data: {} });
const user = (text: string) => ({ type: "message", message: { role: "user", content: text } });
const assistant = (text: string) => ({ type: "message", message: { role: "assistant", content: text } });

test("用户消息前紧挨着来源条目 → 取它", () => {
  const entries = [user("旧的"), assistant("旧回复"), origin("oc_group"), user("你好")];
  assert.equal(resolveOrigin(entries as never), "oc_group");
});

test("终端敲的消息前面没有来源条目 → undefined（走默认收件方）", () => {
  const entries = [origin("oc_group"), user("来自飞书"), assistant("回"), user("终端敲的")];
  assert.equal(resolveOrigin(entries as never), undefined, "不能沿用上一条飞书消息的来源");
});

test("取的是最后一条用户消息的来源，不是最早的", () => {
  const entries = [origin("oc_a"), user("第一条"), assistant("回"), origin("oc_b"), user("第二条")];
  assert.equal(resolveOrigin(entries as never), "oc_b");
});

test("来源条目与用户消息之间夹着别的条目也认得出", () => {
  const entries = [origin("oc_group"), other("some-other-entry"), user("你好")];
  assert.equal(resolveOrigin(entries as never), "oc_group");
});

test("两个对话发了一模一样的文本也不会配错 —— 按位置而不是按文本", () => {
  const entries = [origin("oc_a"), user("你好"), assistant("回"), origin("oc_b"), user("你好")];
  assert.equal(resolveOrigin(entries as never), "oc_b");
});

test("没有任何用户消息时返回 undefined", () => {
  assert.equal(resolveOrigin([] as never), undefined);
  assert.equal(resolveOrigin([assistant("只有回复")] as never), undefined);
});

test("来源条目数据缺失或形状不对时安全退回 undefined", () => {
  const bad = [{ type: "custom", customType: ORIGIN_ENTRY_TYPE, data: {} }, user("你好")];
  assert.equal(resolveOrigin(bad as never), undefined);
  const noData = [{ type: "custom", customType: ORIGIN_ENTRY_TYPE }, user("你好")];
  assert.equal(resolveOrigin(noData as never), undefined);
});
