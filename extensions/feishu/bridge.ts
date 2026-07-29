import fs from "node:fs";
import path from "node:path";
import type { AppendSink } from "./turn-stream.ts";
import { TurnStream } from "./turn-stream.ts";
import { assessRisk, type PathResolver, type Risk } from "./risk.ts";
import { requestApproval, type Asker, type Decision } from "./approval.ts";
import {
  renderBlocked,
  renderNotice,
  renderToolEnd,
  renderToolStart,
  renderTurnEnd,
  renderUserPrompt,
} from "./renderer.ts";
import type { Config } from "./config.ts";
import type { InboundMessage } from "./feishu.ts";
import type { LogFn } from "./log.ts";

export interface GatewayLike {
  boundChatId?: string;
  bind(chatId: string): void;
  onMessage(handler: (msg: InboundMessage) => void): void;
  /** to 省略时发往网关的默认收件方 */
  streamTurn(run: (sink: AppendSink) => Promise<void>, to?: string): Promise<void>;
  sendText(markdown: string, to?: string): Promise<void>;
  downloadImage(fileKey: string): Promise<Buffer | undefined>;
  /**
   * 面向指定会话的审批通道。多会话模式下，卡片必须弹回触发该回合的那个对话 ——
   * 弹错地方就是让不相干的人看见并批准。
   */
  askerFor(to?: string): Asker;
}

/**
 * 回合结束后等待流式收尾的上限。飞书 SDK 若卡在一次 send 上不返回
 * （挂住而不是拒绝），无上限的 await 会让 endTurn 永不返回。
 */
const STREAM_DRAIN_TIMEOUT_MS = 15_000;

export type ControlCommand =
  | { kind: "status" }
  | { kind: "stop" }
  | { kind: "unbind" }
  | { kind: "help" };

/**
 * 飞书侧的控制命令，在本地处理、不进 agent。
 * 不提供 start —— 建立长连接必须由终端持有者发起。
 */
export function parseControlCommand(text: string): ControlCommand | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/feishu")) return undefined;
  const rest = trimmed.slice("/feishu".length);
  // "/feishuXXX" 不算命令，必须是词边界
  if (rest !== "" && !/^\s/.test(rest)) return undefined;
  const sub = rest.trim().toLowerCase();
  if (sub === "status") return { kind: "status" };
  if (sub === "stop") return { kind: "stop" };
  if (sub === "unbind") return { kind: "unbind" };
  return { kind: "help" };
}

export function decideDelivery(
  text: string,
  isStreaming: boolean,
): { text: string; deliverAs?: "steer" | "followUp" } {
  if (text.startsWith("!")) {
    const stripped = text.slice(1).trim();
    return isStreaming ? { text: stripped, deliverAs: "steer" } : { text: stripped };
  }
  return isStreaming ? { text, deliverAs: "followUp" } : { text };
}

export function shouldAccept(
  gateway: { boundChatId?: string },
  chatId: string,
  multiChat = false,
): boolean {
  // 多会话模式下不做会话级过滤 —— 谁能触达已经由飞书侧的策略管道决定
  // （dmMode / 白名单 / requireMention），这里再拦一次只会把群 @ 也挡掉
  if (multiChat) return true;
  return gateway.boundChatId === undefined || gateway.boundChatId === chatId;
}

/** bindToChat 需要的那一小块网关能力 */
export interface ChatBindGateway {
  boundChatId?: string;
  bind(chatId: string): void;
  sendText(text: string, to?: string): Promise<void>;
}

/**
 * 直接绑定一个已知的会话（通常是群），并往里发一条就绪通知。
 *
 * 通知发失败仍然完成绑定：绑定决定的是**入站消息认哪个会话**，
 * 出站坏了（机器人不在群里、被移除权限）不该连入站过滤一起失效 ——
 * 否则群里发的消息会被当成「未绑定」而绑到别处去。
 */
export async function bindToChat(
  gateway: ChatBindGateway,
  chatId: string,
  text: string,
  log: LogFn,
): Promise<boolean> {
  if (gateway.boundChatId !== undefined) return false;
  gateway.bind(chatId);
  try {
    await gateway.sendText(text, chatId);
  } catch (err) {
    log(`向 ${chatId} 发送就绪通知失败（绑定已生效）：${String(err)}`, "warning");
  }
  return true;
}

/** announceAndBind 需要的那一小块网关能力 */
export interface AnnounceGateway {
  boundChatId?: string;
  bind(chatId: string): void;
  /** 私信某人，返回该私聊会话的 chatId；拿不到时返回 undefined */
  announce(openId: string, text: string): Promise<string | undefined>;
}

/**
 * 主动私信操作员并把回来的私聊会话绑上，省去「必须先由人发一条消息」这一步。
 *
 * 全程不抛异常：机器人对该用户没有可用性、用户还没添加机器人、网络不通，
 * 都只是「这次没绑上」而已 —— 绝不能让 /feishu start 跟着失败。绑不上就退回
 * 原来的行为：等第一条入站消息来绑定。
 */
export async function announceAndBind(
  gateway: AnnounceGateway,
  operatorOpenId: string,
  text: string,
  log: LogFn,
): Promise<boolean> {
  // 已经绑好了就别再发消息打扰，更不能把已有绑定顶掉
  if (gateway.boundChatId !== undefined) return false;

  let chatId: string | undefined;
  try {
    chatId = await gateway.announce(operatorOpenId, text);
  } catch (err) {
    log(`主动私信操作员失败，退回等待入站消息绑定：${String(err)}`, "warning");
    return false;
  }
  if (chatId === undefined) {
    log("主动私信没拿到 chatId，退回等待入站消息绑定", "warning");
    return false;
  }
  gateway.bind(chatId);
  return true;
}

/**
 * 解析符号链接。目标常常还不存在 —— `write` 新文件正是如此 —— 直接
 * realpath 会抛错。逐级上溯到最近的**已存在**祖先做 realpath，再把剩下的
 * 路径段拼回去；否则「仓库里有个指向仓库外的符号链接目录，往它下面写新
 * 文件」会被判成仓库内，这是 balanced 档最主要的逃逸口。
 */
export const realPathOrSelf: PathResolver = (p) => {
  const abs = path.resolve(p);
  let current = abs;
  const suffix: string[] = [];
  for (;;) {
    try {
      const real = fs.realpathSync.native(current);
      return suffix.length === 0 ? real : path.join(real, ...suffix.slice().reverse());
    } catch {
      const parent = path.dirname(current);
      // 一路到根都不存在，只能按字面路径判
      if (parent === current) return abs;
      suffix.push(path.basename(current));
      current = parent;
    }
  }
};

interface TurnState {
  stream: TurnStream;
  startedAt: number;
  tokens: number;
  pumping: Promise<void>;
  /** 流式失败时用于补发的全文副本 */
  transcript: string;
  streamFailed: boolean;
}

export class Bridge {
  #turn: TurnState | undefined;
  /**
   * 待认领的入站来源，FIFO。转发消息给 pi 时入队，agent_start 时出队。
   *
   * pi 的 agent_start 事件不带「是哪条消息触发的」，所以来源只能靠顺序推断。
   * 顺序在常规路径（含 followUp 排队）上是成立的，但有两处对不上，
   * 见 docs/broker.md「多会话的来源归属」：
   *   - 终端自己敲的回合没有来源，出队会拿到 undefined，退回默认收件方
   *   - 回合中途被另一个对话 steer，输出仍回到最初那个来源
   */
  #origins: string[] = [];
  /** 当前回合的出站目标 */
  #turnTarget: string | undefined;
  #toolStartedAt = new Map<string, number>();
  /**
   * 操作员点了「本回合全部允许」。只在当前 agent 回合内有效，
   * startTurn/endTurn 两头都清零 —— 宁可多问一次，也不能让豁免漏到下个回合。
   */
  #turnApproved = false;

  /** ExtensionAPI 不暴露流式状态，这里自己跟踪 */
  get isStreaming(): boolean {
    return this.#turn !== undefined;
  }

  /** 操作员是否点过「本回合全部允许」，供 /feishu status 展示 */
  get turnApproved(): boolean {
    return this.#turnApproved;
  }

  // strip-only 模式不支持构造函数参数属性，依赖写成显式字段
  readonly #config: Config;
  readonly #gateway: GatewayLike;
  readonly #log: LogFn;
  readonly #now: () => number;
  readonly #drainTimeoutMs: number;

  constructor(
    config: Config,
    gateway: GatewayLike,
    log: LogFn,
    now: () => number = () => Date.now(),
    drainTimeoutMs: number = STREAM_DRAIN_TIMEOUT_MS,
  ) {
    this.#config = config;
    this.#gateway = gateway;
    this.#log = log;
    this.#now = now;
    this.#drainTimeoutMs = drainTimeoutMs;
  }

  /** 出站一律不得把异常抛回 pi 的事件循环 */
  #safe(fn: () => void): void {
    try {
      fn();
    } catch (err) {
      this.#log(`出站渲染失败：${String(err)}`, "warning");
    }
  }

  #push(chunk: string): void {
    this.#safe(() => {
      const turn = this.#turn;
      if (!turn) return;
      turn.transcript += chunk;
      turn.stream.push(chunk);
    });
  }

  /** 转发入站消息给 pi 之前调用，登记这条消息的来源 */
  noteInboundOrigin(chatId: string): void {
    this.#origins.push(chatId);
  }

  startTurn(): void {
    if (this.#turn) return;
    this.#turnApproved = false;
    this.#turnTarget = this.#origins.shift();
    const stream = new TurnStream();
    const turn: TurnState = {
      stream,
      startedAt: this.#now(),
      tokens: 0,
      transcript: "",
      streamFailed: false,
      pumping: Promise.resolve(),
    };
    turn.pumping = this.#gateway
      .streamTurn(async (sink) => stream.pump(sink), this.#turnTarget)
      .catch((err) => {
        turn.streamFailed = true;
        this.#log(`飞书流式发送失败，将在回合结束后补发全文：${String(err)}`, "warning");
      });
    this.#turn = turn;
  }

  onUserPrompt(text: string, source: "interactive" | "feishu"): void {
    const rendered = renderUserPrompt(text, source);
    if (rendered !== null) this.#push(rendered);
  }

  onTextDelta(delta: string): void {
    this.#push(delta);
  }

  onToolStart(toolCallId: string, toolName: string, input: Record<string, unknown>): void {
    this.#toolStartedAt.set(toolCallId, this.#now());
    this.#push(renderToolStart(toolName, input));
  }

  onToolEnd(toolCallId: string, isError: boolean): void {
    const startedAt = this.#toolStartedAt.get(toolCallId) ?? this.#now();
    this.#toolStartedAt.delete(toolCallId);
    this.#push(renderToolEnd(isError, this.#now() - startedAt));
  }

  addTokens(n: number): void {
    if (this.#turn) this.#turn.tokens += n;
  }

  notice(text: string): void {
    this.#push(renderNotice(text));
  }

  async endTurn(): Promise<void> {
    const turn = this.#turn;
    if (!turn) return;
    this.#turnApproved = false;
    this.#push(renderTurnEnd(this.#now() - turn.startedAt, turn.tokens));
    this.#turn = undefined;
    this.#toolStartedAt.clear();
    turn.stream.finish();

    // 给 pump 收尾设上限。飞书 SDK 若卡在一次 send 上不返回（不是拒绝，是挂住），
    // 无上限的 await 会让 endTurn 永不返回，调用方跟着一起卡死。
    let timer: ReturnType<typeof setTimeout> | undefined;
    const drained = await Promise.race([
      turn.pumping.then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), this.#drainTimeoutMs);
      }),
    ]);
    if (timer !== undefined) clearTimeout(timer);
    if (!drained) {
      turn.streamFailed = true;
      this.#log(`流式收尾超时（${this.#drainTimeoutMs}ms），改为补发全文`, "warning");
    }

    // 流式卡片废了（断线/限流/元素超限/收尾超时）时，把全文作为普通消息补发一次
    if (turn.streamFailed && turn.transcript.trim() !== "") {
      try {
        await this.#gateway.sendText(turn.transcript, this.#turnTarget);
      } catch (err) {
        this.#log(`补发全文也失败了，本回合内容仅存在于终端：${String(err)}`, "error");
      }
    }
  }

  /** tool_call 钩子：危险则审批，拒绝则返回阻塞结果 */
  async gateToolCall(
    toolName: string,
    input: Record<string, unknown>,
    tuiAsker: Asker | undefined,
  ): Promise<{ block: true; reason: string } | undefined> {
    // 判定本身抛错必须按危险处理。这是个 async 函数，未捕获的异常会变成
    // rejected promise 直接跳过 block 契约 —— 结果是危险工具被放行，
    // 在安全闸门上正好是最坏的方向。
    let risk: Risk;
    try {
      risk = assessRisk({
        toolName,
        input,
        mode: this.#config.approvalMode,
        repoRoot: this.#config.repoRoot,
        resolvePath: realPathOrSelf,
        denyPatterns: this.#config.denyPatterns,
        allowPatterns: this.#config.allowPatterns,
      });
    } catch (err) {
      this.#log(`危险判定异常，按危险处理：${String(err)}`, "error");
      risk = "risky";
    }
    if (risk === "safe") return undefined;
    // 本回合已被整体批准，后续危险调用不再打扰操作员
    if (this.#turnApproved) return undefined;

    const askers: Asker[] = [this.#gateway.askerFor(this.#turnTarget)];
    if (tuiAsker) askers.push(tuiAsker);

    let decision: Decision;
    try {
      decision = await requestApproval(
        { toolName, input },
        askers,
        this.#config.approvalTimeoutMs,
      );
    } catch (err) {
      this.#log(`审批流程异常，按拒绝处理：${String(err)}`, "error");
      decision = { allow: false, reason: "审批流程异常" };
    }

    // 只有「批准 + turn」才开启豁免；拒绝带 scope 一律无效
    if (decision.allow && decision.scope === "turn") this.#turnApproved = true;

    if (decision.allow) return undefined;
    this.#push(renderBlocked(toolName, decision.reason));
    return { block: true, reason: decision.reason };
  }

  async toPromptContent(msg: InboundMessage): Promise<string> {
    if (msg.imageKeys.length === 0) return msg.text;
    const notes: string[] = [];
    for (const key of msg.imageKeys) {
      const buf = await this.#gateway.downloadImage(key);
      notes.push(buf ? `[图片 ${key}，${buf.byteLength} 字节]` : `[图片下载失败 ${key}]`);
    }
    return [msg.text, ...notes].filter(Boolean).join("\n");
  }
}
