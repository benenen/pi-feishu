import { test } from "node:test";
import assert from "node:assert/strict";
import {
  HERDR_CARD_KIND,
  buildAgentPickerCard,
  parseHerdrCardAction,
  parseHerdrCommand,
  renderAgentList,
  renderDispatchAck,
  renderHerdrHelp,
  renderResult,
  renderWatchList,
} from "../extensions/feishu/herdr-commands.ts";
import type { HerdrAgent } from "../extensions/herdr/types.ts";

test("只认 /herdr 前缀，且必须是词边界", () => {
  assert.equal(parseHerdrCommand("普通消息"), undefined);
  assert.equal(parseHerdrCommand("/feishu status"), undefined);
  assert.equal(parseHerdrCommand("/herdrX"), undefined);
  assert.deepEqual(parseHerdrCommand("/herdr"), { kind: "list" });
  assert.deepEqual(parseHerdrCommand("  /herdr list "), { kind: "list" });
});

test("子命令解析：use / task / new / send / read / stop / cancel / watch", () => {
  assert.deepEqual(parseHerdrCommand("/herdr use lnny"), { kind: "use", target: "lnny" });
  assert.deepEqual(parseHerdrCommand("/herdr task lnny 修一下登录"), {
    kind: "task",
    target: "lnny",
    task: "修一下登录",
  });
  assert.deepEqual(parseHerdrCommand("/herdr new claude 写测试"), {
    kind: "new",
    agentKind: "claude",
    task: "写测试",
  });
  assert.deepEqual(parseHerdrCommand("/herdr send lnny 继续"), {
    kind: "send",
    target: "lnny",
    text: "继续",
  });
  assert.deepEqual(parseHerdrCommand("/herdr keys lnny ctrl+c"), {
    kind: "keys",
    target: "lnny",
    keys: ["ctrl+c"],
  });
  assert.deepEqual(parseHerdrCommand("/herdr keys lnny up enter"), {
    kind: "keys",
    target: "lnny",
    keys: ["up", "enter"],
  });
  assert.deepEqual(parseHerdrCommand("/herdr read lnny"), { kind: "read", target: "lnny" });
  assert.deepEqual(parseHerdrCommand("/herdr stop lnny"), { kind: "stop", target: "lnny" });
  assert.deepEqual(parseHerdrCommand("/herdr watch lnny"), { kind: "watch", target: "lnny" });
  assert.deepEqual(parseHerdrCommand("/herdr cancel ab12cd34"), { kind: "cancel", id: "ab12cd34" });
});

test("缺参数时给出用法，而不是静默失败", () => {
  for (const text of [
    "/herdr use",
    "/herdr task lnny",
    "/herdr new pi",
    "/herdr send lnny",
    "/herdr keys lnny",
    "/herdr cancel",
  ]) {
    const cmd = parseHerdrCommand(text);
    assert.equal(cmd?.kind, "invalid", text);
    assert.match(cmd !== undefined && cmd.kind === "invalid" ? cmd.reason : "", /用法/);
  }
});

test("裸正文按派活处理，已注册的子命令优先", () => {
  assert.deepEqual(parseHerdrCommand("/herdr 帮我看下 CI 为什么挂"), {
    kind: "run",
    task: "帮我看下 CI 为什么挂",
  });
  // 任务正文里的换行/空格保留原样
  assert.deepEqual(parseHerdrCommand("/herdr 第一行\n第二行"), {
    kind: "run",
    task: "第一行\n第二行",
  });
  assert.deepEqual(parseHerdrCommand("/herdr status"), { kind: "status" });
  assert.deepEqual(parseHerdrCommand("/herdr help"), { kind: "help" });
});

const agents: HerdrAgent[] = [
  { name: "lnny", kind: "claude", status: "working", cwd: "/repo/a", focused: false },
  { name: "zgy", kind: "pi", status: "idle", focused: true },
];

test("agent 列表标出状态、目录和当前选择", () => {
  const text = renderAgentList(agents, "zgy");
  assert.match(text, /\*\*lnny（claude）\*\* 运行中 — \/repo\/a/);
  assert.match(text, /zgy（pi）\*\* 空闲.*✅ 当前/);
  assert.match(text, /当前默认：\*\*zgy\*\*/);
});

test("没有 agent 时给出下一步而不是空列表", () => {
  assert.match(renderAgentList([], undefined), /没有活动 agent/);
});

test("派活回执带 watch id 和任务摘要", () => {
  const text = renderDispatchAck({ agent: "lnny", task: "修一下\n登录", watchId: "ab12" });
  assert.match(text, /已派给 lnny/);
  assert.match(text, /ab12/);
  assert.match(text, /修一下 登录/);
});

test("结果渲染区分 完成 / blocked / 超时 / stalled", () => {
  const base = { agent: "lnny", body: "答案", elapsedMs: 65_000, watchId: "ab12" };
  assert.match(
    renderResult({ ...base, status: "done", timedOut: false, stalled: false }),
    /✅ \*\*lnny 已完成\*\*（1 分 5 秒）/,
  );
  assert.match(
    renderResult({ ...base, status: "idle", timedOut: false, stalled: false }),
    /✅/,
  );
  const blocked = renderResult({ ...base, status: "blocked", timedOut: false, stalled: false });
  assert.match(blocked, /在等你回复/);
  assert.match(blocked, /\/herdr keys lnny enter/);
  assert.match(
    renderResult({ ...base, status: "working", timedOut: true, stalled: false }),
    /还在跑/,
  );
  assert.match(
    renderResult({ ...base, status: "idle", timedOut: false, stalled: true }),
    /没接住这句话/,
  );
});

test("结果为空时不编内容", () => {
  const text = renderResult({
    agent: "x",
    status: "done",
    body: "   ",
    elapsedMs: 1000,
    timedOut: false,
    stalled: false,
    watchId: "w",
  });
  assert.match(text, /（没读到输出内容）/);
});

test("watch 列表空与非空", () => {
  assert.match(renderWatchList([]), /没有在等的任务/);
  const text = renderWatchList([{ id: "ab12", agent: "lnny", task: "干活", startedAgoMs: 30_000 }]);
  assert.match(text, /ab12/);
  assert.match(text, /lnny/);
  assert.match(text, /30 秒/);
});

test("help 覆盖所有子命令", () => {
  const help = renderHerdrHelp();
  for (const sub of ["use", "run", "task", "new", "status", "read", "send", "keys", "watch", "stop", "cancel"]) {
    assert.match(help, new RegExp(`/herdr ${sub}`), sub);
  }
});

test("选 agent 卡片的按钮 value 能解析回来，并绑死发出时的会话", () => {
  const card = buildAgentPickerCard("card-1", "oc_chat", agents, "zgy") as {
    elements: { tag: string; actions?: { value: unknown; text: { content: string } }[] }[];
  };
  const buttons = card.elements.flatMap((e) => e.actions ?? []);
  assert.equal(buttons.length, 2);
  const parsed = parseHerdrCardAction(buttons[0].value);
  assert.deepEqual(parsed, { id: "card-1", chatId: "oc_chat", target: "lnny" });
  assert.match(buttons[0].text.content, /lnny·忙/);
});

test("parseHerdrCardAction 对陌生 value 返回 undefined（不抢审批卡片的点击）", () => {
  assert.equal(parseHerdrCardAction({ kind: "pi-feishu-approval", id: "ap-1", allow: true }), undefined);
  assert.equal(parseHerdrCardAction({ kind: HERDR_CARD_KIND, id: "x", chatId: "c" }), undefined);
  assert.equal(parseHerdrCardAction(null), undefined);
});
