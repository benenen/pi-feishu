import { randomUUID } from "node:crypto";
import { createLarkChannel, LoggerLevel } from "@larksuiteoapi/node-sdk";
import type { LarkChannel } from "@larksuiteoapi/node-sdk";
import { createSdkLogger, type LogFn } from "./log.ts";
import type { AppendSink } from "./turn-stream.ts";
import type { Asker, Decision } from "./approval.ts";
import type { Config } from "./config.ts";
import {
  ApprovalRegistry,
  buildApprovalCard,
  buildSettledCard,
  parseApprovalAction,
  resolveTarget,
} from "./approval-card.ts";

export interface InboundMessage {
  chatId: string;
  senderId: string;
  text: string;
  imageKeys: string[];
}

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

    channel.on("cardAction", (evt) => {
      const action = parseApprovalAction(evt.action.value);
      if (!action) return;

      // 飞书 SDK 只对 im.message.receive_v1 走完整的策略管道；
      // card.action.trigger 只有去重和串行化，没有任何白名单过滤。
      // 不自己鉴权的话，群里任何看得见卡片的人都能点「允许」——
      // 让 agent 干活的人自己批准自己，闸门等于没有。
      if (evt.chatId !== this.#bound) {
        this.#log(`忽略来自未绑定会话的卡片点击：${evt.chatId}`, "warning");
        return;
      }
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

  async downloadImage(fileKey: string): Promise<Buffer | undefined> {
    try {
      return await this.#channel?.downloadResource(fileKey, "image");
    } catch (err) {
      this.#log(`图片下载失败 ${fileKey}：${String(err)}`, "warning");
      return undefined;
    }
  }

  /** 供 requestApproval 使用的飞书通道 */
  cardAsker: Asker = async (req, signal) => {
    const channel = this.#channel;
    const to = this.#bound;
    if (!channel || !to) throw new Error("飞书未连接或未绑定会话");

    // 竞速可能在卡片还没发出去时就被别的通道结束掉。abort 事件不会补发给
    // 事后才挂上的监听器，所以必须在 await 之前就把它接住。
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

    // 随机 id：每实例从 1 开始重编号的话，旧会话残留的卡片被点一下
    // 就会兑现新会话的 ap-1 —— 操作员从未见过的审批被凭空批准
    const id = `ap-${randomUUID()}`;
    try {
      const result = await channel.send(to, { card: buildApprovalCard(id, req) });

      if (aborted) {
        // 竞速已结束，这张卡片刚发出来就作废，直接收到终态
        await this.#settleCard(result.messageId, "已在终端处理");
        return { allow: false, reason: "已由其他通道处理" };
      }

      const pending = this.#approvals.register(id, result.messageId);
      void abortedEarly.then(() => {
        const messageId = this.#approvals.cancel(id, {
          allow: false,
          reason: "已由其他通道处理",
        });
        if (messageId) void this.#settleCard(messageId, "已在终端处理");
      });

      return await pending;
    } finally {
      if (onAbort) signal.removeEventListener("abort", onAbort);
    }
  };

  async #settleCard(messageId: string, status: string): Promise<void> {
    try {
      await this.#channel?.updateCard(messageId, buildSettledCard(status));
    } catch (err) {
      this.#log(`审批卡片收尾失败：${String(err)}`, "error");
    }
  }
}
