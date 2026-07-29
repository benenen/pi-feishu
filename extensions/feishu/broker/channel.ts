import { randomUUID } from "node:crypto";
import { createLarkChannel, LoggerLevel } from "@larksuiteoapi/node-sdk";
import type { LarkChannel } from "@larksuiteoapi/node-sdk";
import { createSdkLogger, type LogFn } from "../log.ts";
import { chatLabel } from "../renderer.ts";
import type { AppendSink } from "../turn-stream.ts";
import type { ApprovalRequest, Decision } from "../approval.ts";
import type { Config } from "../config.ts";
import {
  ApprovalRegistry,
  buildApprovalCard,
  buildSettledCard,
  parseApprovalAction,
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
        chatId: msg.chatId,
        senderId: msg.senderId,
        text: msg.content,
        imageKeys: msg.resources.filter((r) => r.type === "image").map((r) => r.fileKey),
      });
    });

    channel.on("cardAction", (evt) => {
      const action = parseApprovalAction(evt.action.value);
      if (!action) return;
      // 卡片回调不经飞书的策略管道，必须自己鉴权；
      // broker 服务多个对话，所以只校验操作人，不校验 chatId
      if (!this.#config.approverAllowlist.includes(evt.operator.openId)) {
        this.#log(`忽略非授权审批人的卡片点击：${evt.operator.openId}`, "warning");
        return;
      }
      const messageId = this.#approvals.settle(action.id, {
        allow: action.allow,
        reason: action.scope === "turn" ? "飞书批准（本回合全部允许）" : action.allow ? "飞书批准" : "飞书拒绝",
        ...(action.scope === "turn" ? { scope: "turn" as const } : {}),
      });
      if (messageId) {
        void this.#settleCard(
          messageId,
          action.scope === "turn" ? "已批准（本回合全部允许）" : action.allow ? "已批准" : "已拒绝",
        );
      }
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

  async askCard(chatId: string, req: ApprovalRequest, signal: AbortSignal): Promise<Decision> {
    const channel = this.#channel;
    if (!channel) throw new Error("飞书未连接");
    if (signal.aborted) return { allow: false, reason: "已由其他通道处理" };

    let aborted = false;
    let onAbort: (() => void) | undefined;
    const abortedEarly = new Promise<void>((resolve) => {
      onAbort = () => {
        aborted = true;
        resolve();
      };
      signal.addEventListener("abort", onAbort, { once: true });
    });

    const id = `ap-${randomUUID()}`;
    try {
      const result = await channel.send(chatId, { card: buildApprovalCard(id, req) });
      if (aborted) {
        await this.#settleCard(result.messageId, "已在终端处理");
        return { allow: false, reason: "已由其他通道处理" };
      }
      const pending = this.#approvals.register(id, result.messageId);
      void abortedEarly.then(() => {
        const messageId = this.#approvals.cancel(id, { allow: false, reason: "已由其他通道处理" });
        if (messageId) void this.#settleCard(messageId, "已在终端处理");
      });
      return await pending;
    } finally {
      if (onAbort) signal.removeEventListener("abort", onAbort);
    }
  }

  async #settleCard(messageId: string, status: string): Promise<void> {
    try {
      await this.#channel?.updateCard(messageId, buildSettledCard(status));
    } catch (err) {
      this.#log(`审批卡片收尾失败：${String(err)}`, "error");
    }
  }
}
