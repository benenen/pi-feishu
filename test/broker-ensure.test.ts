import { test } from "node:test";
import assert from "node:assert/strict";
import { ensureBroker, type EnsureDeps } from "../extensions/feishu/broker/ensure.ts";

/**
 * 可控依赖：probe 按脚本逐次返回，spawn 记账，时钟由 sleep 推进。
 * 不碰真实进程与真实 socket。
 */
function deps(probeScript: boolean[], opts: { spawnThrows?: Error; timeoutMs?: number } = {}) {
  let t = 0;
  const spawned: number[] = [];
  let i = 0;
  const d: EnsureDeps = {
    probe: async () => probeScript[Math.min(i++, probeScript.length - 1)] ?? false,
    spawn: () => {
      if (opts.spawnThrows) throw opts.spawnThrows;
      spawned.push(t);
      return { pid: 4242 };
    },
    sleep: async (ms) => {
      t += ms;
    },
    now: () => t,
    timeoutMs: opts.timeoutMs ?? 1000,
    pollMs: 100,
  };
  return { d, spawned, probeCount: () => i };
}

test("socket 已经可连时直接返回 already，绝不重复拉起", async () => {
  const { d, spawned } = deps([true]);
  assert.equal(await ensureBroker(d, () => {}), "already");
  assert.deepEqual(spawned, [], "已经有 broker 在服务，再拉一个就是抢消息");
});

test("连不上则拉起，等到可连返回 started", async () => {
  const { d, spawned } = deps([false, false, true]);
  assert.equal(await ensureBroker(d, () => {}), "started");
  assert.equal(spawned.length, 1);
});

test("只拉起一次 —— 轮询期间不重复 spawn", async () => {
  const { d, spawned } = deps([false, false, false, false, true]);
  assert.equal(await ensureBroker(d, () => {}), "started");
  assert.equal(spawned.length, 1, `拉起了 ${spawned.length} 次`);
});

test("一直连不上则超时返回 failed", async () => {
  const { d, spawned } = deps([false], { timeoutMs: 500 });
  assert.equal(await ensureBroker(d, () => {}), "failed");
  assert.equal(spawned.length, 1);
});

test("超时那一刻再探一次 —— 并发竞争中别人的 broker 赢了也算成功", async () => {
  // 时间驱动而不是次数驱动：socket 恰好在超时之后才变得可连，
  // 精确验证「循环退出后那一次补探」把结果救了回来
  let t = 0;
  const d: EnsureDeps = {
    probe: async () => t >= 500,
    spawn: () => ({ pid: 1 }),
    sleep: async (ms) => {
      t += ms;
    },
    now: () => t,
    timeoutMs: 500,
    pollMs: 100,
  };
  assert.equal(await ensureBroker(d, () => {}), "started");
});

test("spawn 抛错时，若此刻已有别人的 broker 在服务，仍算成功", async () => {
  // 两个 pi 会话同时启动：我方 spawn 失败，但对方的 broker 已经起来了
  let calls = 0;
  const d: EnsureDeps = {
    probe: async () => {
      calls += 1;
      return calls > 1; // 第一次探失败（所以会去 spawn），之后可连
    },
    spawn: () => {
      throw new Error("EACCES");
    },
    sleep: async () => {},
    now: () => 0,
    timeoutMs: 1000,
    pollMs: 100,
  };
  assert.equal(await ensureBroker(d, () => {}), "started");
});

test("spawn 抛错且确实没有 broker 在服务 → failed，且失败原因要进日志", async () => {
  const logged: string[] = [];
  const { d } = deps([false], { spawnThrows: new Error("EACCES 权限不足"), timeoutMs: 300 });
  assert.equal(await ensureBroker(d, (m) => logged.push(m)), "failed");
  assert.ok(logged.some((m) => m.includes("EACCES")), `日志里没有失败原因：${logged.join(" | ")}`);
});

test("拉起成功要留下日志痕迹 —— 用户得知道是谁把 broker 起起来的", async () => {
  const logged: string[] = [];
  const { d } = deps([false, true]);
  await ensureBroker(d, (m) => logged.push(m));
  assert.ok(logged.length > 0, "自动拉起了一个常驻进程却一声不吭，排查时会很困惑");
});
