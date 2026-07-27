import { test } from "node:test";
import assert from "node:assert/strict";
import { requestApproval } from "../extensions/feishu/approval.ts";
import type { Asker, Decision, Timer } from "../extensions/feishu/approval.ts";

const REQ = { toolName: "bash", input: { command: "rm -rf /tmp/x" } };

/** 永不触发的定时器，用于隔离超时路径 */
const noTimeout: Timer = { setTimeout: () => 0, clearTimeout: () => {} };

/** 立即触发的定时器，用于确定性地测超时 */
const fireNow: Timer = {
  setTimeout: (fn) => {
    queueMicrotask(fn);
    return 0;
  },
  clearTimeout: () => {},
};

const never: Asker = (_req, signal) =>
  new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  });

test("最先返回的通道决定结果", async () => {
  const fast: Asker = async () => ({ allow: true, reason: "飞书批准" });
  const d = await requestApproval(REQ, [fast, never], 10_000, noTimeout);
  assert.deepEqual(d, { allow: true, reason: "飞书批准" });
});

test("落败的通道会收到 abort 信号", async () => {
  let aborted = false;
  const watcher: Asker = (_req, signal) =>
    new Promise(() => {
      signal.addEventListener("abort", () => {
        aborted = true;
      });
    });
  const fast: Asker = async () => ({ allow: false, reason: "终端拒绝" });
  await requestApproval(REQ, [fast, watcher], 10_000, noTimeout);
  await new Promise((r) => setImmediate(r));
  assert.equal(aborted, true);
});

test("超时一律判为拒绝", async () => {
  const d = await requestApproval(REQ, [never], 1, fireNow);
  assert.equal(d.allow, false);
  assert.ok(d.reason.includes("超时"));
});

test("全部通道抛错时立即拒绝，不必等超时", async () => {
  const broken: Asker = async () => {
    throw new Error("飞书发送失败");
  };
  const d = await requestApproval(REQ, [broken, broken], 10_000, noTimeout);
  assert.equal(d.allow, false);
  assert.ok(d.reason.includes("审批通道不可用"));
});

test("部分通道抛错时另一个仍可决定", async () => {
  const broken: Asker = async () => {
    throw new Error("飞书发送失败");
  };
  const ok: Asker = async () => ({ allow: true, reason: "终端批准" });
  const d = await requestApproval(REQ, [broken, ok], 10_000, noTimeout);
  assert.deepEqual(d, { allow: true, reason: "终端批准" });
});

test("没有任何审批通道时拒绝", async () => {
  const d = await requestApproval(REQ, [], 10_000, noTimeout);
  assert.equal(d.allow, false);
  assert.ok(d.reason.includes("审批通道不可用"));
});

test("落败通道的 reject 不会造成未处理拒绝", async () => {
  const rejects: Asker = (_req, signal) =>
    new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
  const fast: Asker = async () => ({ allow: true, reason: "ok" });
  const d: Decision = await requestApproval(REQ, [fast, rejects], 10_000, noTimeout);
  assert.equal(d.allow, true);
  // 给落败通道的 reject 一个冒出来的机会；若未被吞掉，进程级 unhandledRejection 会让测试失败
  await new Promise((r) => setTimeout(r, 10));
});

test("超时定时器在竞速结束后一定被清掉", async () => {
  const cleared: unknown[] = [];
  const spy: Timer = {
    setTimeout: () => "timer-id",
    clearTimeout: (id) => {
      cleared.push(id);
    },
  };
  const fast: Asker = async () => ({ allow: true, reason: "飞书批准" });
  await requestApproval(REQ, [fast], 10_000, spy);
  assert.deepEqual(cleared, ["timer-id"], "必须用 setTimeout 返回的 id 清理");
});

test("超时时长被正确带进定时器与理由文案", async () => {
  let seenMs: number | undefined;
  const spy: Timer = {
    setTimeout: (fn, ms) => {
      seenMs = ms;
      queueMicrotask(fn);
      return 0;
    },
    clearTimeout: () => {},
  };
  const d = await requestApproval(REQ, [never], 4321, spy);
  assert.equal(seenMs, 4321);
  assert.ok(d.reason.includes("4321"), `理由应含时长，实际：${d.reason}`);
});

test("落败通道事后返回 allow 也翻不了案", async () => {
  // 无视 abort、在竞速结束后才返回批准的通道
  const lateYes: Asker = () =>
    new Promise((resolve) => setTimeout(() => resolve({ allow: true, reason: "迟到的批准" }), 30));
  const d = await requestApproval(REQ, [lateYes], 1, fireNow);
  assert.equal(d.allow, false, "已经判拒之后不能被翻盘");
  await new Promise((r) => setTimeout(r, 60));
});
