import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_TIMEOUT_MS,
  createHerdrCli,
  mapErrorCode,
  parseLastJson,
  resolveHerdrBin,
  type SpawnFn,
  type SpawnOutcome,
} from "../extensions/herdr/cli.ts";

interface Recorded {
  bin: string;
  args: string[];
  timeoutMs: number;
}

function fakeSpawn(outcome: SpawnOutcome | ((call: Recorded) => SpawnOutcome)) {
  const calls: Recorded[] = [];
  const spawn: SpawnFn = async (bin, args, opts) => {
    const call = { bin, args, timeoutMs: opts.timeoutMs };
    calls.push(call);
    return typeof outcome === "function" ? outcome(call) : outcome;
  };
  return { spawn, calls };
}

function cliWith(outcome: SpawnOutcome | ((call: Recorded) => SpawnOutcome)) {
  const { spawn, calls } = fakeSpawn(outcome);
  const cli = createHerdrCli({ bin: "herdr", spawn, env: {} });
  return { cli, calls };
}

const json = (o: unknown) => JSON.stringify(o);

test("成功信封取 result", async () => {
  const { cli } = cliWith({ code: 0, stdout: json({ id: "x", result: { agents: [] } }), stderr: "" });
  const r = await cli.run<{ agents: unknown[] }>(["agent", "list"]);
  assert.equal(r.ok, true);
  assert.deepEqual(r.ok ? r.data : undefined, { agents: [] });
});

test("stdout 前后夹了非 JSON 行时取最后一个 JSON 对象", async () => {
  const { cli } = cliWith({
    code: 0,
    stdout: `warning: something\n${json({ id: "x", result: { value: 1 } })}\ntrailing`,
    stderr: "",
  });
  const r = await cli.run<{ value: number }>(["api", "snapshot"]);
  assert.deepEqual(r.ok ? r.data : undefined, { value: 1 });
});

test("错误信封在 stdout 上退出码为 0 也能认出来", async () => {
  const { cli } = cliWith({
    code: 0,
    stdout: json({ id: "x", error: { code: "agent_not_found", message: "agent target nope not found" } }),
    stderr: "",
  });
  const r = await cli.run(["agent", "get", "nope"]);
  assert.equal(r.ok, false);
  assert.equal(r.ok ? "" : r.error.code, "NOT_FOUND");
  assert.match(r.ok ? "" : r.error.message, /not found/);
});

test("退出码非 0 时错误信封写在 stderr 上也能认出来", async () => {
  const { cli } = cliWith({
    code: 1,
    stdout: "",
    stderr: json({ error: { code: "agent_not_ready", message: "agent is not ready" } }),
  });
  const r = await cli.run(["agent", "prompt", "x", "hi"]);
  assert.equal(r.ok ? "" : r.error.code, "AGENT_NOT_READY");
});

test("空输出 + 退出码 0 视为静默成功", async () => {
  const { cli } = cliWith({ code: 0, stdout: "", stderr: "" });
  const r = await cli.run(["agent", "send-keys", "x", "esc"]);
  assert.equal(r.ok, true);
  assert.deepEqual(r.ok ? r.data : undefined, {});
});

test("textOk 时把非 JSON 的 stdout 当文本成功数据", async () => {
  const { cli } = cliWith({ code: 0, stdout: "herdr 0.9.1\n", stderr: "" });
  const r = await cli.run<string>(["--version"], { textOk: true });
  assert.equal(r.ok ? r.data : undefined, "herdr 0.9.1\n");
});

test("没有 textOk 时同样的非 JSON 输出是 VALIDATION_ERROR", async () => {
  const { cli } = cliWith({ code: 0, stdout: "不是 JSON", stderr: "" });
  const r = await cli.run(["--version"]);
  assert.equal(r.ok ? "" : r.error.code, "VALIDATION_ERROR");
});

test("超时被杀翻成 TIMEOUT，不拿半截 stdout 去解析", async () => {
  const { cli } = cliWith({ code: null, stdout: '{"id":"x","resu', stderr: "", timedOut: true });
  const r = await cli.run(["agent", "wait", "x"], { timeoutMs: 1234 });
  assert.equal(r.ok ? "" : r.error.code, "TIMEOUT");
  assert.match(r.ok ? "" : r.error.message, /1234ms/);
});

test("abort 后调用直接返回 CANCELLED，不启动进程", async () => {
  const { cli, calls } = cliWith({ code: 0, stdout: "", stderr: "" });
  const controller = new AbortController();
  controller.abort();
  const r = await cli.run(["agent", "wait", "x"], { signal: controller.signal });
  assert.equal(r.ok ? "" : r.error.code, "CANCELLED");
  assert.equal(calls.length, 0);
});

test("spawn ENOENT 翻成 HERDR_UNAVAILABLE 并提示 HERDR_BIN", async () => {
  const e = Object.assign(new Error("spawn herdr ENOENT"), { code: "ENOENT" });
  const { cli } = cliWith({ code: null, stdout: "", stderr: "", spawnError: e });
  const r = await cli.run(["agent", "list"]);
  assert.equal(r.ok ? "" : r.error.code, "HERDR_UNAVAILABLE");
  assert.match(r.ok ? "" : r.error.message, /HERDR_BIN/);
});

test("默认超时是 DEFAULT_TIMEOUT_MS，显式给值覆盖", async () => {
  const { cli, calls } = cliWith({ code: 0, stdout: json({ result: {} }), stderr: "" });
  await cli.run(["agent", "list"]);
  await cli.run(["agent", "wait", "x"], { timeoutMs: 42 });
  assert.equal(calls[0].timeoutMs, DEFAULT_TIMEOUT_MS);
  assert.equal(calls[1].timeoutMs, 42);
});

test("mapErrorCode 覆盖已知码，未知码落 VALIDATION_ERROR", () => {
  assert.equal(mapErrorCode("agent_start_failed"), "AGENT_START_FAILED");
  assert.equal(mapErrorCode("agent_not_ready"), "AGENT_NOT_READY");
  assert.equal(mapErrorCode("agent_prompt_stalled"), "PROMPT_STALLED");
  assert.equal(mapErrorCode("agent_blocked"), "AGENT_BLOCKED");
  assert.equal(mapErrorCode("agent_not_found"), "NOT_FOUND");
  assert.equal(mapErrorCode("server_not_running"), "VALIDATION_ERROR");
  assert.equal(mapErrorCode("timed_out"), "TIMEOUT");
});

test("parseLastJson 对空串与纯文本返回 null", () => {
  assert.equal(parseLastJson(""), null);
  assert.equal(parseLastJson("   \n"), null);
  assert.equal(parseLastJson("hello world"), null);
  assert.deepEqual(parseLastJson('{"a":1}'), { a: 1 });
});

test("resolveHerdrBin 优先 HERDR_BIN，其次 PATH 命中，最后退回裸名字", () => {
  assert.equal(resolveHerdrBin({ HERDR_BIN: "/opt/herdr" }, () => false), "/opt/herdr");
  assert.equal(
    resolveHerdrBin({ PATH: "/usr/bin:/custom/bin" }, (p) => p === "/custom/bin/herdr"),
    "/custom/bin/herdr",
  );
  assert.equal(resolveHerdrBin({ PATH: "/usr/bin" }, () => false), "herdr");
});

test("globalArgs 拼在每条命令最前面，用来指定命名 session", async () => {
  const { spawn, calls } = fakeSpawn({ code: 0, stdout: json({ result: {} }), stderr: "" });
  const cli = createHerdrCli({ bin: "herdr", spawn, env: {}, globalArgs: ["--session", "work"] });
  await cli.run(["agent", "list"]);
  assert.deepEqual(calls[0].args, ["--session", "work", "agent", "list"]);
});
