import { createHerdrCli, defaultSpawn, resolveHerdrBin, type HerdrCli } from "../herdr/cli.ts";
import {
  describeStatus,
  getAgent,
  listAgents as listAgentsOp,
  promptAgent,
  sendKeys,
  startAgent,
  stopAgent,
} from "../herdr/agents.ts";
import { harvestResult } from "../herdr/harvest.ts";
import { promptAndWatch, watchUntilSettled } from "../herdr/watch.ts";
import { err, ok, type HerdrAgent, type Result } from "../herdr/types.ts";
import type { LogFn } from "./log.ts";
import type { SendTarget } from "./types.ts";
import type { BackgroundResult } from "./background-summary.ts";
import { renderDispatchAck, renderHerdrError, renderResult } from "./herdr-commands.ts";

/**
 * herdr 派活服务：把「选 agent → 派活 → 挂 watch → 把结果发回飞书」串起来。
 *
 * 它是**飞书侧唯一的 herdr 状态持有者**：
 *   - 每个对话选中的默认 agent
 *   - 每个正在挂着的 watch（含各自的取消控制器）
 *
 * 一个 watch 一个后台 Promise。这正是并行的地方 —— 不同 agent 上的任务互不
 * 排队；同一个 agent 上再派活会被拒（它是一块终端面板，两句话会在里面打架）。
 *
 * 依赖全部注入（cli / send / now / newId），所以整个流程能离线测：
 * 假 cli 演 herdr，假 send 收结果。
 */

export interface Dispatched {
  watchId: string;
  agent: string;
}

export interface WatchSummary {
  id: string;
  agent: string;
  task: string;
  startedAgoMs: number;
}

interface WatchRecord {
  id: string;
  chatId: string;
  /** herdr 目标（agent 名或 pane id） */
  agent: string;
  task: string;
  to: SendTarget;
  threadId?: string;
  startedAt: number;
  controller: AbortController;
}

export interface HerdrServiceOptions {
  cli?: HerdrCli;
  /** 把一段 markdown 发回飞书某个对话 */
  send: (markdown: string, to: SendTarget) => Promise<void>;
  /** 生产接线将完成结果排给 pi 总结；未提供时保留独立客户端的正文回传能力。 */
  onComplete?: (result: BackgroundResult) => Promise<void>;
  onChange?: () => void;
  log: LogFn;
  /** 单次 `agent prompt --wait` / `agent wait` 的上限 */
  timeoutMs?: number;
  /** 一个 watch 总共愿意等多久 */
  maxWaitMs?: number;
  /** stalled 后的轮询间隔（测试用来把时间压掉） */
  pollMs?: number;
  /** 配了 herdrDefaultAgent 时，未选过的对话默认派给它 */
  defaultAgent?: string;
  now?: () => number;
  newId?: () => string;
  /** 同时挂多少个 watch 的上限，防呆 */
  maxWatches?: number;
}

const DEFAULT_MAX_WATCHES = 16;

export interface DispatchInput {
  chatId: string;
  to: SendTarget;
  task: string;
  threadId?: string;
  /** 直接指定派给谁（agent 名 / pane id）。与 agentKind 互斥，给了它就不改默认选择 */
  target?: string;
  /** 先新开一个这个类型的 agent 再派活 */
  agentKind?: string;
}

export class HerdrService {
  readonly #cli: HerdrCli;
  readonly #send: (markdown: string, to: SendTarget) => Promise<void>;
  readonly #onComplete: ((result: BackgroundResult) => Promise<void>) | undefined;
  readonly #onChange: (() => void) | undefined;
  readonly #log: LogFn;
  readonly #timeoutMs: number | undefined;
  readonly #maxWaitMs: number | undefined;
  readonly #pollMs: number | undefined;
  readonly #defaultAgent: string | undefined;
  readonly #now: () => number;
  readonly #newId: () => string;
  readonly #maxWatches: number;

  /** chatId → 选中的 herdr 目标（agent 名或 pane id） */
  #selected = new Map<string, string>();
  /** watchId → 正在挂着的 watch */
  #watches = new Map<string, WatchRecord>();
  /** 后台跑着的 watch Promise。`drain()` 和测试等它 */
  #pending = new Set<Promise<void>>();

  constructor(options: HerdrServiceOptions) {
    this.#cli =
      options.cli ??
      createHerdrCli({ bin: resolveHerdrBin(process.env), spawn: defaultSpawn, env: process.env });
    this.#send = options.send;
    this.#onComplete = options.onComplete;
    this.#onChange = options.onChange;
    this.#log = options.log;
    this.#timeoutMs = options.timeoutMs;
    this.#maxWaitMs = options.maxWaitMs;
    this.#pollMs = options.pollMs;
    this.#defaultAgent = options.defaultAgent;
    this.#now = options.now ?? (() => Date.now());
    this.#newId = options.newId ?? (() => Math.random().toString(36).slice(2, 10));
    this.#maxWatches = options.maxWatches ?? DEFAULT_MAX_WATCHES;
  }

  get watchCount(): number {
    return this.#watches.size;
  }

  selected(chatId: string): string | undefined {
    return this.#selected.get(chatId) ?? this.#defaultAgent;
  }

  select(chatId: string, target: string): void {
    this.#selected.set(chatId, target);
  }

  async listAgents(): Promise<Result<HerdrAgent[]>> {
    return listAgentsOp(this.#cli);
  }

  /** 这个对话正在等哪些任务 */
  watching(chatId?: string): WatchSummary[] {
    const now = this.#now();
    return [...this.#watches.values()]
      .filter((w) => chatId === undefined || w.chatId === chatId)
      .map((w) => ({
        id: w.id,
        agent: w.agent,
        task: w.task,
        startedAgoMs: now - w.startedAt,
      }));
  }

  #changed(): void {
    try { this.#onChange?.(); }
    catch (error) { this.#log(`更新 herdr watcher 状态失败：${String(error)}`, "warning"); }
  }

  /**
   * 派活并挂 watch。**返回后立刻可接收下一条** —— watch 在后台跑，
   * 结果出来时再发回 `to`。
   */
  async dispatch(input: DispatchInput): Promise<Result<Dispatched>> {
    if (this.#watches.size >= this.#maxWatches) {
      return err("VALIDATION_ERROR", `同时挂着的任务太多了（上限 ${this.#maxWatches}），先等几个完成`);
    }

    let agent: string;
    if (input.agentKind !== undefined) {
      const started = await this.#startNew(input.agentKind);
      if (!started.ok) return started;
      agent = started.data;
    } else {
      let chosen = input.target ?? this.selected(input.chatId);
      if (chosen === undefined) {
        const available = await this.#chooseExisting(input.task);
        if (!available.ok) return available;
        chosen = available.data;
      }
      agent = chosen;
    }

    const busy = [...this.#watches.values()].find((w) => w.agent === agent);
    if (busy !== undefined) {
      return err(
        "VALIDATION_ERROR",
        `${agent} 上已经在等一个任务了（\`${busy.id}\`）。等它完成，或换一个 agent`,
      );
    }

    // 别人正在这个 agent 上干活时不要插话 —— 两句话会在同一个面板里交错
    const probe = await getAgent(this.#cli, agent);
    if (!probe.ok) return probe;
    if (probe.data.status === "working") {
      return err("VALIDATION_ERROR", `${agent} 现在正忙（${describeStatus(probe.data.status)}），等它空下来再派`);
    }

    const record = this.#register(input.chatId, agent, input.task, input.to, input.threadId);
    await this.#notify(renderDispatchAck({ agent, task: input.task, watchId: record.id }), input.to);
    this.#spawnRun(record, input.task);
    return ok({ watchId: record.id, agent });
  }

  /** 给一个已经在跑的 agent 补一个 watch（不发言，只等结果） */
  async watchExisting(input: { chatId: string; to: SendTarget; target: string; threadId?: string }): Promise<Result<Dispatched>> {
    const busy = [...this.#watches.values()].find((w) => w.agent === input.target);
    if (busy !== undefined) {
      return err("VALIDATION_ERROR", `${input.target} 上已经挂着 watch \`${busy.id}\` 了`);
    }
    if (this.#watches.size >= this.#maxWatches) {
      return err("VALIDATION_ERROR", `同时挂着的任务太多了（上限 ${this.#maxWatches}）`);
    }
    const probe = await getAgent(this.#cli, input.target);
    if (!probe.ok) return probe;

    const record = this.#register(input.chatId, input.target, "（已在跑，只补 watch）", input.to, input.threadId);
    await this.#notify(
      `已给 **${input.target}** 挂上 watch（\`${record.id}\`），它落地后我把结果发这里。`,
      input.to,
    );
    this.#spawnRun(record, undefined);
    return ok({ watchId: record.id, agent: input.target });
  }

  /** 停止等待一个任务。不打断 agent —— 它还在 herdr 里继续跑 */
  cancel(chatId: string, watchId: string): boolean {
    const record = this.#watches.get(watchId);
    if (record === undefined || record.chatId !== chatId) return false;
    this.#watches.delete(watchId);
    this.#changed();
    record.controller.abort();
    return true;
  }

  /** 桥接停止时调用：取消全部 watch，杀掉在等的 herdr 子进程，再等它们收尾 */
  async shutdown(): Promise<void> {
    for (const record of this.#watches.values()) record.controller.abort();
    this.#watches.clear();
    this.#changed();
    await this.drain();
  }

  /** 等所有后台 watch 收尾。测试与 `shutdown` 用 */
  async drain(): Promise<void> {
    while (this.#pending.size > 0) {
      await Promise.all([...this.#pending]);
    }
  }

  async read(target: string): Promise<Result<string>> {
    const agent = await getAgent(this.#cli, target);
    if (!agent.ok) return agent;
    const r = await harvestResult(this.#cli, target, agent.data);
    return r.ok ? ok(r.data.text) : r;
  }

  async stop(target: string): Promise<Result<string>> {
    return stopAgent(this.#cli, target);
  }

  /** 往 agent 里补一句话（提交，不等结果） */
  async send(target: string, text: string): Promise<Result<void>> {
    const r = await promptAgent(this.#cli, target, text);
    return r.ok ? ok(undefined) : r;
  }

  /**
   * 送逻辑按键。agent 卡在审批/选择框上时 `agent prompt` 会被 herdr 拒掉
   * （`agent_blocked`，它故意不自动替人回答弹窗），这时靠按键驱动它。
   */
  async keys(target: string, keys: string[]): Promise<Result<void>> {
    return sendKeys(this.#cli, target, keys);
  }

  async #startNew(agentKind: string): Promise<Result<string>> {
    const name = this.#agentName();
    const started = await startAgent(this.#cli, { name, kind: agentKind });
    if (!started.ok) return started;
    const target = started.data.name ?? started.data.paneId;
    if (target === undefined) {
      return err("AGENT_START_FAILED", `新起的 ${agentKind} 没有可用的名字`);
    }
    return ok(target);
  }

  /** 只从已有、就绪且无 watch 的空闲 agent 里选；找不到也绝不隐式创建。 */
  async #chooseExisting(task: string): Promise<Result<string>> {
    const listed = await this.listAgents();
    if (!listed.ok) return listed;
    const busy = new Set([...this.#watches.values()].map((w) => w.agent));
    const words = task.toLowerCase().split(/[^\p{L}\p{N}_-]+/u).filter((word) => word.length > 1);
    const score = (agent: HerdrAgent) => words.filter((word) =>
      [agent.name, agent.cwd, agent.title].some((value) => value?.toLowerCase().includes(word)),
    ).length;
    const candidates = listed.data.filter((a) =>
      (a.status === "idle" || a.status === "done") && a.interactiveReady !== false &&
      (a.name !== undefined || a.paneId !== undefined) &&
      !busy.has(a.name ?? a.paneId!) && (a.paneId === undefined || a.paneId !== process.env.HERDR_PANE_ID),
    ).sort((a, b) => score(b) - score(a));
    const chosen = candidates[0];
    return chosen ? ok(chosen.name ?? chosen.paneId!) : err("VALIDATION_ERROR", "没有可用的现有 agent，请等它们空闲或明确要求新建 agent。");
  }

  /** herdr 要求名字匹配 [a-z][a-z0-9_-]{0,31} */
  #agentName(): string {
    const raw = this.#newId().toLowerCase().replace(/[^a-z0-9]/g, "");
    return `fb-${raw.slice(0, 12) || "agent"}`;
  }

  #register(chatId: string, agent: string, task: string, to: SendTarget, threadId?: string): WatchRecord {
    const record: WatchRecord = {
      id: this.#newId().slice(0, 8),
      chatId,
      agent,
      task,
      to: { ...to },
      threadId,
      startedAt: this.#now(),
      controller: new AbortController(),
    };
    this.#watches.set(record.id, record);
    this.#changed();
    return record;
  }

  /** 把后台 watch 挂进登记表。绝不 await —— 派活的调用方要立刻回去接下一条消息 */
  #spawnRun(record: WatchRecord, task: string | undefined): void {
    const p = this.#run(record, task);
    this.#pending.add(p);
    void p.finally(() => this.#pending.delete(p));
  }

  async #run(record: WatchRecord, task: string | undefined): Promise<void> {
    const signal = record.controller.signal;
    try {
      const settled =
        task === undefined
          ? await watchUntilSettled(this.#cli, record.agent, {
              timeoutMs: this.#timeoutMs,
              maxWaitMs: this.#maxWaitMs,
              pollMs: this.#pollMs,
              signal,
            })
          : await promptAndWatch(this.#cli, record.agent, task, {
              timeoutMs: this.#timeoutMs,
              maxWaitMs: this.#maxWaitMs,
              pollMs: this.#pollMs,
              signal,
            });
      // 用户已经取消 / 桥接已停止：这条记录不再是「在等的任务」，也不再发结果
      if (!this.#watches.has(record.id)) return;
      this.#watches.delete(record.id);
      this.#changed();

      if (!settled.ok) {
        if (settled.error.code === "CANCELLED") return;
        await this.#deliverResult(record,
          renderHerdrError(`**${record.agent}** 的 watch 断了：`, settled.error),
          true,
        );
        return;
      }

      const now = this.#now();
      const harvested = await harvestResult(this.#cli, record.agent, settled.data.agent);
      await this.#deliverResult(record,
        renderResult({
          agent: record.agent,
          status: settled.data.status,
          body: harvested.ok ? harvested.data.text : "",
          elapsedMs: now - record.startedAt,
          timedOut: settled.data.timedOut,
          stalled: settled.data.stalled,
          watchId: record.id,
        }),
        false,
      );
    } catch (e) {
      // 后台任务绝不能把异常抛进 pi 的事件循环
      this.#watches.delete(record.id);
      this.#changed();
      this.#log(`herdr watch ${record.id} 异常：${String(e)}`, "error");
    }
  }

  async #deliverResult(record: WatchRecord, body: string, failed: boolean): Promise<void> {
    if (this.#onComplete) {
      await this.#onComplete({ id: record.id, name: "herdr", to: { ...record.to },
        question: record.task, threadId: record.threadId, body, failed });
    } else {
      await this.#notify(body, record.to);
    }
  }

  async #notify(markdown: string, to: SendTarget): Promise<void> {
    try {
      await this.#send(markdown, to);
    } catch (e) {
      this.#log(`把 herdr 结果发回飞书失败：${String(e)}`, "warning");
    }
  }
}
