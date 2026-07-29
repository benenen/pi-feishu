import { chatLabel } from "./renderer.ts";
import type { LogFn } from "./log.ts";
import type { InboundMessage } from "./types.ts";

export type ChatType = "p2p" | "group";

/** SDK 的 NormalizedMessage 里本扩展用得上的那部分 */
export interface NormalizedLike {
  messageId: string;
  chatId: string;
  chatType?: ChatType;
  senderId: string;
  senderName?: string;
  content: string;
  resources: ReadonlyArray<{ type: string; fileKey: string }>;
}

/**
 * SDK 消息 → 本扩展的 InboundMessage。direct 与 broker 两档共用同一份映射。
 *
 * 抽出来是因为 InboundMessage 的字段基本都是可选或同类型的，两边各写一份时
 * 漏掉一个字段 TypeScript 一声不吭 —— `to` 参数就是这么丢的（见 gateway-arity.test.ts）。
 */
export function toInbound(msg: NormalizedLike, chatName: string | undefined): InboundMessage {
  return {
    messageId: msg.messageId,
    chatId: msg.chatId,
    chatName,
    senderId: msg.senderId,
    senderName: msg.senderName,
    text: msg.content,
    imageKeys: msg.resources.filter((r) => r.type === "image").map((r) => r.fileKey),
  };
}

export interface ChatInfoLike {
  name?: string;
  chatType?: ChatType;
}

/**
 * 会话名称缓存。
 *
 * 飞书的消息事件**不带**会话名称（只有 senderName），群名得单独调 `getChatInfo`。
 * 这个调用插在「收到消息」和「投给 pi」之间，所以三件事必须成立：
 *
 * 1. **按 chatId 缓存** —— 否则每条消息一次网络请求，只为了一个展示用的字段。
 *    代价是会话改名在本进程生命周期内不会被察觉，对日志来说可以接受。
 * 2. **私聊不查** —— 私聊在飞书那边没有名字（chat.get 的 name 返回 null），
 *    查了必然是空。
 * 3. **缓存的是 Promise 而不是结果** —— 同一对话紧挨着的两条消息会共用同一次
 *    查询，并按 await 的注册顺序恢复。各查各的话，后到的消息可能先拿到结果，
 *    两句话就倒着进了 agent 上下文。
 */
export class ChatNameCache {
  #cache = new Map<string, Promise<string>>();

  // strip-only 模式不支持构造函数参数属性，依赖写成显式字段
  readonly #lookup: (chatId: string) => Promise<ChatInfoLike | undefined>;
  readonly #log: LogFn | undefined;

  constructor(lookup: (chatId: string) => Promise<ChatInfoLike | undefined>, log?: LogFn) {
    this.#lookup = lookup;
    this.#log = log;
  }

  resolve(chatId: string, chatType?: ChatType): Promise<string> {
    const hit = this.#cache.get(chatId);
    if (hit) return hit;
    const pending = this.#fetch(chatId, chatType);
    this.#cache.set(chatId, pending);
    return pending;
  }

  /** 绝不 reject —— 查不到名字是小事，让消息处理不下去是大事 */
  async #fetch(chatId: string, chatType?: ChatType): Promise<string> {
    const fallback = chatLabel({ chatType });
    if (chatType === "p2p") return fallback;
    try {
      const info = await this.#lookup(chatId);
      if (info) return chatLabel(info);
    } catch (err) {
      // 失败的结果同样会被缓存，所以这句每个对话最多出现一次，不会刷屏
      this.#log?.(`查询会话名称失败 ${chatId}：${String(err)}`, "warning");
    }
    return fallback;
  }
}
