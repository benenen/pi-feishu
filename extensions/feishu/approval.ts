export interface ApprovalRequest {
  toolName: string;
  input: Record<string, unknown>;
}

export interface Decision {
  allow: boolean;
  reason: string;
  /**
   * "turn"：批准的同时豁免本 agent 回合内后续全部审批。
   * 只在 allow 为真时有意义；回合结束即失效，不跨回合、不跨会话。
   */
  scope?: "turn";
}

export type Asker = (req: ApprovalRequest, signal: AbortSignal) => Promise<Decision>;

export interface Timer {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
}

const realTimer: Timer = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
};

const CHANNEL_DOWN: Decision = { allow: false, reason: "审批通道不可用" };

/** 永不 settle 的 promise，用于把失败的通道从竞速里摘掉而不影响其他通道 */
function pending<T>(): Promise<T> {
  return new Promise<T>(() => {});
}

/**
 * 同时向所有审批通道发起询问，先返回者胜出，随后取消其余通道。
 * 任何异常路径都收敛到「拒绝」。
 */
export async function requestApproval(
  req: ApprovalRequest,
  askers: Asker[],
  timeoutMs: number,
  timer: Timer = realTimer,
): Promise<Decision> {
  if (askers.length === 0) return CHANNEL_DOWN;

  const controller = new AbortController();
  let failures = 0;
  let markAllFailed: ((d: Decision) => void) | undefined;
  const allFailed = new Promise<Decision>((resolve) => {
    markAllFailed = resolve;
  });

  const attempts = askers.map(async (ask): Promise<Decision> => {
    try {
      return await ask(req, controller.signal);
    } catch {
      failures += 1;
      if (failures === askers.length) markAllFailed?.(CHANNEL_DOWN);
      return pending<Decision>();
    }
  });

  let timeoutId: unknown;
  const timeout = new Promise<Decision>((resolve) => {
    timeoutId = timer.setTimeout(
      () => resolve({ allow: false, reason: `审批超时（${timeoutMs}ms）` }),
      timeoutMs,
    );
  });

  try {
    return await Promise.race([...attempts, allFailed, timeout]);
  } finally {
    controller.abort();
    timer.clearTimeout(timeoutId);
  }
}
