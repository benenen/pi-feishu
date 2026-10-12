import type { BackgroundTaskSummary } from "./background-tools.ts";
import type { WatchSummary } from "./herdr-service.ts";

export const TASK_STATUS_KEY = "pi-feishu-background";
export interface TaskSnapshot {
  tools: BackgroundTaskSummary[];
  herdr: WatchSummary[];
}
interface StatusUI {
  setStatus(key: string, value: string | undefined): void;
  setWidget(key: string, lines: string[] | undefined, options?: { placement: "belowEditor" }): void;
}

/** 任务正文属于不可信输入，清除 ANSI / 控制字符并压成一行，避免污染 TUI。 */
function label(text: string, limit = 48): string {
  const clean = text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/[\x00-\x1f\x7f-\x9f]/g, " ").replace(/\s+/g, " ").trim();
  const points = Array.from(clean);
  return points.length > limit ? `${points.slice(0, limit - 1).join("")}…` : clean;
}
function duration(ms: number): string {
  const seconds = Math.floor(Math.max(0, ms) / 1000);
  if (seconds < 60) return `${seconds}秒`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}分${seconds % 60}秒`;
  return `${Math.floor(seconds / 3600)}时${Math.floor((seconds % 3600) / 60)}分`;
}
function compact(names: string[]): string {
  return `${names.slice(0, 3).map((name) => label(name, 18)).join(", ")}${names.length > 3 ? `, +${names.length - 3}` : ""}`;
}

/** footer 只放短列表；完整列表经 belowEditor widget 显示，兼容其他扩展的 footer。 */
export function renderBackgroundStatus(snapshot: TaskSnapshot): { status?: string; lines?: string[] } {
  const background = [
    ...snapshot.tools.filter((task) => task.phase === "background").map((task) => ({ name: task.name, task: task.question, elapsed: task.elapsedMs })),
    ...snapshot.herdr.map((watch) => ({ name: `herdr/${watch.agent}`, task: watch.task, elapsed: watch.startedAgoMs })),
  ];
  const watchers = [
    ...snapshot.tools.map((task) => ({ name: task.name, state: task.phase === "handoff" ? "提交总结" : "等待工具完成", elapsed: task.elapsedMs })),
    ...snapshot.herdr.map((watch) => ({ name: `herdr/${watch.agent}`, state: "等待 agent 落地", elapsed: watch.startedAgoMs })),
  ];
  if (background.length === 0 && watchers.length === 0) return {};
  const lines = [`Background（${background.length}）`,
    ...background.map((task) => `  • ${label(task.name, 24)} · ${duration(task.elapsed)}${task.task ? ` · ${label(task.task)}` : ""}`),
    `Watcher（${watchers.length}）`,
    ...watchers.map((watch) => `  • ${label(watch.name, 24)} · ${watch.state} · ${duration(watch.elapsed)}`),
  ];
  return { status: `background ${background.length} [${compact(background.map((task) => task.name))}] · watcher ${watchers.length} [${compact(watchers.map((watch) => watch.name))}]`, lines };
}

function scheduleRefresh(refresh: () => void): () => void {
  const timer = setInterval(refresh, 1000);
  timer.unref();
  return () => clearInterval(timer);
}

/** 构造只保存依赖；有任务且有 TUI 时才启动刷新，清空或 dispose 时停止。 */
export class BackgroundTaskStatus {
  readonly #getUI: () => StatusUI | undefined;
  readonly #read: () => TaskSnapshot;
  readonly #schedule: (refresh: () => void) => () => void;
  #cancel: (() => void) | undefined;
  #closed = false;

  constructor(options: { getUI: () => StatusUI | undefined; read: () => TaskSnapshot; schedule?: (refresh: () => void) => () => void }) {
    this.#getUI = options.getUI;
    this.#read = options.read;
    this.#schedule = options.schedule ?? scheduleRefresh;
  }

  refresh(): void {
    if (this.#closed) return;
    try {
      const rendered = renderBackgroundStatus(this.#read());
      const ui = this.#getUI();
      ui?.setStatus(TASK_STATUS_KEY, rendered.status);
      ui?.setWidget(TASK_STATUS_KEY, rendered.lines, { placement: "belowEditor" });
      if (ui && rendered.status !== undefined) {
        this.#cancel ??= this.#schedule(() => this.refresh());
      } else this.#stopTimer();
    } catch {
      // 与 logger 一样，runner 失效后的 getter/后台回调不能抛进工具执行链路。
      this.#stopTimer();
    }
  }

  #stopTimer(): void {
    this.#cancel?.();
    this.#cancel = undefined;
  }

  dispose(): void {
    this.#closed = true;
    this.#stopTimer();
    try {
      const ui = this.#getUI();
      ui?.setStatus(TASK_STATUS_KEY, undefined);
      ui?.setWidget(TASK_STATUS_KEY, undefined, { placement: "belowEditor" });
    } catch { /* runner 已失效时不写终端，也不抛错 */ }
  }
}
