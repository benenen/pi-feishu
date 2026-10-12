/**
 * herdr 这一侧的公共类型。**不依赖 pi，也不依赖飞书** ——
 * 飞书接入层（`feishu/herdr-*.ts`）和 pi 工具层（`herdr/index.ts`）都只是它的调用方。
 */

/** herdr 的 agent 状态机。`idle` 和 `done` 都表示「可以收下一句话」 */
export type AgentStatus = "idle" | "working" | "blocked" | "done" | "unknown";

/** 一个 agent 目标：herdr 接受「唯一的活动 agent 名」或「当前托管该 agent 的 pane id」 */
export type HerdrTarget = string;

/** herdr 的 agent 信息，已被 `normalizeAgent` 归一成 camelCase */
export interface HerdrAgent {
  /** agent 名。herdr 里同一时刻唯一，pane 里的占位者换人即失效 */
  name?: string;
  /** agent 种类（pi / claude / codex / …）。herdr 原始字段叫 `agent` */
  kind?: string;
  status: AgentStatus;
  paneId?: string;
  cwd?: string;
  workspaceId?: string;
  tabId?: string;
  /** 终端标题，通常就是 agent 正在做的任务 */
  title?: string;
  focused: boolean;
  /** 处于可交互的就绪态。`agent start` 返回时它是 true */
  interactiveReady?: boolean;
  /**
   * herdr 内部状态序号，每次状态变化 +1。「这一轮真的开始了没有」靠它判定 ——
   * 轮询看状态会被「还没开始就已经是 idle」骗到，序号不会。
   */
  stateChangeSeq?: number;
  /**
   * pi agent 的会话文件路径。herdr 只在 agent 自报身份时给得出（本机装了
   * `herdr-agent-state.ts` 就有）。有它就能直接抽最后一条 assistant 回复，
   * 不必去解析满是 TUI 边框的面板输出。
   */
  sessionPath?: string;
}

/**
 * 归一化的错误码。调用方按它分支，不去 match herdr 的原始中文报错。
 * 未列出的原始码一律落到 `VALIDATION_ERROR`，原始码保留在 `details.rawCode`。
 */
export type HerdrErrorCode =
  | "HERDR_UNAVAILABLE"
  | "TIMEOUT"
  | "CANCELLED"
  | "NOT_FOUND"
  | "PROMPT_STALLED"
  | "AGENT_BLOCKED"
  | "AGENT_START_FAILED"
  | "AGENT_NOT_READY"
  | "VALIDATION_ERROR";

export interface HerdrError {
  code: HerdrErrorCode;
  message: string;
  details?: unknown;
}

export type Result<T> = { ok: true; data: T } | { ok: false; error: HerdrError };

export function ok<T>(data: T): Result<T> {
  return { ok: true, data };
}

export function err(
  code: HerdrErrorCode,
  message: string,
  details?: unknown,
): Result<never> {
  return { ok: false, error: { code, message, details } };
}

/** `agent wait` / `agent prompt --wait` 的结算状态。idle/done/blocked 都算落地 */
export function isSettled(status: AgentStatus): boolean {
  return status === "idle" || status === "done" || status === "blocked";
}

function pickStr(o: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return undefined;
}

const STATUSES: readonly AgentStatus[] = ["idle", "working", "blocked", "done", "unknown"];

function asStatus(v: unknown): AgentStatus {
  return typeof v === "string" && (STATUSES as readonly string[]).includes(v)
    ? (v as AgentStatus)
    : "unknown";
}

/**
 * 把 herdr 的 snake_case agent 对象归一化。宽容两套大小写 ——
 * CLI 现在给的是 snake_case，但没必要把字段名写死成一个版本。
 */
export function normalizeAgent(raw: unknown): HerdrAgent {
  const o = (raw !== null && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const session = (o.agent_session ?? o.agentSession) as Record<string, unknown> | undefined;
  const kind = pickStr(o, "kind", "agent");
  const sessionValue = session ? pickStr(session, "value") : undefined;
  return {
    name: pickStr(o, "name"),
    kind,
    status: asStatus(o.agent_status ?? o.agentStatus),
    paneId: pickStr(o, "pane_id", "paneId"),
    cwd: pickStr(o, "cwd"),
    workspaceId: pickStr(o, "workspace_id", "workspaceId"),
    tabId: pickStr(o, "tab_id", "tabId"),
    title: pickStr(o, "terminal_title_stripped", "terminal_title", "title"),
    focused: o.focused === true,
    interactiveReady:
      typeof o.interactive_ready === "boolean" ? o.interactive_ready : undefined,
    stateChangeSeq:
      typeof o.state_change_seq === "number" ? o.state_change_seq : undefined,
    // 只有 pi 这类自带 session 文件路径的 agent 才有；会话 id（claude）抽不到正文
    sessionPath: session?.kind === "path" ? sessionValue : undefined,
  };
}

/** 逐个归一化一个 agent 数组结果，顺手丢掉认不出对象的条目 */
export function normalizeAgents(raw: unknown): HerdrAgent[] {
  const list = Array.isArray(raw) ? raw : [];
  return list
    .filter((x) => x !== null && typeof x === "object")
    .map((x) => normalizeAgent(x));
}

/** 从各种可能的信封里挖出 agent 数组（`{agents}` / `{snapshot:{agents}}`） */
export function extractAgents(data: unknown): HerdrAgent[] {
  if (Array.isArray(data)) return normalizeAgents(data);
  if (data !== null && typeof data === "object") {
    const o = data as Record<string, unknown>;
    if (Array.isArray(o.agents)) return normalizeAgents(o.agents);
    const snapshot = o.snapshot as Record<string, unknown> | undefined;
    if (snapshot && Array.isArray(snapshot.agents)) return normalizeAgents(snapshot.agents);
  }
  return [];
}

/** 从 `{agent}` / 裸 agent / `{pane}` 信封里挖出单个 agent */
export function extractAgent(data: unknown): HerdrAgent | undefined {
  if (data === null || typeof data !== "object") return undefined;
  const o = data as Record<string, unknown>;
  if (o.agent !== null && typeof o.agent === "object") return normalizeAgent(o.agent);
  if (pickStr(o, "pane_id", "paneId") !== undefined) return normalizeAgent(o);
  const pane = o.pane as Record<string, unknown> | undefined;
  if (pane !== null && typeof pane === "object") return normalizeAgent(pane);
  return undefined;
}

/** 从 `pane split` / `workspace create` 的返回里挖出 pane id */
export function extractPaneId(data: unknown): string | undefined {
  if (data === null || typeof data !== "object") return undefined;
  const o = data as Record<string, unknown>;
  for (const key of ["pane", "root_pane"]) {
    const v = o[key];
    if (v !== null && typeof v === "object") {
      const id = pickStr(v as Record<string, unknown>, "pane_id", "paneId", "id");
      if (id !== undefined) return id;
    }
  }
  return pickStr(o, "pane_id", "paneId");
}
