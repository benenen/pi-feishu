import { test } from "node:test";
import assert from "node:assert/strict";
import {
  formatDuration,
  formatTokens,
  renderBlocked,
  renderToolEnd,
  renderToolStart,
  renderTurnEnd,
  renderUserPrompt,
} from "../extensions/feishu/renderer.ts";

test("formatDuration 分档", () => {
  assert.equal(formatDuration(820), "820ms");
  assert.equal(formatDuration(12_000), "12s");
  assert.equal(formatDuration(83_000), "1m23s");
});

test("formatTokens 分档", () => {
  assert.equal(formatTokens(980), "980");
  assert.equal(formatTokens(12_300), "12.3k");
});

test("终端发起的 prompt 会标注来源，飞书发起的不回显", () => {
  assert.equal(renderUserPrompt("跑一下测试", "interactive"), "> 💻 终端：跑一下测试\n\n");
  assert.equal(renderUserPrompt("跑一下测试", "feishu"), null);
});

test("超长 prompt 被截断且压平换行", () => {
  const out = renderUserPrompt(`${"很长".repeat(200)}\n第二行`, "interactive");
  assert.ok(out !== null);
  assert.ok(out.length < 260, "应被截断");
  assert.ok(out.endsWith("…\n\n"));
  assert.ok(!out.slice(0, -2).includes("\n"), "正文内不应残留换行");
});

test("bash 工具行显示命令，写类工具行显示路径", () => {
  assert.equal(renderToolStart("bash", { command: "npm test" }), "\n⚙️ **bash** `npm test`\n");
  assert.equal(renderToolStart("write", { path: "src/a.ts" }), "\n⚙️ **write** `src/a.ts`\n");
});

test("无可展示参数时只显示工具名", () => {
  assert.equal(renderToolStart("ask_question", {}), "\n⚙️ **ask_question**\n");
});

test("反引号被转义，避免撑破代码片段", () => {
  const out = renderToolStart("bash", { command: "echo `whoami`" });
  assert.equal(out.split("`").length - 1, 2, "只应有一对包裹用的反引号");
});

test("工具结束行区分成功与失败", () => {
  assert.equal(renderToolEnd(false, 12_000), "   ✓ 12s\n");
  assert.equal(renderToolEnd(true, 3_000), "   ✗ 失败（3s）\n");
});

test("回合收尾带耗时和 token", () => {
  assert.equal(renderTurnEnd(46_000, 12_300), "\n\n---\n⏱ 46s · 12.3k tok");
});

test("拦截提示包含工具名和原因", () => {
  const out = renderBlocked("bash", "审批超时");
  assert.ok(out.includes("bash"));
  assert.ok(out.includes("审批超时"));
  assert.ok(out.includes("🚫"));
});
