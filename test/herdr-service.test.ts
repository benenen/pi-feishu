import { test } from "node:test";
import assert from "node:assert/strict";
import type { HerdrCli } from "../extensions/herdr/cli.ts";
import { err, ok, type Result } from "../extensions/herdr/types.ts";
import { HerdrService } from "../extensions/feishu/herdr-service.ts";
import type { BackgroundResult } from "../extensions/feishu/background-summary.ts";
import type { SendTarget } from "../extensions/feishu/types.ts";

const KIND_TEXT = "kinds: pi|claude|codex\n";

const agentInfo = (name: string, status: string) => ({
  agent: {
    name,
    agent: "pi",
    agent_status: status,
    pane_id: "w1:p1",
    focused: false,
    state_change_seq: 1,
  },
});

interface Harness {
  service: HerdrService;
  sent: { text: string; to: SendTarget }[];
  calls: string[][];
}

function harness(handler: (args: string[]) => Result<unknown> | Promise<Result<unknown>>, onComplete?: (result: BackgroundResult) => Promise<void>): Harness {
  const calls: string[][] = [];
  const cli: HerdrCli = {
    bin: "herdr",
    async run<T>(args: string[]): Promise<Result<T>> {
      calls.push(args);
      return (await handler(args)) as Result<T>;
    },
  };
  const sent: { text: string; to: SendTarget }[] = [];
  let n = 0;
  const service = new HerdrService({
    cli,
    onComplete,
    send: async (text, to) => {
      sent.push({ text, to });
    },
    log: () => {},
    now: () => 0,
    newId: () => `id${(n += 1)}`,
  });
  return { service, sent, calls };
}

/** 一个「所有 agent 都空闲、prompt 立刻完成」的假 herdr */
function idleHerdr(
  overrides: Record<string, () => Result<unknown> | Promise<Result<unknown>>> = {},
) {
  return (args: string[]): Result<unknown> | Promise<Result<unknown>> => {
    const key = args.slice(0, 2).join(" ");
    const custom = overrides[key];
    if (custom) return custom();
    if (args[0] === "agent" && args.length === 1) return ok(KIND_TEXT);
    if (args[0] === "agent" && args[1] === "list") {
      return ok({ agents: [agentInfo("lnny", "idle").agent] });
    }
    if (args[0] === "agent" && args[1] === "get") return ok(agentInfo(args[2], "idle"));
    if (args[0] === "agent" && args[1] === "wait") return ok(agentInfo(args[2], "done"));
    if (args[0] === "agent" && args[1] === "prompt") return ok(agentInfo(args[2], "done"));
    if (args[0] === "agent" && args[1] === "read") return ok("面板输出");
    if (args[0] === "agent" && args[1] === "start") {
      return ok({ agent: { ...agentInfo("fb-1", "idle").agent, name: args[2] } });
    }
    return ok({});
  };
}

test("未选 agent 时从已有空闲 agent 中派活，绝不隐式新建", async () => {
  const { service, calls } = harness(idleHerdr());
  const r = await service.dispatch({ chatId: "c1", to: { chatId: "c1" }, task: "干活" });
  assert.equal(r.ok, true);
  assert.equal(r.ok && r.data.agent, "lnny");
  assert.equal(calls.some((args) => args[0] === "workspace" || args[0] === "pane" || args[1] === "start"), false);
  await service.drain();
});

test("没有可用的现有 agent 时明确报错，不创建 agent", async () => {
  const { service, calls } = harness(idleHerdr({ "agent list": () => ok({ agents: [] }) }));
  const r = await service.dispatch({ chatId: "c1", to: { chatId: "c1" }, task: "干活" });
  assert.equal(r.ok, false);
  assert.match(r.ok ? "" : r.error.message, /现有|已有/);
  assert.equal(calls.some((args) => args[0] === "workspace" || args[0] === "pane" || args[1] === "start"), false);
});

test("自动选择优先任务相关的空闲 agent，跳过运行中和未就绪 agent", async () => {
  const agents = [
    { ...agentInfo("busy", "working").agent, cwd: "/repo/login" },
    { ...agentInfo("other", "idle").agent, cwd: "/repo/other" },
    { ...agentInfo("login", "idle").agent, cwd: "/repo/login" },
  ];
  const { service } = harness(idleHerdr({ "agent list": () => ok({ agents }) }));
  const r = await service.dispatch({ chatId: "c1", to: { chatId: "c1" }, task: "修复 login 的问题" });
  assert.equal(r.ok && r.data.agent, "login");
  await service.drain();
});

test("派活：先回执再在后台等，完成后把结果发回原对话", async () => {
  const { service, sent } = harness(idleHerdr());
  service.select("c1", "lnny");
  const r = await service.dispatch({ chatId: "c1", to: { chatId: "c1" }, task: "修登录" });
  assert.equal(r.ok, true);
  await service.drain();

  assert.equal(sent.length, 2, "一条回执 + 一条结果");
  assert.match(sent[0].text, /已派给 lnny/);
  assert.deepEqual(sent[0].to, { chatId: "c1" });
  assert.match(sent[1].text, /✅ \*\*lnny 已完成\*\*/);
  assert.match(sent[1].text, /面板输出/);
  assert.equal(service.watchCount, 0);
});

test("同一 agent 上再派活被拒；不同 agent 可以并行", async () => {
  // prompt 永远不落地，保证第一个 watch 一直挂在册上
  const pending = new Promise<Result<unknown>>(() => {});
  const h = harness((args) => {
    if (args[0] === "agent" && args.length === 1) return ok(KIND_TEXT);
    if (args[1] === "get") return ok(agentInfo(args[2], "idle"));
    if (args[1] === "prompt") return pending;
    return ok({});
  });

  const first = await h.service.dispatch({ chatId: "c1", to: { chatId: "c1" }, task: "a", target: "lnny" });
  assert.equal(first.ok, true);
  const dup = await h.service.dispatch({ chatId: "c1", to: { chatId: "c1" }, task: "b", target: "lnny" });
  assert.equal(dup.ok ? "" : dup.error.code, "VALIDATION_ERROR");
  assert.match(dup.ok ? "" : dup.error.message, /已经在等/);

  const other = await h.service.dispatch({ chatId: "c1", to: { chatId: "c1" }, task: "c", target: "zgy" });
  assert.equal(other.ok, true, "换一个 agent 应该能立刻派");
  assert.equal(h.service.watchCount, 2, "两个 agent 上各挂一个，互不排队");
  assert.equal(h.service.watching().length, 2, "终端状态要拿得到所有对话的 watcher");
  assert.deepEqual(
    h.service.watching("c1").map((w) => w.agent).sort(),
    ["lnny", "zgy"],
  );
});

test("herdr 说 agent 正忙时拒绝派活，不打断人家", async () => {
  const { service, sent } = harness(
    idleHerdr({ "agent get": () => ok(agentInfo("lnny", "working")) }),
  );
  service.select("c1", "lnny");
  const r = await service.dispatch({ chatId: "c1", to: { chatId: "c1" }, task: "插队" });
  assert.equal(r.ok ? "" : r.error.code, "VALIDATION_ERROR");
  assert.match(r.ok ? "" : r.error.message, /正忙/);
  assert.deepEqual(sent, []);
});

test("cancel 掉的任务不再回结果，也不影响别的 watch", async () => {
  // lnny 上的 prompt 挂着不落地，保证 cancel 时这个 watch 还在册上
  let release: (r: Result<unknown>) => void = () => {};
  const pending = new Promise<Result<unknown>>((resolve) => {
    release = resolve;
  });
  const { service, sent } = harness((args) => {
    if (args[0] === "agent" && args.length === 1) return ok(KIND_TEXT);
    if (args[1] === "get") return ok(agentInfo(args[2], "idle"));
    if (args[1] === "prompt") return args[2] === "lnny" ? pending : ok(agentInfo(args[2], "done"));
    if (args[1] === "read") return ok("面板输出");
    return ok({});
  });

  const a = await service.dispatch({ chatId: "c1", to: { chatId: "c1" }, task: "a", target: "lnny" });
  const b = await service.dispatch({ chatId: "c1", to: { chatId: "c1" }, task: "b", target: "zgy" });
  assert.equal(a.ok && b.ok, true);
  const watchId = a.ok ? a.data.watchId : "";
  assert.equal(service.cancel("c1", watchId), true);
  assert.equal(service.cancel("别的对话", watchId), false, "别人不能取消这个对话的 watch");

  release(ok(agentInfo("lnny", "done")));
  await service.drain();
  const texts = sent.map((s) => s.text).join("\n");
  assert.doesNotMatch(texts, /lnny 已完成/);
  assert.match(texts, /zgy 已完成/);
});

test("shutdown 取消全部 watch，且不再往飞书发东西", async () => {
  const { service, sent } = harness(idleHerdr());
  await service.dispatch({ chatId: "c1", to: { chatId: "c1" }, task: "a", target: "lnny" });
  const before = sent.length;
  await service.shutdown();
  assert.equal(service.watchCount, 0);
  assert.equal(sent.length, before, "shutdown 之后不该再有回执/结果");
});

test("new：先起 agent 再派活，目标用 herdr 返回的名字", async () => {
  const h = harness((args) => {
    if (args[0] === "agent" && args.length === 1) return ok(KIND_TEXT);
    if (args[0] === "workspace") return ok({ root_pane: { pane_id: "w9:p1" } });
    if (args[0] === "agent" && args[1] === "start") {
      return ok({ agent: { ...agentInfo(args[2], "idle").agent, name: args[2] } });
    }
    if (args[1] === "get") return ok(agentInfo(args[2], "idle"));
    if (args[1] === "prompt") return ok(agentInfo(args[2], "done"));
    if (args[1] === "read") return ok("新 agent 的输出");
    return ok({});
  });
  const r = await h.service.dispatch({
    chatId: "c1",
    to: { chatId: "c1" },
    task: "写测试",
    agentKind: "claude",
  });
  assert.equal(r.ok, true);
  const started = h.calls.find((a) => a[1] === "start");
  assert.ok(started, "应该调了 agent start");
  assert.equal(started?.[2], "fb-id1");
  await h.service.drain();
  assert.match(h.sent[1].text, /fb-id1 已完成/);
});

test("watchExisting 对已经在跑的 agent 只挂 watch，不发 prompt", async () => {
  const { service, sent, calls } = harness(idleHerdr());
  const r = await service.watchExisting({ chatId: "c1", to: { chatId: "c1" }, target: "zgy" });
  assert.equal(r.ok, true);
  assert.equal(calls.some((a) => a[1] === "prompt"), false, "不该往里面发东西");
  await service.drain();
  assert.match(sent[0].text, /挂上 watch/);
  assert.match(sent[1].text, /zgy 已完成/);
});

test("listAgents / send / read / stop 透传 herdr 结果", async () => {
  const h = harness(idleHerdr());
  const list = await h.service.listAgents();
  assert.equal(list.ok ? list.data.length : 0, 1);
  assert.equal((await h.service.send("zgy", "继续")).ok, true);
  const read = await h.service.read("zgy");
  assert.equal(read.ok ? read.data : "", "面板输出");
  const stopped = await h.service.stop("zgy");
  assert.equal(stopped.ok, true);
  assert.equal((await h.service.keys("zgy", ["esc"])).ok, true);
});

test("派活失败时如实把 herdr 错误报回来", async () => {
  const { service, sent } = harness(
    idleHerdr({ "agent get": () => err("NOT_FOUND", "agent target nope not found") }),
  );
  service.select("c1", "nope");
  const r = await service.dispatch({ chatId: "c1", to: { chatId: "c1" }, task: "x" });
  assert.equal(r.ok ? "" : r.error.code, "NOT_FOUND");
  assert.deepEqual(sent, []);
});


test("herdr watch 完成后将结果交给 agent 总结，飞书只收到派活回执", async () => {
  const completed: BackgroundResult[] = [];
  const { service, sent } = harness(idleHerdr(), async (result) => { completed.push(result); });
  const to = { chatId: "c1", replyTo: "原问题", inThread: true };
  service.select("c1", "lnny");
  await service.dispatch({ chatId: "c1", to, task: "了解今天新闻", threadId: "原话题" });
  await service.drain();
  assert.equal(sent.length, 1, "原始面板输出不能另发给用户");
  assert.doesNotMatch(sent[0].text, /面板输出/);
  assert.equal(completed.length, 1);
  assert.match(completed[0].body, /面板输出/);
  assert.equal(completed[0].question, "了解今天新闻");
  assert.equal(completed[0].threadId, "原话题");
  assert.deepEqual(completed[0].to, to);
});
