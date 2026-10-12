import type { SendTarget } from "./types.ts";
import type { LogFn } from "./log.ts";
import type { BackgroundResult } from "./background-summary.ts";

/** 与 pi 的工具结果结构兼容；提取文本或结构化正文作为总结资料。 */
export interface ToolResult {
  content: { type: string; text?: string; [key: string]: unknown }[];
  details: unknown;
  structuredContent?: unknown;
  isError?: boolean;
}
export interface RunInput {
  id: string;
  name: string;
  to: SendTarget;
  question?: string;
  threadId?: string;
  signal?: AbortSignal;
  execute: (signal: AbortSignal, onUpdate?: (result: ToolResult) => void) => Promise<ToolResult>;
  onUpdate?: (result: ToolResult) => void;
}
interface Record {
  input: RunInput;
  controller: AbortController;
  detached: boolean;
  startedAt: number;
  handingOff: boolean;
}
export interface BackgroundTaskSummary {
  id: string;
  name: string;
  question?: string;
  elapsedMs: number;
  phase: "background" | "handoff";
}
type Outcome = { ok: true; result: ToolResult } | { ok: false; error: unknown };

/** 一个工具一个独立 watcher。等待期限结束只释放调用方，不取消实际执行。 */
export class BackgroundTools {
  readonly #waitMs: number;
  readonly #onComplete: (result: BackgroundResult) => Promise<void>;
  readonly #log: LogFn;
  readonly #now: () => number;
  readonly #onChange: (() => void) | undefined;
  readonly #jobs = new Map<string, Record>();
  readonly #pending = new Set<Promise<void>>();
  #closed = false;

  constructor(options: { waitMs: number; onComplete: (result: BackgroundResult) => Promise<void>; log: LogFn; now?: () => number; onChange?: () => void }) {
    this.#waitMs = options.waitMs;
    this.#onComplete = options.onComplete;
    this.#log = options.log;
    this.#now = options.now ?? Date.now;
    this.#onChange = options.onChange;
  }

  get count(): number { return this.#jobs.size; }

  /** 只返回已脱离主回合的任务，不把同步等待中的短工具显示成 background。 */
  watching(): BackgroundTaskSummary[] {
    const now = this.#now();
    return [...this.#jobs.values()].filter((record) => record.detached).map((record) => ({
      id: record.input.id, name: record.input.name, question: record.input.question,
      elapsedMs: now - record.startedAt, phase: record.handingOff ? "handoff" : "background",
    }));
  }

  #changed(): void {
    try { this.#onChange?.(); }
    catch (error) { this.#log(`更新后台工具状态失败：${String(error)}`, "warning"); }
  }

  /** 子工具沿用父任务来源；父任务仍在后台运行时，来源快照不会随新回合变更。 */
  targetOf(id: string): SendTarget | undefined {
    const exact = this.#jobs.get(id);
    if (exact) return { ...exact.input.to };
    for (const [root, record] of this.#jobs) {
      if (id.startsWith(`${root}/`)) return { ...record.input.to };
    }
    return undefined;
  }

  async run(input: RunInput): Promise<ToolResult> {
    if (this.#closed || input.signal?.aborted) throw new Error("后台工具服务已停止或调用已取消");
    if (this.#jobs.size >= 16) throw new Error("后台工具任务已达上限（16），请先等待已有任务完成");
    if (this.#jobs.has(input.id)) throw new Error(`工具调用 ${input.id} 已在运行，请勿重复执行`);
    const record: Record = { input: { ...input, to: { ...input.to } }, controller: new AbortController(), detached: false, startedAt: this.#now(), handingOff: false };
    this.#jobs.set(input.id, record);
    const controller = record.controller;
    const abortParent = () => controller.abort();
    input.signal?.addEventListener("abort", abortParent, { once: true });
    const outcome: Promise<Outcome> = Promise.resolve().then(() => {
      if (controller.signal.aborted) throw new Error("工具调用已取消");
      return input.execute(controller.signal, (partial) => {
        if (!record.detached && !controller.signal.aborted) input.onUpdate?.(partial);
      });
    }).then((result) => ({ ok: true, result }), (error: unknown) => ({ ok: false, error }));
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abortWait: () => void = () => {};
    const detached = new Promise<"detach">((resolve) => {
      timer = setTimeout(() => resolve("detach"), this.#waitMs);
    });
    const aborted = new Promise<"abort">((resolve) => {
      abortWait = () => resolve("abort");
      controller.signal.addEventListener("abort", abortWait, { once: true });
    });
    const first = await Promise.race([outcome, detached, aborted]);
    clearTimeout(timer);
    controller.signal.removeEventListener("abort", abortWait);
    input.signal?.removeEventListener("abort", abortParent);
    if (first === "abort") {
      this.#jobs.delete(input.id);
      this.#changed();
      throw new Error("工具调用已取消");
    }
    if (first !== "detach") {
      this.#jobs.delete(input.id);
      this.#changed();
      if (!first.ok) throw first.error;
      return first.result;
    }
    // 超出同步等待期限：新回合的 abort 不能再取消这个独立任务。
    record.detached = true;
    this.#changed();
    const watcher = this.#finish(record, outcome);
    this.#pending.add(watcher);
    void watcher.then(() => this.#pending.delete(watcher));
    return {
      content: [{ type: "text", text: `工具 ${input.name} 尚在运行，已交给后台 watcher（${input.id}）。当前回合可继续处理后续请求；完成后会另开回合总结并发回原飞书会话。不要重复执行或轮询这次调用；依赖它结果的步骤请等结果后再继续。向用户说明等待状态时不要展示内部调用 ID。` }],
      details: { background: true, taskId: input.id, toolName: input.name },
    };
  }

  /** 关闭只发出取消信号，不等待不配合 abort 的第三方工具；晚到结果也会被抑制。 */
  shutdown(): void {
    this.#closed = true;
    for (const record of this.#jobs.values()) record.controller.abort();
    this.#jobs.clear();
    this.#changed();
  }

  async drain(): Promise<void> {
    while (this.#pending.size > 0) await Promise.all([...this.#pending]);
  }

  async #finish(record: Record, outcome: Promise<Outcome>): Promise<void> {
    try {
      const done = await outcome;
      if (record.controller.signal.aborted || this.#jobs.get(record.input.id) !== record) return;
      record.handingOff = true;
      this.#changed();
      let text = done.ok
        ? (done.result.content ?? []).filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n")
        : String(done.error);
      if (done.ok && text === "" && done.result.structuredContent !== undefined) {
        text = JSON.stringify(done.result.structuredContent, null, 2) ?? "";
      }
      const failed = !done.ok || done.result.isError === true;
      await this.#onComplete({ id: record.input.id, name: record.input.name, to: { ...record.input.to },
        question: record.input.question, threadId: record.input.threadId, body: text || "工具没有返回文本正文。", failed });
    } catch (error) {
      this.#log(`后台工具结果投递总结失败：${String(error)}`, "warning");
    } finally {
      if (this.#jobs.get(record.input.id) === record) {
        this.#jobs.delete(record.input.id);
        this.#changed();
      }
    }
  }
}

export const TOOL_EXECUTION_HOOK = Symbol.for("pi-feishu:tool-execution");
export const TOOL_HOOK_LOADED = Symbol.for("pi-feishu:tool-hook-loaded");
interface CallableTool {
  name: string;
  execute: (id: string, args: unknown, signal?: AbortSignal, onUpdate?: (result: ToolResult) => void) => Promise<ToolResult>;
}
const hooks = globalThis as unknown as { [key: symbol]: unknown };

export function hasBackgroundToolPatch(): boolean { return hooks[TOOL_HOOK_LOADED] === true; }

/** pi 核心在参数校验与所有 tool_call 审批通过后才调用这个钩子。 */
export function installBackgroundToolHook(
  service: BackgroundTools,
  target: (toolCallId: string) => SendTarget | undefined,
  context?: (toolCallId: string) => { question?: string; threadId?: string } | undefined,
): () => void {
  if (hooks[TOOL_EXECUTION_HOOK] !== undefined) throw new Error("已有另一个后台工具钩子，拒绝覆盖");
  const hook = (tool: CallableTool, id: string, args: unknown, signal?: AbortSignal, onUpdate?: (result: ToolResult) => void) => {
    // 子工具的结果由父工具消费，不能把它替换成登记回执；整个父任务已经独立运行。
    if (service.targetOf(id)) return tool.execute(id, args, signal, onUpdate);
    const to = target(id);
    if (!to) return tool.execute(id, args, signal, onUpdate);
    return service.run({ id, name: tool.name, to, ...context?.(id), signal, onUpdate, execute: (workSignal, update) => tool.execute(id, args, workSignal, update) });
  };
  hooks[TOOL_EXECUTION_HOOK] = hook;
  return () => {
    if (hooks[TOOL_EXECUTION_HOOK] === hook) delete hooks[TOOL_EXECUTION_HOOK];
    service.shutdown();
  };
}
