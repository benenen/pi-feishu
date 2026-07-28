import { test } from "node:test";
import type { Config } from "../extensions/feishu/config.ts";
import assert from "node:assert/strict";
import {
  formatDuration,
  formatTokens,
  renderBlocked,
  renderNotice,
  renderToolEnd,
  renderToolStart,
  renderTurnEnd,
  renderUserPrompt,
  chatLabel,
  renderStatus,
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

test("emoji 截断不会劈开代理对", () => {
  const out = renderUserPrompt("😀".repeat(300), "interactive");
  assert.ok(out !== null);
  const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
  assert.equal(lone.test(out), false, "不应出现孤立代理项");
  assert.ok(out.endsWith("…\n\n"));
});

test("toolName 里的 markdown 记号被中和，不会撑破粗体", () => {
  const out = renderToolStart("ba**sh", {});
  assert.equal(out.split("**").length - 1, 2, "只应有一对包裹用的 **");
});

test("拦截理由里的换行与记号被中和", () => {
  const out = renderBlocked("bash", "第一行\n第二行 **粗** `码`");
  assert.equal(out.split("\n").length - 1, 2, "只应有首尾两个换行");
  assert.equal(out.split("**").length - 1, 2);
  assert.ok(!out.includes("`"));
});

test("renderNotice 同样中和", () => {
  const out = renderNotice("提示\n第二行 **粗**");
  assert.equal(out.split("\n").length - 1, 2);
  assert.ok(!out.includes("**"));
});

// ── /feishu status 的详细渲染 ───────────────────────────────────────

const CFG: Config = {
  appId: "cli_abc",
  appSecret: "SUPER_SECRET_VALUE",
  autoStart: true,
  dmMode: "open",
  dmAllowlist: [],
  groupAllowlist: ["oc_g1"],
  approverAllowlist: ["ou_a", "ou_b"],
  operatorOpenId: "ou_a",
  bindTarget: "operator",
  requireMention: true,
  approvalMode: "balanced",
  approvalTimeoutMs: 120_000,
  repoRoot: "/work/repo",
};

test("status：未运行时只说未运行，并给出启动方式", () => {
  const out = renderStatus({ running: false });
  assert.match(out, /未运行/);
  assert.match(out, /\/feishu start/);
});

test("status：运行中列出连接、绑定、策略、审批各项", () => {
  const out = renderStatus({
    running: true,
    config: CFG,
    boundChatId: "oc_bound",
    streaming: false,
    turnApproved: false,
  });
  assert.match(out, /运行中/);
  assert.match(out, /cli_abc/, "应用 id");
  assert.match(out, /oc_bound/, "绑定的会话");
  assert.match(out, /私信操作员/, "绑定方式说人话，不是回显 bindTarget 原值");
  assert.match(out, /所有人可私聊/, "私聊策略");
  assert.match(out, /balanced/, "审批档位");
  assert.match(out, /2m/, "审批超时按时长渲染");
  assert.match(out, /\/work\/repo/, "仓库根");
});

test("status：绝不泄露 appSecret", () => {
  const out = renderStatus({ running: true, config: CFG, boundChatId: "oc_x" });
  assert.equal(out.includes("SUPER_SECRET_VALUE"), false);
});

test("status：尚未绑定时说明下一条消息会绑定", () => {
  const out = renderStatus({ running: true, config: CFG });
  assert.match(out, /尚未绑定/);
});

test("status：流式中与本回合豁免都要体现出来", () => {
  const busy = renderStatus({
    running: true,
    config: CFG,
    boundChatId: "oc_x",
    streaming: true,
    turnApproved: true,
  });
  assert.match(busy, /回合进行中/);
  assert.match(busy, /本回合全部允许/);

  const idle = renderStatus({ running: true, config: CFG, boundChatId: "oc_x" });
  assert.match(idle, /空闲/);
  assert.equal(idle.includes("本回合全部允许"), false, "没开豁免就不该提");
});

test("status：群白名单为空要说明是「不限」，而不是显示空数组", () => {
  const out = renderStatus({
    running: true,
    config: { ...CFG, groupAllowlist: [] },
    boundChatId: "oc_x",
  });
  assert.match(out, /不限/);
});

test("chatLabel：有名字就用名字", () => {
  assert.equal(chatLabel({ name: "研发群", chatType: "group" }), "研发群");
});

test("chatLabel：私聊没有名字（飞书返回 null），退回「私聊」", () => {
  assert.equal(chatLabel({ chatType: "p2p" }), "私聊");
  assert.equal(chatLabel({ name: "", chatType: "p2p" }), "私聊");
});

test("chatLabel：没名字的群退回「群聊」", () => {
  assert.equal(chatLabel({ chatType: "group" }), "群聊");
});

test("status：知道会话名称时，名称和 id 都要显示", () => {
  const out = renderStatus({
    running: true,
    config: CFG,
    boundChatId: "oc_bound",
    boundChatName: "研发群",
  });
  assert.match(out, /研发群/);
  assert.match(out, /oc_bound/, "id 仍要留着，排查时要用");
});

test("status：查不到名称时只显示 id，不显示空括号", () => {
  const out = renderStatus({ running: true, config: CFG, boundChatId: "oc_bound" });
  assert.match(out, /oc_bound/);
  assert.equal(/·\s+·/.test(out), false, "不该留下空占位");
});
