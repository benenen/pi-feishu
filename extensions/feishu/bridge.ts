import fs from "node:fs";
import type { AppendSink } from "./turn-stream.ts";
import { TurnStream } from "./turn-stream.ts";
import { assessRisk, type PathResolver } from "./risk.ts";
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

export interface GatewayLike {
  boundChatId?: string;
  bind(chatId: string): void;
  onMessage(handler: (msg: InboundMessage) => void): void;
  streamTurn(run: (sink: AppendSink) => Promise<void>): Promise<void>;
  sendText(markdown: string, to?: string): Promise<void>;
  downloadImage(fileKey: string): Promise<Buffer | undefined>;
  cardAsker: Asker;
}

export type ControlCommand = { kind: "status" } | { kind: "stop" } | { kind: "help" };

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

export function shouldAccept(gateway: { boundChatId?: string }, chatId: string): boolean {
  return gateway.boundChatId === undefined || gateway.boundChatId === chatId;
}

/** 文件可能尚未存在（write 新文件），此时退回原路径 */
export const realPathOrSelf: PathResolver = (p) => {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return p;
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
  #toolStartedAt = new Map<string, number>();

  /** ExtensionAPI 不暴露流式状态，这里自己跟踪 */
  get isStreaming(): boolean {
    return this.#turn !== undefined;
  }

  // strip-only 模式不支持构造函数参数属性，依赖写成显式字段
  readonly #config: Config;
  readonly #gateway: GatewayLike;
  readonly #log: (msg: string) => void;
  readonly #now: () => number;

  constructor(
    config: Config,
    gateway: GatewayLike,
    log: (msg: string) => void,
    now: () => number = () => Date.now(),
  ) {
    this.#config = config;
    this.#gateway = gateway;
    this.#log = log;
    this.#now = now;
  }

  /** 出站一律不得把异常抛回 pi 的事件循环 */
  #safe(fn: () => void): void {
    try {
      fn();
    } catch (err) {
      this.#log(`出站渲染失败：${String(err)}`);
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

  startTurn(): void {
    if (this.#turn) return;
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
      .streamTurn(async (sink) => stream.pump(sink))
      .catch((err) => {
        turn.streamFailed = true;
        this.#log(`飞书流式发送失败，将在回合结束后补发全文：${String(err)}`);
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
    this.#push(renderTurnEnd(this.#now() - turn.startedAt, turn.tokens));
    this.#turn = undefined;
    this.#toolStartedAt.clear();
    turn.stream.finish();
    await turn.pumping;

    // 流式卡片废了（断线/限流/元素超限）时，把全文作为普通消息补发一次
    if (turn.streamFailed && turn.transcript.trim() !== "") {
      try {
        await this.#gateway.sendText(turn.transcript);
      } catch (err) {
        this.#log(`补发全文也失败了，本回合内容仅存在于终端：${String(err)}`);
      }
    }
  }

  /** tool_call 钩子：危险则审批，拒绝则返回阻塞结果 */
  async gateToolCall(
    toolName: string,
    input: Record<string, unknown>,
    tuiAsker: Asker | undefined,
  ): Promise<{ block: true; reason: string } | undefined> {
    const risk = assessRisk({
      toolName,
      input,
      mode: this.#config.approvalMode,
      repoRoot: this.#config.repoRoot,
      resolvePath: realPathOrSelf,
    });
    if (risk === "safe") return undefined;

    const askers: Asker[] = [this.#gateway.cardAsker];
    if (tuiAsker) askers.push(tuiAsker);

    let decision: Decision;
    try {
      decision = await requestApproval(
        { toolName, input },
        askers,
        this.#config.approvalTimeoutMs,
      );
    } catch (err) {
      this.#log(`审批流程异常，按拒绝处理：${String(err)}`);
      decision = { allow: false, reason: "审批流程异常" };
    }

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
