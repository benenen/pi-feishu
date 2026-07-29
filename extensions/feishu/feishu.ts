import { createLarkChannel, LoggerLevel } from "@larksuiteoapi/node-sdk";
import type { LarkChannel } from "@larksuiteoapi/node-sdk";
import { createSdkLogger, type LogFn } from "./log.ts";
import { chatLabel } from "./renderer.ts";
import { isInvalidEmojiError } from "./reaction.ts";
import type { AppendSink } from "./turn-stream.ts";
import type { Asker } from "./approval.ts";
import type { Config } from "./config.ts";
import type { GatewayLike } from "./bridge.ts";
import type { InboundMessage } from "./types.ts";
import { ChatNameCache, toInbound } from "./inbound.ts";
import {
  ApprovalRegistry,
  askViaCard,
  buildSettledCard,
  handleCardAction,
  resolveTarget,
} from "./approval-card.ts";

export type { InboundMessage } from "./types.ts";

export class FeishuGateway implements GatewayLike {
  #channel: LarkChannel | undefined;
  #bound: string | undefined;
  #messageHandler: ((msg: InboundMessage) => void) | undefined;
  #approvals = new ApprovalRegistry();
  #chatNames = new ChatNameCache(
    async (chatId) => this.#channel?.getChatInfo(chatId),
    (msg, level) => this.#log(msg, level),
  );

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

    // 群名要单独查一次，所以这个 handler 是异步的。resolve 绝不 reject，
    // 也绝不打乱同一对话的消息顺序 —— 两条保证都在 ChatNameCache 里
    channel.on("message", async (msg) => {
      const chatName = await this.#chatNames.resolve(msg.chatId, msg.chatType);
      this.#messageHandler?.(toInbound(msg, chatName));
    });

    // 解析 / 鉴权 / 兑现全在 approval-card.ts 的 handleCardAction 里，
    // 与 broker 档共用同一份实现 —— 这段安全代码曾经是两份副本并且漂过一次。
    //
    // requireBoundChat 只在单会话档开：multiChat 下卡片本来就是故意发到触发
    // 这轮的那个对话（可能是群），而 bound 还留在私聊 —— 要求「必须来自已绑定
    // 会话」的话，群里那张卡片谁都点不动，审批直接死锁到超时。
    //
    // 关掉它不等于放开鉴权，另两层都在，而且都比它更严：
    //   - approverAllowlist：防「群里随便谁点允许」，这层一步不能少
    //   - 逐卡的会话绑定：卡片发往哪个对话，就只认那个对话里的点击（registry
    //     在 settle 那层强制，任何调用方绕不过去）—— 比「必须是当前绑定会话」更准
    channel.on("cardAction", (evt) => {
      const settlement = handleCardAction({
        registry: this.#approvals,
        event: evt,
        approverAllowlist: this.#config.approverAllowlist,
        requireBoundChat: !this.#config.multiChat,
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

  /** to 省略时发往已绑定会话；多会话模式下由 Bridge 传入本回合的来源 */
  async streamTurn(run: (sink: AppendSink) => Promise<void>, to?: string): Promise<void> {
    const channel = this.#channel;
    const target = resolveTarget(this.#bound, to);
    // 未绑定时 target 为空是常态（终端自己在干活，没人从飞书说过话），静默跳过
    if (!channel || !target) return;
    await channel.stream(target, { markdown: async (controller) => run(controller) });
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

  /** 加表情回应。失败只记日志 —— 已读信号发不出去，不该连消息都处理不了 */
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

  /**
   * 面向指定会话的审批通道。卡片的发送/登记/竞速收尾与 broker 档共用。
   * to 省略时发往已绑定会话；多会话模式下由 Bridge 传入本回合的来源。
   */
  askerFor(to?: string): Asker {
    return async (req, signal) => {
      const channel = this.#channel;
      const target = resolveTarget(this.#bound, to);
      if (!channel || !target) throw new Error("飞书未连接或未绑定会话");
      return askViaCard({
        registry: this.#approvals,
        chatId: target,
        req,
        signal,
        send: async (chatId, card) => (await channel.send(chatId, { card })).messageId,
        settleCard: (messageId, status) => this.#settleCard(messageId, status),
      });
    };
  }

  async #settleCard(messageId: string, status: string): Promise<void> {
    try {
      await this.#channel?.updateCard(messageId, buildSettledCard(status));
    } catch (err) {
      this.#log(`审批卡片收尾失败：${String(err)}`, "error");
    }
  }
}
