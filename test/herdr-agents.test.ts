import { homedir } from "node:os";
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import type { HerdrCli } from "../extensions/herdr/cli.ts";
import { ok, type Result } from "../extensions/herdr/types.ts";
import {
  getAgent,
  listAgentKinds,
  listAgents,
  parseAgentKinds,
  readAgent,
  resetAgentKindsCache,
  startAgent,
  stopAgent,
  sendKeys,
} from "../extensions/herdr/agents.ts";

const KIND_TEXT = "herdr agent commands:\n  kinds: pi|claude|codex|qwen\n";

function fakeCli(handler: (args: string[]) => Result<unknown>) {
  const calls: string[][] = [];
  const cli: HerdrCli = {
    bin: "herdr",
    async run<T>(args: string[]): Promise<Result<T>> {
      calls.push(args);
      return handler(args) as Result<T>;
    },
  };
  return { cli, calls };
}

beforeEach(() => resetAgentKindsCache());

test("parseAgentKinds 只认尾部那行 kinds:", () => {
  assert.deepEqual(parseAgentKinds(KIND_TEXT), ["pi", "claude", "codex", "qwen"]);
  assert.equal(parseAgentKinds("no kinds here"), null);
});

test("listAgentKinds 取活列表并缓存，二次不再调用", async () => {
  const { cli, calls } = fakeCli(() => ok(KIND_TEXT));
  assert.deepEqual(await listAgentKinds(cli), ["pi", "claude", "codex", "qwen"]);
  await listAgentKinds(cli);
  assert.equal(calls.length, 1);
});

test("listAgentKinds 取不到活列表时退回内置表", async () => {
  const { cli } = fakeCli(() => ({ ok: false, error: { code: "HERDR_UNAVAILABLE", message: "x" } }));
  const kinds = await listAgentKinds(cli);
  assert.ok(kinds.includes("pi"));
  assert.ok(kinds.length > 4);
});

test("listAgents 归一化 snake_case 字段并丢掉脏条目", async () => {
  const { cli } = fakeCli(() =>
    ok({
      agents: [
        {
          name: "lnny",
          agent: "claude",
          agent_status: "working",
          pane_id: "w4:p1",
          workspace_id: "w4",
          terminal_title_stripped: "做题",
          focused: false,
          state_change_seq: 12,
        },
        "垃圾条目",
      ],
    }),
  );
  const r = await listAgents(cli);
  assert.equal(r.ok, true);
  const agents = r.ok ? r.data : [];
  assert.equal(agents.length, 1);
  assert.deepEqual(agents[0], {
    name: "lnny",
    kind: "claude",
    status: "working",
    paneId: "w4:p1",
    cwd: undefined,
    workspaceId: "w4",
    tabId: undefined,
    title: "做题",
    focused: false,
    interactiveReady: undefined,
    stateChangeSeq: 12,
    sessionPath: undefined,
  });
});

test("pi 的会话文件路径只在 kind=path 时才认", async () => {
  const { cli } = fakeCli(() =>
    ok({
      agent: {
        name: "p",
        agent: "pi",
        agent_status: "idle",
        pane_id: "w1:p1",
        focused: true,
        agent_session: { source: "herdr:pi", kind: "path", value: "/tmp/s.jsonl", agent: "pi" },
      },
    }),
  );
  const r = await getAgent(cli, "p");
  assert.equal(r.ok ? r.data.sessionPath : undefined, "/tmp/s.jsonl");

  const idOnly = fakeCli(() =>
    ok({
      agent: {
        agent: "claude",
        agent_status: "idle",
        pane_id: "w1:p1",
        focused: true,
        agent_session: { source: "herdr:claude", kind: "id", value: "uuid", agent: "claude" },
      },
    }),
  );
  const r2 = await getAgent(idOnly.cli, "c");
  assert.equal(r2.ok ? r2.data.sessionPath : "x", undefined);
});

test("getAgent 拿不到 agent 对象时报 NOT_FOUND", async () => {
  const { cli } = fakeCli(() => ok({}));
  const r = await getAgent(cli, "nope");
  assert.equal(r.ok ? "" : r.error.code, "NOT_FOUND");
});

test("readAgent 带上 source/lines 并读纯文本", async () => {
  const { cli, calls } = fakeCli(() => ok("  最终答案\n"));
  const r = await readAgent(cli, "p", { lines: 30 });
  assert.equal(r.ok ? r.data : undefined, "  最终答案\n");
  assert.deepEqual(calls[0], [
    "agent",
    "read",
    "p",
    "--source",
    "recent-unwrapped",
    "--lines",
    "30",
    "--format",
    "text",
  ]);
});

test("在 herdr 里 startAgent 走 split 兄弟 pane，且默认不抢焦点", async () => {
  const { cli, calls } = fakeCli((args) => {
    if (args[0] === "agent" && args.length === 1) return ok(KIND_TEXT);
    if (args[0] === "pane") return ok({ pane: { pane_id: "w1:p2" } });
    if (args[0] === "agent" && args[1] === "start") {
      return ok({ agent: { name: "rev", agent: "pi", agent_status: "idle", pane_id: "w1:p2", focused: false } });
    }
    return ok({});
  });
  const r = await startAgent(cli, { name: "rev", kind: "pi", cwd: "/repo", insideHerdr: true });
  assert.equal(r.ok, true);
  assert.deepEqual(calls[1], [
    "pane",
    "split",
    "--current",
    "--direction",
    "right",
    "--cwd",
    "/repo",
    "--no-focus",
  ]);
  assert.deepEqual(calls[2], ["agent", "start", "rev", "--kind", "pi", "--pane", "w1:p2"]);
});

test("不在 herdr 里 startAgent 开新 workspace，绝不动焦点 pane", async () => {
  const { cli, calls } = fakeCli((args) => {
    if (args[0] === "agent" && args.length === 1) return ok(KIND_TEXT);
    if (args[0] === "workspace") return ok({ root_pane: { pane_id: "w9:p1" } });
    return ok({ agent: { name: "rev", agent: "claude", agent_status: "idle", pane_id: "w9:p1", focused: false } });
  });
  const r = await startAgent(cli, { name: "rev", kind: "claude", cwd: "/repo", insideHerdr: false });
  assert.equal(r.ok, true);
  assert.deepEqual(calls[1], [
    "workspace",
    "create",
    "--label",
    "rev",
    "--cwd",
    "/repo",
    "--no-focus",
  ]);
});

test("startAgent 拒绝不认识的种类与不合法的名字，且不创建 pane", async () => {
  const { cli, calls } = fakeCli((args) => (args[0] === "agent" && args.length === 1 ? ok(KIND_TEXT) : ok({})));
  const bad = await startAgent(cli, { name: "ok-name", kind: "not-a-kind", insideHerdr: true });
  assert.equal(bad.ok ? "" : bad.error.code, "VALIDATION_ERROR");
  const badName = await startAgent(cli, { name: "BAD NAME", kind: "pi", insideHerdr: true });
  assert.equal(badName.ok ? "" : badName.error.code, "VALIDATION_ERROR");
  const created = calls.filter((a) => a[0] === "pane" || a[0] === "workspace");
  assert.deepEqual(created, [], "被拒的 start 不该创建任何 pane");
});

test("startAgent 把 agentArgs 放在 -- 之后透传", async () => {
  const { cli, calls } = fakeCli((args) => {
    if (args[0] === "agent" && args.length === 1) return ok(KIND_TEXT);
    if (args[0] === "pane") return ok({ pane: { pane_id: "w1:p9" } });
    return ok({ agent: { name: "d", agent: "pi", agent_status: "idle", pane_id: "w1:p9", focused: false } });
  });
  await startAgent(cli, {
    name: "dev",
    kind: "pi",
    insideHerdr: true,
    agentArgs: ["-ne", "-e", "./extensions"],
  });
  assert.deepEqual(calls[2], [
    "agent",
    "start",
    "dev",
    "--kind",
    "pi",
    "--pane",
    "w1:p9",
    "--",
    "-ne",
    "-e",
    "./extensions",
  ]);
});

test("stopAgent 先取 pane 再关它；没有 pane 时明确报错", async () => {
  const { cli, calls } = fakeCli((args) => {
    if (args[0] === "agent") return ok({ agent: { name: "x", agent_status: "idle", pane_id: "w1:p3", focused: false } });
    return ok({});
  });
  const r = await stopAgent(cli, "x");
  assert.equal(r.ok ? r.data : "", "w1:p3");
  assert.deepEqual(calls[1], ["pane", "close", "w1:p3"]);

  const noPane = fakeCli(() => ok({ agent: { name: "x", agent_status: "idle", focused: false } }));
  const r2 = await stopAgent(noPane.cli, "x");
  assert.equal(r2.ok ? "" : r2.error.code, "VALIDATION_ERROR");
});

test("sendKeys 要求至少一个按键，其余原样透传", async () => {
  const { cli, calls } = fakeCli(() => ok({}));
  const empty = await sendKeys(cli, "x", []);
  assert.equal(empty.ok ? "" : empty.error.code, "VALIDATION_ERROR");
  await sendKeys(cli, "x", ["ctrl+c"]);
  assert.deepEqual(calls[calls.length - 1], ["agent", "send-keys", "x", "ctrl+c"]);
});


test("startAgent 未指定目录时 split 和新 workspace 都显式使用用户主目录", async () => {
  for (const insideHerdr of [true, false]) {
    for (const cwd of [undefined, "", "~"]) {
      const { cli, calls } = fakeCli((args) => {
        if (args[0] === "agent" && args.length === 1) return ok(KIND_TEXT);
        if (args[0] === "pane") return ok({ pane: { pane_id: "w2:p2" } });
        if (args[0] === "workspace") return ok({ root_pane: { pane_id: "w2:p2" } });
        return ok({ agent: { name: "test", agent: "pi", agent_status: "idle", pane_id: "w2:p2" } });
      });
      await startAgent(cli, { name: "test", insideHerdr, cwd });
      const pane = calls.find((args) => args[0] === "pane" || args[0] === "workspace")!;
      assert.equal(pane[pane.indexOf("--cwd") + 1], homedir(), "不能继承当前仓库或父 pane 的目录");
    }
  }
});
