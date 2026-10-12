import { test } from "node:test";
import assert from "node:assert/strict";
import type { HerdrCli } from "../extensions/herdr/cli.ts";
import { err, ok, type Result } from "../extensions/herdr/types.ts";
import { promptAndWatch, watchUntilSettled } from "../extensions/herdr/watch.ts";

type Handler = (args: string[]) => Result<unknown>;

function fakeCli(handler: Handler) {
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

const agent = (status: string, seq = 1) => ({
  agent: { name: "x", agent: "pi", agent_status: status, pane_id: "w1:p1", focused: false, state_change_seq: seq },
});

/** 立刻返回的 sleep + 每次调用前进 1000ms 的时钟，测试里不等真实时间 */
function fakeClock(stepMs = 1000) {
  let t = 0;
  return {
    now: () => {
      const v = t;
      t += stepMs;
      return v;
    },
    sleep: async () => {},
  };
}

test("promptAndWatch：prompt --wait 直接落地就返回结算状态", async () => {
  const { cli, calls } = fakeCli((args) => {
    if (args[1] === "get") return ok(agent("idle", 7));
    return ok(agent("done", 9));
  });
  const r = await promptAndWatch(cli, "x", "做点事", fakeClock());
  assert.equal(r.ok, true);
  assert.equal(r.ok ? r.data.status : "", "done");
  assert.equal(r.ok ? r.data.timedOut : true, false);
  assert.equal(r.ok ? r.data.stalled : true, false);
  const prompt = calls.find((a) => a[1] === "prompt");
  assert.deepEqual(prompt?.slice(4), [
    "--wait",
    "--until",
    "idle",
    "--until",
    "done",
    "--until",
    "blocked",
    "--timeout",
    "300000",
  ]);
});

test("promptAndWatch：单次等待超时后继续分片等，最终拿到落地状态", async () => {
  let waits = 0;
  const { cli } = fakeCli((args) => {
    if (args[1] === "get") return ok(agent("working", 3));
    if (args[1] === "prompt") return err("TIMEOUT", "超时了");
    if (args[1] === "wait") {
      waits += 1;
      return waits === 1 ? err("TIMEOUT", "还没完") : ok(agent("idle", 5));
    }
    return ok({});
  });
  const r = await promptAndWatch(cli, "x", "长任务", fakeClock());
  assert.equal(r.ok ? r.data.status : "", "idle");
  assert.equal(r.ok ? r.data.timedOut : true, false);
  assert.equal(waits, 2);
});

test("promptAndWatch：agent_prompt_stalled 且状态序号不动 → stalled，不谎报完成", async () => {
  const { cli } = fakeCli((args) => {
    if (args[1] === "get") return ok(agent("idle", 4));
    if (args[1] === "prompt") return err("PROMPT_STALLED", "没观测到活动");
    return ok({});
  });
  const r = await promptAndWatch(cli, "x", "没接住的话", {
    ...fakeClock(),
    stallGraceMs: 1000,
    pollMs: 1000,
  });
  assert.equal(r.ok ? r.data.stalled : false, true);
  assert.equal(r.ok ? r.data.timedOut : true, false);
});

test("promptAndWatch：stalled 后状态序号动了 → 按正常落地处理", async () => {
  let gets = 0;
  const { cli } = fakeCli((args) => {
    if (args[1] === "get") {
      gets += 1;
      // 第一次是派发前的快照，之后状态真的动了
      return ok(agent(gets === 1 ? "idle" : "idle", gets === 1 ? 4 : 6));
    }
    if (args[1] === "prompt") return err("PROMPT_STALLED", "慢热");
    return ok({});
  });
  const r = await promptAndWatch(cli, "x", "慢热任务", {
    ...fakeClock(),
    stallGraceMs: 1000,
    pollMs: 1000,
  });
  assert.equal(r.ok ? r.data.stalled : true, false);
  assert.equal(r.ok ? r.data.status : "", "idle");
});

test("promptAndWatch：其他错误（比如 agent 不存在）原样透出", async () => {
  const { cli } = fakeCli((args) => {
    if (args[1] === "get") return ok(agent("idle", 1));
    if (args[1] === "prompt") return err("NOT_FOUND", "没有这个 agent");
    return ok({});
  });
  const r = await promptAndWatch(cli, "x", "hi", fakeClock());
  assert.equal(r.ok ? "" : r.error.code, "NOT_FOUND");
});

test("watchUntilSettled：已经是落地态时立刻收工", async () => {
  const { cli, calls } = fakeCli(() => ok(agent("blocked", 2)));
  const r = await watchUntilSettled(cli, "x", fakeClock());
  assert.equal(r.ok ? r.data.status : "", "blocked");
  assert.deepEqual(calls[0].slice(0, 3), ["agent", "wait", "x"]);
});

test("watchUntilSettled：到达总时限仍在跑 → timedOut 报告真实状态", async () => {
  const { cli } = fakeCli((args) => {
    if (args[1] === "wait") return err("TIMEOUT", "还没完");
    if (args[1] === "get") return ok(agent("working", 3));
    return ok({});
  });
  const r = await watchUntilSettled(cli, "x", { ...fakeClock(600_000), maxWaitMs: 1000 });
  assert.equal(r.ok ? r.data.timedOut : false, true);
  assert.equal(r.ok ? r.data.status : "", "working");
});

test("watchUntilSettled：分片超时后先探一次真实状态，落地就收工", async () => {
  const { cli } = fakeCli((args) => {
    if (args[1] === "wait") return err("TIMEOUT", "分片超时");
    if (args[1] === "get") return ok(agent("done", 8));
    return ok({});
  });
  const r = await watchUntilSettled(cli, "x", { ...fakeClock(10), maxWaitMs: 10_000 });
  assert.equal(r.ok ? r.data.timedOut : true, false);
  assert.equal(r.ok ? r.data.status : "", "done");
});

test("已取消的 watch 立刻返回 CANCELLED，不发起任何调用", async () => {
  const { cli, calls } = fakeCli(() => ok({}));
  const controller = new AbortController();
  controller.abort();
  const r = await watchUntilSettled(cli, "x", { signal: controller.signal });
  assert.equal(r.ok ? "" : r.error.code, "CANCELLED");
  assert.equal(calls.length, 0);
});
