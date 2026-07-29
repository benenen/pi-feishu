export interface MessageOrigin {
  messageId: string;
  chatId: string;
  senderId: string;
  /** 登记时刻，排查时用 */
  ts: number;
}

/**
 * 记录上限。一条记录几十字节，但长会话能跑几天，不设上限就是慢性泄漏。
 * 只有「还没被认领的消息」和「当前回合正在用的那条」有意义，几百条绰绰有余。
 */
export const MAX_ORIGINS = 200;

/**
 * 入站消息的来源登记表：`messageId → { chatId, senderId, ts }`。
 *
 * ## 为什么需要「按原文认领」这一步
 *
 * 出站要知道「这个回合该发回哪个对话」。pi 在 `agent_start` 上**不提供**触发它的
 * 消息标识（`AgentStartEvent` 是空对象），`sendUserMessage` 也收不了元数据 ——
 * 光有 messageId → chatId 的表，没有钥匙去查它。
 *
 * 唯一的钥匙是 `before_agent_start` 事件带的 `prompt`：它就是
 * `sendUserMessage` 收到的那个字符串（走的是 `expandPromptTemplates: false`，
 * pi 不会改写），且**恰好在 `agent_start` 之前**发出。所以登记时连原文一起记，
 * 回合开始前用原文认领，就把「回合」和「消息」对上了。
 *
 * 认领是**一次性**的：同一条原文认过就不再认，否则下一个回合会把上一轮的消息
 * 再认一遍。两个对话发一模一样的话时按先来后到分配。
 *
 * 认领**不删记录** —— 整个回合的出站（流式、补发全文、审批卡片）都还要按
 * messageId 查回对话。真正的清理靠上限淘汰和 `forget`。
 *
 * ## 已知边界
 *
 * `before_agent_start` 只对**触发回合**的消息发。排队进来的（steer/followUp）
 * 并入正在跑的那个运行，不会再发一次，因此认领不到 —— 但那也没有第二个目的地
 * 可发，它们本来就该走当前回合的流。跨对话的消息由 `deferred.ts` 扣住、
 * 单独成回合，所以不会走到这个缺口上。
 */
export class MessageOriginRegistry {
  /** 插入序即淘汰序 —— Map 的迭代顺序就是插入顺序 */
  #byMessage = new Map<string, MessageOrigin>();
  /** 发给 pi 的原文 → 尚未认领的 messageId 队列（同文按先来后到） */
  #unclaimed = new Map<string, string[]>();
  #byToolCall = new Map<string, string>();

  // strip-only 模式不支持构造函数参数属性，依赖写成显式字段
  readonly #now: () => number;

  constructor(now: () => number = () => Date.now()) {
    this.#now = now;
  }

  get size(): number {
    return this.#byMessage.size;
  }

  /**
   * 入站消息一到就登记，在任何放行判定之前 —— 被挡掉的消息也要有来源，
   * 否则回绝的话发不回去。
   *
   * 原文是可选的：入站那一刻还没算出发给 pi 的 prompt（要下图片、要剥 `!` 前缀），
   * 算出来之后再调 `indexPrompt` 补上。
   */
  record(
    msg: { messageId: string; chatId: string; senderId: string },
    promptText?: string,
  ): void {
    this.#byMessage.set(msg.messageId, {
      messageId: msg.messageId,
      chatId: msg.chatId,
      senderId: msg.senderId,
      ts: this.#now(),
    });
    if (promptText !== undefined) this.indexPrompt(msg.messageId, promptText);

    while (this.#byMessage.size > MAX_ORIGINS) {
      const oldest = this.#byMessage.keys().next();
      if (oldest.done) break;
      this.forget(oldest.value);
    }
  }

  /** 登记「这条消息最终发给 pi 的原文」，供 before_agent_start 认领 */
  indexPrompt(messageId: string, promptText: string): void {
    const queue = this.#unclaimed.get(promptText);
    if (queue) queue.push(messageId);
    else this.#unclaimed.set(promptText, [messageId]);
  }

  /**
   * 按发给 pi 的原文认领触发这轮的消息。认不到返回 undefined —— 终端敲的字
   * 走的也是这条路，此时必须是「没有来源」，退回「最近那条」会把终端的回合
   * 发进飞书上一个对话。
   */
  claimByPrompt(prompt: string): MessageOrigin | undefined {
    const queue = this.#unclaimed.get(prompt);
    if (!queue) return undefined;
    for (;;) {
      const messageId = queue.shift();
      if (queue.length === 0) this.#unclaimed.delete(prompt);
      if (messageId === undefined) return undefined;
      // 已被上限淘汰掉的索引直接跳过，不能认领一条查不到的消息
      const origin = this.#byMessage.get(messageId);
      if (origin) return origin;
      if (queue.length === 0) return undefined;
    }
  }

  chatOf(messageId: string | undefined): string | undefined {
    if (messageId === undefined) return undefined;
    return this.#byMessage.get(messageId)?.chatId;
  }

  /** 把工具调用绑到触发它的消息，让审批卡片能弹回原始对话 */
  bindToolCall(toolCallId: string, messageId: string | undefined): void {
    if (messageId === undefined) return;
    this.#byToolCall.set(toolCallId, messageId);
  }

  chatOfToolCall(toolCallId: string): string | undefined {
    return this.chatOf(this.#byToolCall.get(toolCallId));
  }

  /** 清掉一条记录及挂在它上面的工具调用绑定 */
  forget(messageId: string): void {
    this.#byMessage.delete(messageId);
    for (const [toolCallId, mid] of this.#byToolCall) {
      if (mid === messageId) this.#byToolCall.delete(toolCallId);
    }
    for (const [prompt, queue] of this.#unclaimed) {
      const at = queue.indexOf(messageId);
      if (at === -1) continue;
      queue.splice(at, 1);
      if (queue.length === 0) this.#unclaimed.delete(prompt);
    }
  }
}
