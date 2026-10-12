import {
  err,
  isSettled,
  ok,
  type AgentStatus,
  type HerdrAgent,
  type HerdrTarget,
  type Result,
} from "./types.ts";
import type { HerdrCli } from "./cli.ts";
import { getAgent, promptAgent, waitAgent, WAIT_TIMEOUT_MS } from "./agents.ts";

/**
 * 一次 watch 的结算报告。
 *
 * `timedOut` 和 `stalled` 是两种**不同的没结果**：
 *   - timedOut：agent 还在跑，只是等超了 —— 任务大概率会成功，值得告诉人「还在跑」
 *   - stalled：prompt 写进去了，但 agent 的状态一格没动 —— 更像是它压根没接住这句话
 */
export interface SettleReport {
  status: AgentStatus;
  /** 结算那一刻的 agent 信息（可能没拿到，e.g. agent 中途没了） */
  agent?: HerdrAgent;
  timedOut: boolean;
  stalled: boolean;
  elapsedMs: number;
}

export interface WatchOptions {
  /** 单次 `agent wait` 的上限，超出后接着续等 */
  timeoutMs?: number;
  /** 总共愿意等多久。到点还在跑就返回 timedOut 报告，而不是无限挂着 */
  maxWaitMs?: number;
  /** agent_prompt_stalled 后，状态序号一直不动就等这么久再放弃 */
  stallGraceMs?: number;
  pollMs?: number;
  signal?: AbortSignal;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

const DEFAULT_MAX_WAIT_MS = 3_600_000;
const DEFAULT_STALL_GRACE_MS = 120_000;
const DEFAULT_POLL_MS = 5_000;

/** 可被 abort 打断的 sleep。abort 时立刻 resolve，由调用方再判一次 signal */
function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted === true) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** 单独成函数，免得 TypeScript 把第一次判空的结果窄化到第二次判断上 */
function aborted(signal?: AbortSignal): boolean {
  return signal?.aborted === true;
}

interface Resolved {
  timeoutMs: number;
  maxWaitMs: number;
  stallGraceMs: number;
  pollMs: number;
  now: () => number;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
}

function resolveOptions(o: WatchOptions): Resolved {
  return {
    timeoutMs: o.timeoutMs ?? WAIT_TIMEOUT_MS,
    maxWaitMs: o.maxWaitMs ?? DEFAULT_MAX_WAIT_MS,
    stallGraceMs: o.stallGraceMs ?? DEFAULT_STALL_GRACE_MS,
    pollMs: o.pollMs ?? DEFAULT_POLL_MS,
    now: o.now ?? (() => Date.now()),
    sleep: o.sleep ?? defaultSleep,
  };
}

/**
 * 只挂一个 watch：等一个**已经在跑**的 agent 落地。
 *
 * 分片等（每片 `timeoutMs`）而不是一次等满 `maxWaitMs`：`herdr agent wait` 的
 * timeout 是它自己的上限，一次开太长的超时会把「herdr 卡住」和「任务真的很久」
 * 混成同一件事。分片之后每片超时都去 `agent get` 问一次真实状态，
 * 既押得住长任务，也能在 agent 中途消失时及时收场。
 */
export async function watchUntilSettled(
  cli: HerdrCli,
  target: HerdrTarget,
  options: WatchOptions = {},
): Promise<Result<SettleReport>> {
  const o = resolveOptions(options);
  const startedAt = o.now();

  for (;;) {
    if (options.signal?.aborted === true) {
      return err("CANCELLED", `已取消对 ${target} 的等待`);
    }
    const remaining = o.maxWaitMs - (o.now() - startedAt);
    if (remaining <= 0) {
      const last = await getAgent(cli, target);
      return ok({
        status: last.ok ? last.data.status : "unknown",
        agent: last.ok ? last.data : undefined,
        timedOut: true,
        stalled: false,
        elapsedMs: o.now() - startedAt,
      });
    }

    const chunk = Math.min(o.timeoutMs, remaining);
    const r = await waitAgent(cli, target, {
      timeoutMs: chunk,
      signal: options.signal,
    });
    if (r.ok) {
      const agent = r.data;
      return ok({
        status: agent?.status ?? "idle",
        agent,
        timedOut: false,
        stalled: false,
        elapsedMs: o.now() - startedAt,
      });
    }
    if (r.error.code === "CANCELLED") return r;
    if (r.error.code === "NOT_FOUND") return r;
    if (r.error.code !== "TIMEOUT") return r;

    // 分片超时：先问一次真实状态，落地了就收工，否则继续下一片
    const probe = await getAgent(cli, target);
    if (!probe.ok) {
      if (probe.error.code === "NOT_FOUND") return probe;
      continue;
    }
    if (isSettled(probe.data.status)) {
      return ok({
        status: probe.data.status,
        agent: probe.data,
        timedOut: false,
        stalled: false,
        elapsedMs: o.now() - startedAt,
      });
    }
  }
}

/**
 * 派活 + 挂 watch 的完整序列 —— 这就是「发送消息 → 开始执行 → 添加 watch」那三步。
 *
 * 提交用 `agent prompt --wait`：herdr 会等到**观测到活动**之后再等落地，
 * 所以「任务快到两次轮询之间就跑完」不会让我们在 agent 还没开始时就把旧的
 * idle 当成结果。这一点用客户端轮询 `agent get` 是很难做对的。
 */
export async function promptAndWatch(
  cli: HerdrCli,
  target: HerdrTarget,
  text: string,
  options: WatchOptions = {},
): Promise<Result<SettleReport>> {
  const o = resolveOptions(options);
  const startedAt = o.now();
  const before = await getAgent(cli, target);
  const beforeSeq = before.ok ? before.data.stateChangeSeq : undefined;

  const prompted = await promptAgent(cli, target, text, {
    wait: true,
    timeoutMs: o.timeoutMs,
    signal: options.signal,
  });

  if (prompted.ok) {
    const agent = prompted.data ?? (before.ok ? before.data : undefined);
    return ok({
      status: agent?.status ?? "idle",
      agent,
      timedOut: false,
      stalled: false,
      elapsedMs: o.now() - startedAt,
    });
  }

  if (prompted.error.code === "CANCELLED" || prompted.error.code === "NOT_FOUND") {
    return prompted;
  }

  // 单次等待超时：agent 大概率还在跑，接着分片等到达总上限
  if (prompted.error.code === "TIMEOUT") {
    const remaining: WatchOptions = {
      ...options,
      maxWaitMs: Math.max(0, o.maxWaitMs - (o.now() - startedAt)),
    };
    const rest = await watchUntilSettled(cli, target, remaining);
    if (!rest.ok) return rest;
    return ok({ ...rest.data, elapsedMs: o.now() - startedAt });
  }

  // 活动门没过。herdr 说「这不能证明 prompt 没送到」—— 所以按轮询继续看，
  // 但如果状态序号一直不动，就别骗人说「完成」。
  if (prompted.error.code === "PROMPT_STALLED") {
    return pollForActivity(cli, target, beforeSeq, startedAt, options, o);
  }

  return prompted;
}

async function pollForActivity(
  cli: HerdrCli,
  target: HerdrTarget,
  beforeSeq: number | undefined,
  startedAt: number,
  options: WatchOptions,
  o: Resolved,
): Promise<Result<SettleReport>> {
  for (;;) {
    if (aborted(options.signal)) {
      return err("CANCELLED", `已取消对 ${target} 的等待`);
    }
    await o.sleep(o.pollMs, options.signal);
    if (aborted(options.signal)) {
      return err("CANCELLED", `已取消对 ${target} 的等待`);
    }
    const probe = await getAgent(cli, target);
    const elapsed = o.now() - startedAt;
    if (!probe.ok) {
      if (probe.error.code === "NOT_FOUND") return probe;
      continue;
    }
    const agent = probe.data;
    const moved = beforeSeq === undefined || agent.stateChangeSeq !== beforeSeq;
    if (isSettled(agent.status) && moved) {
      return ok({ status: agent.status, agent, timedOut: false, stalled: false, elapsedMs: elapsed });
    }
    if (agent.status === "working") {
      // 活动确实发生了，退回常规等待
      const rest = await watchUntilSettled(cli, target, {
        ...options,
        maxWaitMs: Math.max(0, o.maxWaitMs - elapsed),
      });
      if (!rest.ok) return rest;
      return ok({ ...rest.data, elapsedMs: o.now() - startedAt });
    }
    if (elapsed >= o.stallGraceMs) {
      return ok({
        status: agent.status,
        agent,
        timedOut: false,
        stalled: true,
        elapsedMs: elapsed,
      });
    }
  }
}
