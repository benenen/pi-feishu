import { createLarkChannel, LoggerLevel } from "@larksuiteoapi/node-sdk";
import type { LarkChannel } from "@larksuiteoapi/node-sdk";
import { createSdkLogger, type LogFn } from "../log.ts";
import { chatLabel } from "../renderer.ts";
import { isInvalidEmojiError } from "../reaction.ts";
import type { AppendSink } from "../turn-stream.ts";
import type { ApprovalRequest, Decision } from "../approval.ts";
import type { Config } from "../config.ts";
import {
  ApprovalRegistry,
  askViaCard,
  buildSettledCard,
  handleCardAction,
} from "../approval-card.ts";
import type { BrokerChannelLike } from "./server.ts";
import type { InboundMessage } from "../types.ts";

/**
 * 与 FeishuGateway 的区别：**不持有 bound 概念**。broker 服务所有对话，
 * 收件人一律由调用方显式传入，绑定关系记在 SessionRegistry 里。
 */
export class BrokerChannel implements BrokerChannelLike {
  #channel: LarkChannel | undefined;
  #messageHandler: ((msg: InboundMessage) => void) | undefined;
  #approvals = new ApprovalRegistry();

  readonly #config: Config;
  readonly #log: LogFn;

  constructor(config: Config, log: LogFn) {
    this.#config = config;
    this.#log = log;
  }

  onMessage(handler: (msg: InboundMessage) => void): void {
    this.#messageHandler = handler;
  }

  async connect(): Promise<void> {
    if (this.#channel) return;
    const channel = createLarkChannel({
      appId: this.#config.appId,
      appSecret: this.#config.appSecret,
      transport: "websocket",
      source: "pi-feishu-broker",
      policy: {
        dmMode: this.#config.dmMode,
        dmAllowlist: this.#config.dmAllowlist,
        groupAllowlist: this.#config.groupAllowlist,
        requireMention: this.#config.requireMention,
        respondToMentionAll: false,
      },
      outbound: { markdownConverter: "builtin" },
      logger: createSdkLogger(this.#log),
      loggerLevel: LoggerLevel.warn,
    });

    channel.on("message", (msg) => {
      this.#messageHandler?.({
        messageId: msg.messageId,
        chatId: msg.chatId,
        senderId: msg.senderId,
        text: msg.content,
        imageKeys: msg.resources.filter((r) => r.type === "image").map((r) => r.fileKey),
      });
    });

    // 与 direct 档共用 handleCardAction —— 这段安全代码曾经是两份副本，
    // 而 broker 那份把会话校验整个漏掉了。
    // 这里不传 requireBoundChat：一个 broker 服务多个对话，「当前绑定」是每个
    // pi 会话各自的概念，不在这一层；会话这一层由登记时记下的 chatId 兜住 ——
    // 卡片发往哪个对话，就只认那个对话里的点击。
    channel.on("cardAction", (evt) => {
      const settlement = handleCardAction({
        registry: this.#approvals,
        event: evt,
        approverAllowlist: this.#config.approverAllowlist,
        log: this.#log,
      });
      if (settlement) void this.#settleCard(settlement.messageId, settlement.status);
    });

    channel.on("reject", (evt) => this.#log(`飞书拒收消息：${evt.reason}`, "warning"));
    channel.on("error", (err) => this.#log(`飞书错误：${err.code} ${err.message}`, "error"));
    channel.on("reconnecting", () => this.#log("飞书连接断开，重连中", "warning"));
    channel.on("reconnected", () => this.#log("飞书连接已恢复"));

    await channel.connect();
    this.#channel = channel;
  }

  async disconnect(): Promise<void> {
    const stranded = this.#approvals.cancelAll({ allow: false, reason: "broker 已停止" });
    for (const messageId of stranded) await this.#settleCard(messageId, "broker 已停止");
    const channel = this.#channel;
    this.#channel = undefined;
    if (channel) {
      await channel.disconnect().catch((err: unknown) => {
        this.#log(`飞书断开连接时出错：${String(err)}`, "warning");
      });
    }
  }

  async sendText(chatId: string, markdown: string): Promise<void> {
    await this.#channel?.send(chatId, { markdown });
  }

  async streamTo(chatId: string, run: (sink: AppendSink) => Promise<void>): Promise<void> {
    const channel = this.#channel;
    if (!channel) return;
    await channel.stream(chatId, { markdown: async (controller) => run(controller) });
  }

  /** 表情 key 填错时飞书每次都报 231001，且 SDK 会打一坨 axios 转储 —— 认出来就别再试 */
  #reactionDisabled = false;

  async react(messageId: string, emoji: string): Promise<void> {
    if (emoji === "" || this.#reactionDisabled) return;
    try {
      await this.#channel?.addReaction(messageId, emoji);
    } catch (err) {
      if (isInvalidEmojiError(err)) {
        this.#reactionDisabled = true;
        this.#log(
          `表情 key「${emoji}」不被飞书接受，已停止加表情回应。` +
            `改 readReceiptEmoji 换一个（例如 GLANCE），或置空关闭该功能。`,
          "warning",
        );
        return;
      }
      this.#log(`加表情回应失败（${emoji}）：${String(err)}`, "warning");
    }
  }

  async downloadImage(fileKey: string): Promise<Buffer | undefined> {
    try {
      return await this.#channel?.downloadResource(fileKey, "image");
    } catch (err) {
      this.#log(`图片下载失败 ${fileKey}：${String(err)}`, "warning");
      return undefined;
    }
  }

  async describeChat(chatId: string): Promise<string | undefined> {
    try {
      const info = await this.#channel?.getChatInfo(chatId);
      return info ? chatLabel(info) : undefined;
    } catch (err) {
      this.#log(`查询会话名称失败：${String(err)}`, "warning");
      return undefined;
    }
  }

  /** 卡片的发送/登记/竞速收尾与 direct 档共用，两边只是收件会话的来源不同 */
  async askCard(chatId: string, req: ApprovalRequest, signal: AbortSignal): Promise<Decision> {
    const channel = this.#channel;
    if (!channel) throw new Error("飞书未连接");
    return askViaCard({
      registry: this.#approvals,
      chatId,
      req,
      signal,
      send: async (to, card) => (await channel.send(to, { card })).messageId,
      settleCard: (messageId, status) => this.#settleCard(messageId, status),
    });
  }

  async #settleCard(messageId: string, status: string): Promise<void> {
    try {
      await this.#channel?.updateCard(messageId, buildSettledCard(status));
    } catch (err) {
      this.#log(`审批卡片收尾失败：${String(err)}`, "error");
    }
  }
}
