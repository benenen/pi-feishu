export interface WatchdogTimers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

const DEFAULT_TIMERS: WatchdogTimers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * 管理 fire-and-forget 投递从 send 到 before_agent_start 之间的止损定时器。
 * token 校验挡住已经进事件队列、但随后被 clear 的迟到 callback。
 */
export class DispatchWatchdog {
  #entries = new Map<string, { handle: unknown; token: object }>();
  readonly #timeoutMs: number;
  readonly #timers: WatchdogTimers;

  constructor(timeoutMs: number, timers: WatchdogTimers = DEFAULT_TIMERS) {
    this.#timeoutMs = timeoutMs;
    this.#timers = timers;
  }

  get size(): number {
    return this.#entries.size;
  }

  arm(messageId: string, onTimeout: () => void): void {
    this.clear(messageId);
    const token = {};
    const handle = this.#timers.set(() => {
      if (this.#entries.get(messageId)?.token !== token) return;
      this.#entries.delete(messageId);
      onTimeout();
    }, this.#timeoutMs);
    this.#entries.set(messageId, { handle, token });
  }

  clear(messageId: string | undefined): void {
    if (messageId === undefined) return;
    const entry = this.#entries.get(messageId);
    if (entry === undefined) return;
    this.#entries.delete(messageId);
    this.#timers.clear(entry.handle);
  }

  clearAll(): void {
    for (const entry of this.#entries.values()) this.#timers.clear(entry.handle);
    this.#entries.clear();
  }
}
