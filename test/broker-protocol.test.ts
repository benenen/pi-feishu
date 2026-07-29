import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeFrame, FrameReader } from "../extensions/feishu/broker/protocol.ts";

test("编码后以换行结尾，且不含内嵌换行", () => {
  const line = encodeFrame({ t: "hello", cwd: "/w", label: "a\nb" });
  assert.equal(line.endsWith("\n"), true);
  assert.equal(line.slice(0, -1).includes("\n"), false, "内容里的换行必须被 JSON 转义");
});

test("一次 push 里的多帧全部解出", () => {
  const r = new FrameReader();
  const buf = Buffer.from(
    encodeFrame({ t: "unbind" }) + encodeFrame({ t: "stream_end", id: "1" }),
  );
  const frames = r.push(buf);
  assert.equal(frames.length, 2);
  assert.equal(frames[0]?.t, "unbind");
  assert.equal(frames[1]?.t, "stream_end");
});

test("半包：帧被拆成两次 push 也能拼回来", () => {
  const r = new FrameReader();
  const line = encodeFrame({ t: "send_text", id: "7", markdown: "你好" });
  const cut = Math.floor(line.length / 2);
  assert.deepEqual(r.push(Buffer.from(line.slice(0, cut))), [], "半包不应产出帧");
  const frames = r.push(Buffer.from(line.slice(cut)));
  assert.equal(frames.length, 1);
  assert.equal(frames[0]?.t, "send_text");
});

test("坏行被跳过，不影响后续帧", () => {
  const r = new FrameReader();
  const frames = r.push(Buffer.from("{不是合法 JSON}\n" + encodeFrame({ t: "unbind" })));
  assert.equal(frames.length, 1, "坏行丢弃，好行照常解出");
  assert.equal(frames[0]?.t, "unbind");
});

test("超长行被丢弃，防止对端把内存撑爆", () => {
  const r = new FrameReader();
  assert.deepEqual(r.push(Buffer.from("x".repeat(2_000_000))), []);
  // 丢弃后仍能从下一个换行处恢复
  const frames = r.push(Buffer.from("\n" + encodeFrame({ t: "unbind" })));
  assert.equal(frames.length, 1);
});

test("UTF-8 多字节字符被拆包也不会乱码", () => {
  const r = new FrameReader();
  const line = encodeFrame({ t: "send_text", id: "1", markdown: "中文字符" });
  const buf = Buffer.from(line);
  // 在一个多字节字符中间切开
  assert.deepEqual(r.push(buf.subarray(0, 20)), []);
  const frames = r.push(buf.subarray(20));
  assert.equal(frames.length, 1);
  assert.equal((frames[0] as { markdown: string }).markdown, "中文字符");
});
