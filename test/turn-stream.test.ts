import { test } from "node:test";
import assert from "node:assert/strict";
import { TurnStream } from "../extensions/feishu/turn-stream.ts";

function recorder() {
  const chunks: string[] = [];
  return {
    chunks,
    sink: {
      async append(c: string) {
        chunks.push(c);
      },
    },
  };
}

test("finish 之前 push 的内容会被 pump 冲出去", async () => {
  const { chunks, sink } = recorder();
  const s = new TurnStream();
  s.push("a");
  s.push("b");
  s.finish();
  await s.pump(sink);
  assert.equal(chunks.join(""), "ab");
});

test("pump 期间持续 push 也能收到", async () => {
  const { chunks, sink } = recorder();
  const s = new TurnStream();
  const pumping = s.pump(sink);
  s.push("x");
  await new Promise((r) => setImmediate(r));
  s.push("y");
  s.finish();
  await pumping;
  assert.equal(chunks.join(""), "xy");
});

test("空回合：没有任何 push 就 finish，不产生 append", async () => {
  const { chunks, sink } = recorder();
  const s = new TurnStream();
  s.finish();
  await s.pump(sink);
  assert.deepEqual(chunks, []);
});

test("finish 之后再 push 会被忽略", async () => {
  const { chunks, sink } = recorder();
  const s = new TurnStream();
  s.push("a");
  s.finish();
  s.push("late");
  await s.pump(sink);
  assert.equal(chunks.join(""), "a");
});

test("空字符串不产生 append", async () => {
  const { chunks, sink } = recorder();
  const s = new TurnStream();
  s.push("");
  s.finish();
  await s.pump(sink);
  assert.deepEqual(chunks, []);
});

test("突发的多个 push 被合并成一次 append", async () => {
  const { chunks, sink } = recorder();
  const s = new TurnStream();
  s.push("a");
  s.push("b");
  s.push("c");
  s.finish();
  await s.pump(sink);
  assert.deepEqual(chunks, ["abc"], "三次 push 应合并为一次 append");
});

test("finished 反映状态", () => {
  const s = new TurnStream();
  assert.equal(s.finished, false);
  s.finish();
  assert.equal(s.finished, true);
});

test("pump 在 finish 前不会返回", async () => {
  const { sink } = recorder();
  const s = new TurnStream();
  let done = false;
  const pumping = s.pump(sink).then(() => {
    done = true;
  });
  await new Promise((r) => setImmediate(r));
  assert.equal(done, false);
  s.finish();
  await pumping;
  assert.equal(done, true);
});
