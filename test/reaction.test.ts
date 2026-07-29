import { test } from "node:test";
import assert from "node:assert/strict";
import { isInvalidEmojiError } from "../extensions/feishu/reaction.ts";

/** 用户实际撞到的那个错误的形状 */
const REAL = {
  code: 231001,
  msg: "reaction type is invalid.",
  error: { log_id: "20260729152014B5199FC880451477E136" },
};

test("认得出「表情类型非法」这个错误 —— 结构化字段", () => {
  assert.equal(isInvalidEmojiError(REAL), true);
});

test("认得出它 —— 只有字符串形态时也要认（SDK 抛的是包了一层的对象）", () => {
  assert.equal(isInvalidEmojiError(new Error(JSON.stringify([REAL]))), true);
  assert.equal(isInvalidEmojiError("reaction type is invalid."), true);
});

test("别的错误不能被误判成「key 不对」—— 那会把重试永久关掉", () => {
  assert.equal(isInvalidEmojiError(new Error("network timeout")), false);
  assert.equal(isInvalidEmojiError({ code: 230099, msg: "element exceeds the limit" }), false);
  assert.equal(isInvalidEmojiError(undefined), false);
  assert.equal(isInvalidEmojiError({}), false);
});
