import { homedir } from "node:os";
import path from "node:path";
import {
  err,
  extractAgent,
  extractAgents,
  extractPaneId,
  isSettled,
  ok,
  type AgentStatus,
  type HerdrAgent,
  type HerdrTarget,
  type Result,
} from "./types.ts";
import type { HerdrCli } from "./cli.ts";

/** `agent start` 的就绪等待。herdr 自己也默认 30s，这里放宽到 90s 给冷启动的 pi/claude */
export const START_TIMEOUT_MS = 90_000;
/** 单次 `agent prompt --wait` / `agent wait` 的上限，超出由上层续等 */
export const WAIT_TIMEOUT_MS = 300_000;
const QUERY_TIMEOUT_MS = 15_000;

const KINDS_FALLBACK: readonly string[] = [
  "pi",
  "claude",
  "codex",
  "gemini",
  "cursor",
  "omp",
  "opencode",
  "copilot",
  "kimi",
  "amp",
  "grok",
  "qwen",
];

let kindsCache: string[] | null = null;

/** 解析 `herdr agent` 尾部那行 `kinds: a|b|c`。没有这行返回 null */
export function parseAgentKinds(text: string): string[] | null {
  const line = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .reverse()
    .find((l) => l.toLowerCase().startsWith("kinds:"));
  if (line === undefined) return null;
  const kinds = line
    .slice("kinds:".length)
    .split("|")
    .map((k) => k.trim().toLowerCase())
    .filter((k) => k !== "");
  return kinds.length > 0 ? kinds : null;
}

/** 本机 herdr 支持的 agent 种类。活取一次后缓存，取不到退回内置表 */
export async function listAgentKinds(cli: HerdrCli): Promise<string[]> {
  if (kindsCache !== null) return kindsCache;
  const r = await cli.run<string>(["agent"], { textOk: true, timeoutMs: QUERY_TIMEOUT_MS });
  const parsed = r.ok && typeof r.data === "string" ? parseAgentKinds(r.data) : null;
  kindsCache = parsed ?? [...KINDS_FALLBACK];
  return kindsCache;
}

/** 测试用：清掉种类缓存 */
export function resetAgentKindsCache(): void {
  kindsCache = null;
}

export async function listAgents(cli: HerdrCli): Promise<Result<HerdrAgent[]>> {
  const r = await cli.run<unknown>(["agent", "list"], { timeoutMs: QUERY_TIMEOUT_MS });
  if (!r.ok) return r;
  return ok(extractAgents(r.data));
}

export async function getAgent(
  cli: HerdrCli,
  target: HerdrTarget,
): Promise<Result<HerdrAgent>> {
  const r = await cli.run<unknown>(["agent", "get", target], { timeoutMs: QUERY_TIMEOUT_MS });
  if (!r.ok) return r;
  const agent = extractAgent(r.data);
  if (agent === undefined) {
    return err("NOT_FOUND", `herdr 里找不到 agent ${target}`);
  }
  return ok(agent);
}

export interface ReadOptions {
  lines?: number;
  source?: "visible" | "recent" | "recent-unwrapped" | "detection";
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** 读面板输出。herdr 这里吐的是**纯文本**，所以走 textOk */
export async function readAgent(
  cli: HerdrCli,
  target: HerdrTarget,
  options: ReadOptions = {},
): Promise<Result<string>> {
  const args = [
    "agent",
    "read",
    target,
    "--source",
    options.source ?? "recent-unwrapped",
    "--lines",
    String(options.lines ?? 120),
    "--format",
    "text",
  ];
  return cli.run<string>(args, {
    textOk: true,
    timeoutMs: options.timeoutMs ?? QUERY_TIMEOUT_MS,
    signal: options.signal,
  });
}

export interface PromptOptions {
  /** 等待结算。给了就带 `--wait --until idle/done/blocked` */
  wait?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * 送一句话给 agent。
 *
 * `wait: true` 时用 `agent prompt --wait --until idle --until done --until blocked`：
 * herdr 自己保证「从非工作态发出的 prompt 必须观测到 working/blocked 活动」，
 * 这正是快速任务「还没来得及看到 working 就已经又是 idle」那条竞态的解法，
 * 比在客户端轮询状态靠谱。超时返回 TIMEOUT 错误，agent 仍在跑。
 */
export async function promptAgent(
  cli: HerdrCli,
  target: HerdrTarget,
  text: string,
  options: PromptOptions = {},
): Promise<Result<HerdrAgent | undefined>> {
  const args = ["agent", "prompt", target, text];
  if (options.wait === true) {
    args.push("--wait");
    for (const s of ["idle", "done", "blocked"] as const) args.push("--until", s);
    args.push("--timeout", String(options.timeoutMs ?? WAIT_TIMEOUT_MS));
  }
  const r = await cli.run<unknown>(args, {
    timeoutMs: (options.timeoutMs ?? WAIT_TIMEOUT_MS) + 20_000,
    signal: options.signal,
  });
  if (!r.ok) return r;
  return ok(extractAgent(r.data));
}

/**
 * 等一个 agent 落地（idle / done / blocked）。
 *
 * herdr 的 `agent wait` 在已经是落地态时会**立刻返回**，所以这里只用于
 * 「本来就是别人跑的任务，我只加一个 watch」；送任务自己走 `promptAgent`。
 */
export async function waitAgent(
  cli: HerdrCli,
  target: HerdrTarget,
  options: { until?: AgentStatus[]; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<Result<HerdrAgent | undefined>> {
  const until = options.until ?? ["idle", "done", "blocked"];
  const timeoutMs = options.timeoutMs ?? WAIT_TIMEOUT_MS;
  const args = ["agent", "wait", target];
  for (const s of until) args.push("--until", s);
  args.push("--timeout", String(timeoutMs));
  const r = await cli.run<unknown>(args, { timeoutMs: timeoutMs + 20_000, signal: options.signal });
  if (!r.ok) return r;
  return ok(extractAgent(r.data));
}

/** 往 agent 送逻辑按键（ctrl+c / esc / enter…）。herdr 会先整体校验再写 */
export async function sendKeys(
  cli: HerdrCli,
  target: HerdrTarget,
  keys: string[],
): Promise<Result<void>> {
  if (keys.length === 0) return err("VALIDATION_ERROR", "至少要给一个按键");
  const r = await cli.run<unknown>(["agent", "send-keys", target, ...keys], {
    timeoutMs: QUERY_TIMEOUT_MS,
  });
  return r.ok ? ok(undefined) : r;
}

/** 关掉 agent 所在的 pane —— 这是 herdr 里唯一能真正终止一个 agent 的操作 */
export async function stopAgent(
  cli: HerdrCli,
  target: HerdrTarget,
): Promise<Result<string>> {
  const agent = await getAgent(cli, target);
  if (!agent.ok) return agent;
  const paneId = agent.data.paneId;
  if (paneId === undefined) {
    return err("VALIDATION_ERROR", `agent ${target} 没有可关闭的 pane`);
  }
  const r = await cli.run<unknown>(["pane", "close", paneId], { timeoutMs: QUERY_TIMEOUT_MS });
  return r.ok ? ok(paneId) : r;
}

export interface StartAgentSpec {
  /** 唯一名。herdr 要求匹配 `[a-z][a-z0-9_-]{0,31}` */
  name: string;
  /** agent 种类，默认 pi */
  kind?: string;
  cwd?: string;
  /** 在已有 herdr pane 里开新 pane（`HERDR_ENV=1` 时）用哪个方向；默认 right */
  direction?: "right" | "down";
  /** 新 pane 是否抢焦点。默认不抢 —— 后台干活不该打搅人 */
  focus?: boolean;
  /** 追加在 agent CLI 后面的原生参数（`agent start … -- <args>`） */
  agentArgs?: string[];
  env?: Record<string, string>;
  timeoutMs?: number;
  signal?: AbortSignal;
  /**
   * 本进程是不是跑在 herdr pane 里。默认看 `HERDR_ENV` / `HERDR_PANE_ID`，
   * 测试里直接给值，免得去改进程环境。
   */
  insideHerdr?: boolean;
}

/**
 * 起一个新 agent。
 *
 * 两套路子，取决于**本进程自己是不是跑在 herdr pane 里**：
 *   - 在（`HERDR_ENV=1` + `HERDR_PANE_ID`）：往旁边 split 一个兄弟 pane，跟人当前的
 *     工作面板同处一个 tab —— 这是 herdr 的常规用法，也方便人切过去看
 *   - 不在：开一个**新 workspace**，用它的 root pane。绝不动别人的焦点 pane ——
 *     没有 `HERDR_PANE_ID` 时 `pane split --current` 会落到 UI 当前焦点上，
 *     等于把新 pane 塞进用户正在看的布局里
 */
export async function startAgent(
  cli: HerdrCli,
  spec: StartAgentSpec,
): Promise<Result<HerdrAgent>> {
  const kind = (spec.kind ?? "pi").toLowerCase();
  const kinds = await listAgentKinds(cli);
  if (!kinds.includes(kind)) {
    return err(
      "VALIDATION_ERROR",
      `不认识的 agent 类型「${spec.kind ?? ""}」。本机 herdr 支持：${kinds.join(", ")}`,
      { kind, kinds },
    );
  }
  if (!/^[a-z][a-z0-9_-]{0,31}$/.test(spec.name)) {
    return err(
      "VALIDATION_ERROR",
      `agent 名「${spec.name}」不合法：必须匹配 [a-z][a-z0-9_-]{0,31}`,
    );
  }

  const pane = await createPane(cli, spec);
  if (!pane.ok) return pane;

  const args = ["agent", "start", spec.name, "--kind", kind, "--pane", pane.data];
  if (spec.agentArgs !== undefined && spec.agentArgs.length > 0) {
    args.push("--", ...spec.agentArgs);
  }
  const started = await cli.run<unknown>(args, {
    timeoutMs: spec.timeoutMs ?? START_TIMEOUT_MS,
    signal: spec.signal,
  });
  if (!started.ok) return started;
  const agent = extractAgent(started.data);
  if (agent === undefined) {
    return err("AGENT_START_FAILED", `agent start 没返回 agent 信息（pane ${pane.data}）`);
  }
  return ok(agent);
}

async function createPane(cli: HerdrCli, spec: StartAgentSpec): Promise<Result<string>> {
  // shell:false 不会展开 ~；始终显式给目录，避免 pane/workspace 偷偷继承当前仓库。
  const requested = spec.cwd === undefined || spec.cwd.trim() === "" ? homedir() : spec.cwd;
  const cwd = path.resolve(requested === "~" ? homedir() : requested.startsWith("~/") ? path.join(homedir(), requested.slice(2)) : requested);
  const insideHerdr =
    spec.insideHerdr ??
    ((process.env.HERDR_ENV ?? "") === "1" && (process.env.HERDR_PANE_ID ?? "") !== "");
  const base: string[] = [];
  if (spec.env !== undefined) {
    for (const [k, v] of Object.entries(spec.env)) base.push("--env", `${k}=${v}`);
  }
  const args = insideHerdr
    ? [
        "pane",
        "split",
        "--current",
        "--direction",
        spec.direction ?? "right",
        "--cwd", cwd,
        ...base,
        spec.focus === true ? "--focus" : "--no-focus",
      ]
    : [
        "workspace",
        "create",
        "--label",
        spec.name,
        "--cwd", cwd,
        ...base,
        spec.focus === true ? "--focus" : "--no-focus",
      ];
  const r = await cli.run<unknown>(args, { timeoutMs: 30_000, signal: spec.signal });
  if (!r.ok) return r;
  const paneId = extractPaneId(r.data);
  if (paneId === undefined) {
    return err("VALIDATION_ERROR", "herdr 没有返回新 pane 的 id", r.data);
  }
  return ok(paneId);
}

/** `herdr --version`，用于状态展示。拿不到就返回 undefined，不让状态查询失败 */
export async function probeVersion(cli: HerdrCli): Promise<string | undefined> {
  const r = await cli.run<string>(["--version"], { textOk: true, timeoutMs: 5_000 });
  return r.ok ? r.data.trim() : undefined;
}

/** 落地状态的可读说法。`blocked` 需要人去处理，别的都算「可继续」 */
export function describeStatus(status: AgentStatus): string {
  if (status === "working") return "运行中";
  if (status === "blocked") return "等待输入";
  if (status === "done") return "已完成";
  if (status === "idle") return "空闲";
  return "状态未知";
}

export { isSettled };
