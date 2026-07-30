import { test } from "node:test";
import assert from "node:assert/strict";
import { TurnStream, cumulativeSink } from "../extensions/feishu/turn-stream.ts";

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

test("第二个并发 pump 被拒绝，而不是让前一个永久挂起", async () => {
  const { sink } = recorder();
  const s = new TurnStream();
  const first = s.pump(sink);

  await assert.rejects(() => s.pump(sink), /只能有一个 pump/);

  // 第一个 pump 仍然正常工作
  s.push("x");
  s.finish();
  await first;
});

test("pump 返回后可以再次 pump", async () => {
  const { chunks, sink } = recorder();
  const s = new TurnStream();
  s.push("a");
  s.finish();
  await s.pump(sink);
  await s.pump(sink);
  assert.equal(chunks.join(""), "a");
});

/**
 * 飞书 SDK 流式 controller 的替身：照抄它 `append()` 里的合并启发式
 * （`node_modules/@larksuiteoapi/node-sdk/lib/index.js` 的 `mergeStreamingText`，
 * v1.71.1 在 96096 行）。
 *
 * 它不知道生产者给的是增量还是累计，只能猜；对真正的增量是**有损**的 ——
 * 下面几条用例就是拿它复现「会话名 lnny 在飞书上显示成粗体 lny」那次线上问题。
 */
function larkMerge(prev: string, next: string): string {
  if (!prev) return next;
  if (!next) return prev;
  if (next.startsWith(prev)) return next;
  if (prev.startsWith(next)) return prev;
  for (let len = Math.min(prev.length, next.length); len > 0; len--) {
    if (prev.endsWith(next.substring(0, len))) return prev + next.substring(len);
  }
  return prev + next;
}

function larkController() {
  const state = { text: "" };
  return {
    state,
    sink: {
      async append(chunk: string) {
        state.text = larkMerge(state.text, chunk);
      },
    },
  };
}

test("复现：增量直接喂给飞书 SDK，与已有内容重叠的字符会被吞掉", async () => {
  const { state, sink } = larkController();
  // pi 的 token 边界正好落在两个 n 中间
  await sink.append("**ln");
  await sink.append("ny**");
  assert.equal(state.text, "**lny**", "替身要能复现出线上那个症状，否则下面的回归用例是空跑");
});

test("cumulativeSink：切在重复字符中间也不丢字", async () => {
  const { state, sink } = larkController();
  const wrapped = cumulativeSink(sink);
  await wrapped.append("**ln");
  await wrapped.append("ny**");
  assert.equal(state.text, "**lnny**");
});

test("cumulativeSink：新块是已有内容的前缀时也不会被整块丢掉", async () => {
  const { state, sink } = larkController();
  const wrapped = cumulativeSink(sink);
  // 裸增量下 prev.startsWith(next) 命中，第二块整个消失
  await wrapped.append("好的\n\n");
  await wrapped.append("好的");
  assert.equal(state.text, "好的\n\n好的");
});

test("cumulativeSink 每次给的是累计全文", async () => {
  const { chunks, sink } = recorder();
  const wrapped = cumulativeSink(sink);
  await wrapped.append("a");
  await wrapped.append("b");
  await wrapped.append("c");
  assert.deepEqual(chunks, ["a", "ab", "abc"]);
});

test("cumulativeSink 不为空块调用下游", async () => {
  const { chunks, sink } = recorder();
  const wrapped = cumulativeSink(sink);
  await wrapped.append("");
  assert.deepEqual(chunks, []);
});

test("cumulativeSink 下游抛错后，下一次追加仍带着此前的全文（不丢内容）", async () => {
  const { state, sink } = larkController();
  let fail = true;
  const flaky = {
    async append(chunk: string) {
      if (fail) {
        fail = false;
        throw new Error("飞书发送失败");
      }
      await sink.append(chunk);
    },
  };
  const wrapped = cumulativeSink(flaky);
  await assert.rejects(() => wrapped.append("第一段"), /飞书发送失败/);
  await wrapped.append("第二段");
  assert.equal(state.text, "第一段第二段");
});

test("TurnStream + cumulativeSink：分批到达的增量在飞书侧拼回原样", async () => {
  const { state, sink } = larkController();
  const s = new TurnStream();
  const pumping = s.pump(cumulativeSink(sink));
  // 分两批推，中间让出事件循环，pump 才会分成两次 append —— 合成一次就复现不出来了
  s.push("⚙️ **ln");
  await new Promise((r) => setImmediate(r));
  s.push("ny** 跑完了");
  s.finish();
  await pumping;
  assert.equal(state.text, "⚙️ **lnny** 跑完了");
});

test("sink.append 抛错时异常抛给调用方，且不会卡住后续 pump", async () => {
  const s = new TurnStream();
  const boom = {
    async append() {
      throw new Error("飞书发送失败");
    },
  };
  s.push("a");
  s.finish();
  await assert.rejects(() => s.pump(boom), /飞书发送失败/);

  const { chunks, sink } = recorder();
  await s.pump(sink);
  assert.deepEqual(chunks, [], "抛错那批已出队，不会重投");
});
