import fs from "node:fs";
import path from "node:path";
import type { AppendSink } from "./turn-stream.ts";
import { TurnStream } from "./turn-stream.ts";
import { assessRisk, type PathResolver, type Risk } from "./risk.ts";
import { requestApproval, type Asker, type Decision } from "./approval.ts";
import {
  renderBlocked,
  renderNotice,
  renderQuestion,
  renderToolEnd,
  renderToolStart,
  renderTurnEnd,
  renderUserPrompt,
} from "./renderer.ts";
import type { Config } from "./config.ts";
import { DeferredQueue, shouldDefer, type DeferredMessage } from "./deferred.ts";
import { MessageOriginRegistry } from "./origin-registry.ts";
import { AgentOriginRegistry, dispatchedSessionOf, noticeSessionOf } from "./agent-origin.ts";
export { gateInbound, type GateState, type InboundGate } from "./gate.ts";
import type { InboundMessage } from "./feishu.ts";
import type { SendTarget } from "./types.ts";
import type { LogFn } from "./log.ts";

export interface GatewayLike {
  boundChatId?: string;
  bind(chatId: string): void;
  onMessage(handler: (msg: InboundMessage) => void): void;
  /** to 省略时发往网关的默认收件方 */
  streamTurn(run: (sink: AppendSink) => Promise<void>, to?: string | SendTarget): Promise<void>;
  sendText(markdown: string, to?: string | SendTarget): Promise<void>;
  /** 发图片。收字节不收路径 —— 路径准入是 `image.ts` 的事。 */
  sendImage?(png: Buffer, to?: string | SendTarget): Promise<void>;
  downloadImage(fileKey: string): Promise<Buffer | undefined>;
  /**
   * 给消息加表情回应，充当「已读/在处理」的信号。
   * 失败绝不能影响消息处理本身。
   */
  react?(messageId: string, emoji: string): Promise<void>;
  /**
   * 面向指定会话的审批通道。多会话模式下，卡片必须弹回触发该回合的那个对话 ——
   * 弹错地方就是让不相干的人看见并批准。
   */
  askerFor(to?: string | SendTarget): Asker;
}

/**
 * 回合结束后等待流式收尾的上限。飞书 SDK 若卡在一次 send 上不返回
 * （挂住而不是拒绝），无上限的 await 会让 endTurn 永不返回。
 */
const STREAM_DRAIN_TIMEOUT_MS = 15_000;

/**
 * 单个回合最多往飞书转发多少字符，超了就停流并提示。
 *
 * 模型在超长上下文里会退化成复读机 —— 实测一次：boss 会话堆到 30 万 token 后，
 * `deepseek-v4-flash-0731` 一条消息里把「收到记忆上下文…我调用 asd_peek 工具」
 * 复读了 470 遍、36126 字符，一个工具都没调，直到撞满 `maxTokens` 才被
 * `stopReason: "length"` 截断。这些 delta 经 `onTextDelta` 原样流到飞书，
 * 超出单卡容量后 SDK 不断 rollover，操作员那边就是一条接一条的卡片刷屏。
 *
 * 退化本身要靠模型和上下文长度去治（那次的诱因是 `contextWindow` 配成 1000000，
 * 压缩永不触发）。这里只做最后一道闸：**不让主 agent 的失控输出打扰到人**。
 *
 * 阈值取得比任何正常输出都宽 —— 那次会话 705 条消息里，没被复读污染的
 * assistant 消息**没有一条超过 3000 字符**。32k 是它的 10 倍，正常回合撞不到。
 */
const TURN_OUTPUT_LIMIT = 32_000;

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

/**
 * `agentActive` 问的是「**pi** 忙不忙」（agent_start → agent_settled），
 * 不是「飞书流开着没」。传错会丢消息：agent_end 之后 pi 仍可能在自动重试，
 * 那时不带 deliverAs 直接发，`prompt()` 抛 "Agent is already processing"。
 */
export function decideDelivery(
  text: string,
  agentActive: boolean,
): { text: string; deliverAs?: "steer" | "followUp" } {
  if (text.startsWith("!")) {
    const stripped = text.slice(1).trim();
    return agentActive ? { text: stripped, deliverAs: "steer" } : { text: stripped };
  }
  return agentActive ? { text, deliverAs: "followUp" } : { text };
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
  /** 已经撞上 TURN_OUTPUT_LIMIT，本回合不再转发正文 */
  truncated: boolean;
  /** 卡片已经建了（`streamTurn` 已调用）。出站目标就是那一刻定死的 */
  streaming: boolean;
}

export class Bridge {
  #turn: TurnState | undefined;

  /**
   * 消息级来源登记表。出站一律「按 messageId 查对话」，不再有任何
   * 「最近一条是谁」的全局变量。详见 origin-registry.ts。
   */
  #origins: MessageOriginRegistry;

  /**
   * pi-asd 子 agent 的来源登记：session 名 → 当初派活那个对话。详见 agent-origin.ts。
   *
   * 和 `#origins` 是两把不同的钥匙，不能合并：那张按 messageId 索引，回答「这个
   * 回合是谁发起的」；这张按 session 名索引，回答「这个子 agent 是谁派的」——
   * watcher 的推送不是任何消息的回复，只有后一把钥匙查得到。
   */
  #agentOrigins = new AgentOriginRegistry();

  /**
   * 本回合是被哪个子 agent 的推送带起来的（`message_start` 上认出来）。
   *
   * 只在**认领不到消息来源**时才用得上，见 `#autonomousTarget`。`settleAgent()`
   * 里清 —— 和 `#originMessageId` 同寿命，绝不能漏到下一个回合。
   */
  #agentTarget: SendTarget | undefined;

  /**
   * 本次 pi 运行认领到的那条消息。由 `claimTurnOrigin()` 在 `before_agent_start`
   * 上按原文认领，`settleAgent()` 时清掉。
   *
   * 认不到就是 undefined —— 终端敲的字正是这种情况，出站退回网关的默认收件方。
   * 注意**不能**在 `endTurn` 清：一次运行里自动重试会开多个回合，
   * 而 `before_agent_start` 只发一次。
   */
  #originMessageId: string | undefined;
  /** 纯图片消息的飞书原文为空时，退回实际投给 agent 的 prompt 作为卡片标题 */
  #originPrompt: string | undefined;

  /**
   * `pi.sendUserMessage()` 是 fire-and-forget 的 void API。从调用它到
   * `before_agent_start` / `agent_start` 之间有异步窗口，不能在这段时间继续
   * 宣称空闲，否则紧邻的第二问会被 pi 并进同一 run、只更新第一张卡片。
   */
  #dispatchReserved = false;
  #dispatchMessageId: string | undefined;
  /** before_agent_start 已经认领后，超时器不能再把一条即将 start 的合法投递清掉 */
  #dispatchAccepted = false;

  #deferred = new DeferredQueue();
  #toolStartedAt = new Map<string, number>();
  /**
   * 操作员点了「本回合全部允许」。只在当前 agent 回合内有效，
   * startTurn/endTurn 两头都清零 —— 宁可多问一次，也不能让豁免漏到下个回合。
   */
  #turnApproved = false;

  /**
   * pi 的 agent 运行是否还在进行：`agent_start` → `agent_settled`。
   *
   * **比 `isStreaming` 活得久**，这两个是不同的生命周期，混用过一次就丢消息：
   * `agent_end` 之后 pi 还可能自动重试或压缩上下文（`_handlePostAgentRun` 会用
   * `agent.continue()` 再开一轮），`_isAgentRunActive` 要到 `_emitAgentSettled`
   * 才置 false。这段窗口里不带 `deliverAs` 直接发，`prompt()` 会抛
   * "Agent is already processing"，消息就没了。
   *
   * 窗口不短：`endTurn` 一进来就把 `#turn` 清了，之后还要等流式收尾（上限 15s）。
   */
  #agentActive = false;

  get isAgentActive(): boolean {
    return this.#agentActive || this.#dispatchReserved;
  }

  /** 飞书流是否开着：`agent_start` → `agent_end`。只管渲染，别拿它判断 pi 忙不忙 */
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
  readonly #outputLimit: number;

  constructor(
    config: Config,
    gateway: GatewayLike,
    log: LogFn,
    now: () => number = () => Date.now(),
    drainTimeoutMs: number = STREAM_DRAIN_TIMEOUT_MS,
    outputLimit: number = TURN_OUTPUT_LIMIT,
  ) {
    this.#config = config;
    this.#gateway = gateway;
    this.#log = log;
    this.#now = now;
    this.#drainTimeoutMs = drainTimeoutMs;
    this.#outputLimit = outputLimit;
    this.#origins = new MessageOriginRegistry(now);
  }

  /** 排查用；出站请走 turnTarget / askerFor，别直接读表 */
  get origins(): MessageOriginRegistry {
    return this.#origins;
  }

  /** 出站一律不得把异常抛回 pi 的事件循环 */
  #safe(fn: () => void): void {
    try {
      fn();
    } catch (err) {
      this.#log(`出站渲染失败：${String(err)}`, "warning");
    }
  }

  /**
   * 正文出口，带熔断。见 TURN_OUTPUT_LIMIT。
   *
   * 闸门卡在 `transcript` 的长度上而不是只掐 `stream`：`transcript` 同时是
   * 流式失败时补发全文的载荷（见 endTurn），只掐流的话失控输出会原样变成
   * 一条超长普通消息发出去 —— 换个姿势刷屏而已。
   */
  #push(chunk: string): void {
    this.#safe(() => {
      const turn = this.#turn;
      if (!turn || turn.truncated || chunk === "") return;

      const remaining = this.#outputLimit - turn.transcript.length;
      if (chunk.length <= remaining) {
        turn.transcript += chunk;
        turn.stream.push(chunk);
        this.#startStreaming(turn);
        return;
      }

      // 截断这一块并封口。剩余额度可能是 0 甚至负数（上一块正好压线），
      // slice 对负数会从尾部取，所以先夹到 [0, ∞)
      const head = chunk.slice(0, Math.max(0, remaining));
      const notice = renderNotice(
        `本回合输出已超过 ${this.#outputLimit} 字符，疑似模型复读，后续内容不再转发到飞书（终端仍完整）`,
      );
      turn.truncated = true;
      turn.transcript += head + notice;
      turn.stream.push(head + notice);
      this.#startStreaming(turn);
      this.#log(
        `回合输出超过 ${this.#outputLimit} 字符，已停止向飞书转发本回合剩余内容`,
        "warning",
      );
    });
  }

  /**
   * 绕过熔断的出口，只给回合收尾用。
   *
   * 熔断之后仍要让操作员看到「这一回合结束了、用了多久」，否则卡片停在
   * 提示那一行，看起来像 pi 挂死了。这行是固定长度的页脚，不是失控内容。
   */
  #pushFinal(chunk: string): void {
    this.#safe(() => {
      const turn = this.#turn;
      if (!turn) return;
      turn.transcript += chunk;
      turn.stream.push(chunk);
      // 回合页脚也是内容 —— 一个字都没产出的回合到这里才建卡，
      // 保证「startTurn 过的回合最终一定建过一次卡」这条不变。
      this.#startStreaming(turn);
    });
  }

  /** 入站消息一到就登记来源，在任何放行判定之前 */
  recordInbound(
    msg: { messageId: string; chatId: string; senderId: string; text?: string; threadId?: string },
  ): void {
    this.#origins.record(msg);
  }

  /**
   * `tool_execution_end` 上登记「这次调用把活派给了哪个子 agent」。
   *
   * 记的是**当前回合的出站目标**：派活这一刻我们还知道是谁在说话，等 watcher
   * 一两分钟后把结果推回来时就没有任何线索了。不是 pi-asd 的派活工具直接忽略。
   */
  noteToolResult(toolName: string, result: unknown): void {
    const session = dispatchedSessionOf(toolName, result);
    if (session === undefined) return;
    const target = this.turnSendTarget;
    if (target === undefined) return;
    this.#agentOrigins.bind(session, target);
  }

  /**
   * `message_start` 上认出 pi-asd 的 watcher 推送，把本回合改投回派活那个对话。
   *
   * 时序上这条消息在 `agent_start` **之后**才到（pi 的 agent loop 先发 agent_start
   * 再逐条发输入消息的 message_start），所以 `startTurn` 那时还不知道该发去哪 ——
   * 这正是它必须等到有内容再建卡的原因，见 `#startStreaming`。
   */
  noteCustomMessage(message: unknown): void {
    const session = noticeSessionOf(message);
    if (session === undefined) return;
    // 查不到就保持 undefined，退回默认收件方 —— 没线索时不许猜
    this.#agentTarget = this.#agentOrigins.targetOf(session);
  }

  /** 登记会开新 run 的 prompt；并入当前 run 的 steer 没有 before_agent_start，不能留索引 */
  noteInboundPrompt(
    messageId: string,
    promptText: string,
    deliverAs?: "steer" | "followUp",
  ): void {
    if (deliverAs === "steer") return;
    this.#origins.indexPrompt(messageId, promptText);
  }

  /**
   * `before_agent_start` 上按原文认领触发这轮的消息。
   *
   * 这是 pi 唯一提供的、能把「回合」和「消息」对上的东西：`agent_start` 是空事件，
   * `sendUserMessage` 收不了元数据，而 `before_agent_start.prompt` 就是
   * `sendUserMessage` 收到的原字符串，且恰好在 `agent_start` 之前发出。
   *
   * 认不到就置空 —— 终端敲的字走的也是这条路，此时必须是「没有来源」，
   * 沿用上一次的会把终端的回合发进飞书上一个对话。
   */
  claimTurnOrigin(prompt: string): string | undefined {
    const origin = this.#origins.claimByPrompt(prompt);
    this.#originMessageId = origin?.messageId;
    this.#originPrompt = origin === undefined ? undefined : prompt;
    if (origin?.messageId === this.#dispatchMessageId) this.#dispatchAccepted = true;
    return origin?.messageId;
  }

  /**
   * 在调用 fire-and-forget 的 sendUserMessage **之前**同步占位。
   * 返回 false 表示另一条消息已经抢先占住，调用方必须把当前消息转入延迟队列。
   */
  reserveDispatch(messageId: string): boolean {
    if (this.isAgentActive) return false;
    this.#dispatchReserved = true;
    this.#dispatchMessageId = messageId;
    this.#dispatchAccepted = false;
    return true;
  }

  /** sendUserMessage 同步拒绝（例如扩展上下文已失效）时撤销占位和认领索引。 */
  cancelDispatch(messageId: string): void {
    if (!this.#dispatchReserved || this.#dispatchMessageId !== messageId) return;
    this.#dispatchReserved = false;
    this.#dispatchMessageId = undefined;
    this.#dispatchAccepted = false;
    this.#origins.forget(messageId);
  }

  /**
   * fire-and-forget 投递迟迟没有走到 before_agent_start 时的止损。
   * 已被 before_agent_start 认领就返回 false，避免合法的慢启动被定时器误清。
   */
  expireDispatch(messageId: string): boolean {
    if (
      !this.#dispatchReserved ||
      this.#dispatchMessageId !== messageId ||
      this.#dispatchAccepted
    ) return false;
    this.cancelDispatch(messageId);
    return true;
  }

  /**
   * 把「占位 → 登记认领原文 → 调 void API → 同步失败回滚」收在一个不可拆的同步段。
   * 接线层若分别调用这些步骤，很容易在中间加进 await，把竞态窗口重新打开。
   */
  dispatchToAgent(
    messageId: string,
    promptText: string,
    deliverAs: "steer" | "followUp" | undefined,
    send: () => void,
  ): { kind: "sent" } | { kind: "busy" } | { kind: "failed"; error: unknown } {
    const startsRun = deliverAs !== "steer";
    if (startsRun && !this.reserveDispatch(messageId)) return { kind: "busy" };
    this.noteInboundPrompt(messageId, promptText, deliverAs);
    try {
      send();
      return { kind: "sent" };
    } catch (error) {
      if (startsRun) this.cancelDispatch(messageId);
      else this.#origins.forget(messageId);
      return { kind: "failed", error };
    }
  }

  /** 本回合认领到的消息，未认领到时 undefined。工具调用绑定要用 */
  get originMessageId(): string | undefined {
    return this.#originMessageId;
  }

  /**
   * 当前运行的**有效**出站目标：按认领到的 messageId 回查对话；查不到就退回
   * 网关的默认收件方（已绑定会话）—— 终端敲字发起的回合正是这种情况。
   *
   * 单会话档（`multiChat` 关）保持原有行为：出站一律走已绑定会话，不查登记表。
   */
  get turnTarget(): string | undefined {
    if (!this.isAgentActive) return undefined;
    if (!this.#config.multiChat) return this.#gateway.boundChatId;
    const messageId = this.#originMessageId ?? this.#dispatchMessageId;
    return (
      this.#origins.chatOf(messageId) ?? this.#autonomousTarget?.chatId ?? this.#gateway.boundChatId
    );
  }

  /**
   * 子 agent 推送带来的出站目标 —— **只在认领不到消息来源时**有效。
   *
   * 认领得到就说明这一轮是某条飞书消息发起的（推送是以 followUp 并进来的），
   * 那一轮属于提问的那个人，不能被一条顺路的 agent 通知改道。
   */
  get #autonomousTarget(): SendTarget | undefined {
    return this.#originMessageId === undefined ? this.#agentTarget : undefined;
  }

  /** 当前运行所属的精确对话；同一群的两个话题不是同一个 steer 目标。 */
  get turnConversation(): { chatId: string; threadId?: string } | undefined {
    if (!this.isAgentActive) return undefined;
    const messageId = this.#originMessageId ?? this.#dispatchMessageId;
    // 即使 multiChat 关闭也要先保留来源 thread；它只限制 chat 范围，不代表
    // 同一群的主干和所有话题可以互相 steer。只有终端轮没有来源时才退回绑定会话。
    return this.#origins.conversationOf(messageId) ?? (
      this.#gateway.boundChatId === undefined ? undefined : { chatId: this.#gateway.boundChatId }
    );
  }

  /**
   * 同 `turnTarget`，但带上话题信息 —— **出站一律用这个**。
   *
   * `turnTarget` 只回 chatId，供旧的出站/状态展示使用；延迟判定另走
   * `turnConversation`，因为同一群里的不同话题也不能互相 steer。
   *
   * 触发这轮的消息不在话题里（普通群 / 私聊 / 终端敲的字）时，这里退化成
   * `{ chatId }`，与加话题之前完全一致。
   */
  get turnSendTarget(): SendTarget | undefined {
    const chatId = this.turnTarget;
    if (chatId === undefined) return undefined;
    const target = this.#origins.targetOf(this.#originMessageId) ?? this.#autonomousTarget;
    // 单会话档仍要保留已绑定群里的 thread；multiChat 只决定能否跨 chat，
    // 不是「是否支持话题」开关。来源不是绑定 chat 时继续退回旧的绑定目标 ——
    // 子 agent 的推送走的也是这条判断，所以单会话档下它同样跨不出绑定会话。
    return target?.chatId === chatId ? target : { chatId };
  }

  /**
   * pi 的运行彻底结束（agent_settled）时调用。
   * 认领的关联在这里清 —— 不能在 endTurn 清，自动重试会在一次运行里开多个回合。
   */
  settleAgent(): void {
    this.#agentActive = false;
    const reservedMessageId = this.#dispatchMessageId;
    this.#dispatchReserved = false;
    this.#dispatchMessageId = undefined;
    this.#dispatchAccepted = false;
    if (this.#originMessageId !== undefined) {
      this.#origins.forget(this.#originMessageId);
      this.#originMessageId = undefined;
    }
    if (reservedMessageId !== undefined) this.#origins.forget(reservedMessageId);
    this.#originPrompt = undefined;
    // 和 #originMessageId 同寿命：漏清的话，下一个认领不到来源的回合（终端敲的字）
    // 会被上一条 agent 推送的目标带走。登记表本身不清 —— 那个 session 还活着，
    // 下一次推送还要按它回查。
    this.#agentTarget = undefined;
  }

  /** 这条消息是否该扣住，等当前回合跑完再单独成回合。理由见 deferred.ts */
  shouldDefer(messageId: string, deliverAs?: "steer" | "followUp"): boolean {
    // reservation 期间 pi core 还没进入 streaming；此时把 ! 当 steer 投进去，
    // streamingBehavior 会被忽略，反而并发开启第二个 run。必须等真实 agent_start。
    if (this.#dispatchReserved && !this.#agentActive) return true;
    return shouldDefer({
      streaming: this.isAgentActive,
      turnTarget: this.turnConversation,
      incomingTarget: this.#origins.conversationOf(messageId),
      deliverAs,
    });
  }

  /** 扣住一条消息。队列满时返回 false，由调用方当场回绝，不静默丢 */
  defer(messageId: string, chatId: string, text: string): boolean {
    return this.#deferred.push({ messageId, chatId, text });
  }

  /** 取一条扣住的消息去重新发起。回合彻底结束（agent_settled）后调用 */
  takeDeferred(): DeferredMessage | undefined {
    return this.#deferred.shift();
  }

  /** 取出全部扣住的消息 —— 停止桥接时要挨个告知，不能让人干等 */
  takeAllDeferred(): DeferredMessage[] {
    return this.#deferred.takeAll();
  }

  startTurn(): string | undefined {
    // 一次运行里自动重试会开多个回合，所以这行要在下面的去重之前 ——
    // 它跟的是 pi 的运行，不是飞书流
    const dispatchedMessageId = this.#dispatchMessageId;
    this.#agentActive = true;
    this.#dispatchReserved = false;
    this.#dispatchMessageId = undefined;
    this.#dispatchAccepted = false;
    if (this.#turn) return dispatchedMessageId;
    this.#turnApproved = false;
    // 出站目标不再是回合开始时快照下来的字符串，而是每次按认领到的
    // messageId 回查 —— 见 turnTarget / turnSendTarget
    const stream = new TurnStream();
    const rawQuestion = this.#origins.questionOf(this.#originMessageId);
    const question = rawQuestion?.trim() ? rawQuestion : this.#originPrompt;
    const heading = question?.trim() ? renderQuestion(question) : "";
    const turn: TurnState = {
      stream,
      startedAt: this.#now(),
      tokens: 0,
      transcript: heading,
      streamFailed: false,
      truncated: false,
      streaming: false,
      pumping: Promise.resolve(),
    };
    this.#turn = turn;
    // 先把问题放进队列再启动 pump：飞书一建卡就能看出它对应哪条消息，
    // 不必等模型吐出第一个 token；补发全文时也保留同一段上下文。
    stream.push(heading);
    // 有问题可显示 = 这一轮是飞书消息发起的，来源已经认领到了，立刻建卡（行为不变）。
    // heading 为空 = 认领不到来源（终端敲的字，或 pi-asd watcher 的推送）——
    // 这时**不能**急着建卡：pi 的 agent loop 是先发 agent_start、再发输入消息的
    // message_start，而「这是哪个子 agent 的推送」正是从后者认出来的。在这里定死
    // 目标，推送就永远只能落进默认收件方。反正也没内容可发，等有话说了再建。
    if (heading !== "") this.#startStreaming(turn);
    return dispatchedMessageId;
  }

  /**
   * 建卡并开始 pump。出站目标就是这一刻按 `turnSendTarget` 定死的，之后改不了 ——
   * 飞书的流式卡片一旦建在某个会话里就搬不走。所以这个调用要尽量晚，晚到
   * 「真的有内容要发」为止；见 startTurn 里那段。
   */
  #startStreaming(turn: TurnState): void {
    if (turn.streaming) return;
    turn.streaming = true;
    turn.pumping = this.#gateway
      .streamTurn(async (sink) => turn.stream.pump(sink), this.turnSendTarget)
      .catch((err) => {
        turn.streamFailed = true;
        this.#log(`飞书流式发送失败，将在回合结束后补发全文：${String(err)}`, "warning");
      });
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
    this.#pushFinal(renderTurnEnd(this.#now() - turn.startedAt, turn.tokens));
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
        await this.#gateway.sendText(turn.transcript, this.turnTarget);
      } catch (err) {
        this.#log(`补发全文也失败了，本回合内容仅存在于终端：${String(err)}`, "error");
      }
    }
  }

  /**
   * tool_call 钩子：危险则审批，拒绝则返回阻塞结果。
   *
   * `toolCallId` 用来把审批卡片弹回触发这次调用的那个对话（经登记表回查）。
   * 省略时退回本回合的目标 —— 老调用点和测试仍然能用。
   */
  async gateToolCall(
    toolName: string,
    input: Record<string, unknown>,
    tuiAsker: Asker | undefined,
    toolCallId?: string,
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

    // 审批卡片要弹回**触发这次调用**的那个对话。工具调用绑过消息就按它回查，
    // 否则退回本回合的目标 —— 弹错地方等于让不相干的人看见并批准
    const askTarget = this.#origins.targetOfToolCall(toolCallId ?? "") ?? this.turnSendTarget;
    const askers: Asker[] = [this.#gateway.askerFor(askTarget)];
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
