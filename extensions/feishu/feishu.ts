import { createLarkChannel, LoggerLevel } from "@larksuiteoapi/node-sdk";
import type { LarkChannel } from "@larksuiteoapi/node-sdk";
import { createSdkLogger, type LogFn } from "./log.ts";
import { chatLabel } from "./renderer.ts";
import type { AppendSink } from "./turn-stream.ts";
import type { Asker } from "./approval.ts";
import type { Config } from "./config.ts";
import type { InboundMessage } from "./types.ts";
import {
  ApprovalRegistry,
  askViaCard,
  buildSettledCard,
  handleCardAction,
  resolveTarget,
} from "./approval-card.ts";

export type { InboundMessage } from "./types.ts";

export class FeishuGateway {
  #channel: LarkChannel | undefined;
  #bound: string | undefined;
  #messageHandler: ((msg: InboundMessage) => void) | undefined;
  #approvals = new ApprovalRegistry();

  // strip-only 模式不支持构造函数参数属性，依赖写成显式字段
  readonly #config: Config;
  readonly #log: LogFn;

  constructor(config: Config, log: LogFn) {
    this.#config = config;
    this.#log = log;
  }

  get boundChatId(): string | undefined {
    return this.#bound;
  }

  bind(chatId: string): void {
    this.#bound = chatId;
  }

  unbind(): void {
    this.#bound = undefined;
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
      source: "pi-feishu",
      policy: {
        dmMode: this.#config.dmMode,
        dmAllowlist: this.#config.dmAllowlist,
        groupAllowlist: this.#config.groupAllowlist,
        requireMention: this.#config.requireMention,
        respondToMentionAll: false,
      },
      outbound: { markdownConverter: "builtin" },
      // 不接管的话 SDK 用 defaultLogger，直接写 console.log —— 绕过 pi 的 UI 打进 TUI。
      // level 压到 warn：连接生命周期我们自己在下面已经报了，SDK 的 info 只是重复刷屏
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

    // 解析 / 鉴权 / 兑现全在 approval-card.ts 的 handleCardAction 里，
    // 与 broker 档共用同一份实现 —— 这段安全代码曾经是两份副本并且漂过一次。
    // direct 档额外要求点击来自**当前**绑定的会话（requireBoundChat）。
    channel.on("cardAction", (evt) => {
      const settlement = handleCardAction({
        registry: this.#approvals,
        event: evt,
        approverAllowlist: this.#config.approverAllowlist,
        requireBoundChat: true,
        boundChatId: this.#bound,
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
    // 会话结束时所有未决审批一律拒绝，并把卡片收到终态 ——
    // 否则飞书里会永远留着一张还带「允许/拒绝」按钮的卡片
    const stranded = this.#approvals.cancelAll({ allow: false, reason: "会话已结束" });
    for (const messageId of stranded) {
      await this.#settleCard(messageId, "会话已结束");
    }
    const channel = this.#channel;
    this.#channel = undefined;
    this.#bound = undefined;
    if (channel) {
      await channel.disconnect().catch((err: unknown) => {
        this.#log(`飞书断开连接时出错：${String(err)}`, "warning");
      });
    }
  }

  async streamTurn(run: (sink: AppendSink) => Promise<void>): Promise<void> {
    const channel = this.#channel;
    const to = this.#bound;
    if (!channel || !to) return;
    await channel.stream(to, { markdown: async (controller) => run(controller) });
  }

  /** to 省略时发往已绑定会话；回绝陌生会话时必须显式传对方 chatId */
  async sendText(markdown: string, to?: string): Promise<void> {
    const channel = this.#channel;
    const target = resolveTarget(this.#bound, to);
    if (!channel || !target) return;
    await channel.send(target, { markdown });
  }

  /**
   * 已绑定会话的人类可读名称。查不到就返回 undefined —— 状态里退回只显示 id，
   * 绝不能让一次状态查询因为这个可有可无的信息而失败。
   */
  async describeBoundChat(): Promise<string | undefined> {
    const channel = this.#channel;
    const bound = this.#bound;
    if (!channel || !bound) return undefined;
    try {
      const info = await channel.getChatInfo(bound);
      return chatLabel(info);
    } catch (err) {
      this.#log(`查询会话名称失败：${String(err)}`, "warning");
      return undefined;
    }
  }

  /**
   * 主动私信某人，返回该私聊会话的 chatId。
   *
   * 走 rawClient 而不是 channel.send()，是因为后者只回 messageId ——
   * 而主动绑定需要的正是 chat_id，im.v1.message.create 的响应里就带着它，
   * 一次调用拿全，不用再多查一次消息。
   */
  async announce(openId: string, text: string): Promise<string | undefined> {
    const channel = this.#channel;
    if (!channel) return undefined;
    const res = await channel.rawClient.im.v1.message.create({
      data: {
        receive_id: openId,
        msg_type: "text",
        content: JSON.stringify({ text }),
      },
      params: { receive_id_type: "open_id" },
    });
    return res.data?.chat_id;
  }

  async downloadImage(fileKey: string): Promise<Buffer | undefined> {
    try {
      return await this.#channel?.downloadResource(fileKey, "image");
    } catch (err) {
      this.#log(`图片下载失败 ${fileKey}：${String(err)}`, "warning");
      return undefined;
    }
  }

  /** 供 requestApproval 使用的飞书通道。卡片的发送/登记/竞速收尾与 broker 档共用 */
  cardAsker: Asker = async (req, signal) => {
    const channel = this.#channel;
    const to = this.#bound;
    if (!channel || !to) throw new Error("飞书未连接或未绑定会话");
    return askViaCard({
      registry: this.#approvals,
      chatId: to,
      req,
      signal,
      send: async (chatId, card) => (await channel.send(chatId, { card })).messageId,
      settleCard: (messageId, status) => this.#settleCard(messageId, status),
    });
  };

  async #settleCard(messageId: string, status: string): Promise<void> {
    try {
      await this.#channel?.updateCard(messageId, buildSettledCard(status));
    } catch (err) {
      this.#log(`审批卡片收尾失败：${String(err)}`, "error");
    }
  }
}
