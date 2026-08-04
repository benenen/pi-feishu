export interface InboundMessage {
  /** 用于给这条消息加表情回应 */
  messageId: string;
  chatId: string;
  /**
   * 会话的人类可读名称。私聊恒为「私聊」（飞书那边私聊没有名字），
   * 群名查不到时退回「群聊」。纯展示用 —— 路由一律认 chatId
   */
  chatName?: string;
  senderId: string;
  /** 发送者昵称，SDK 没给就留空，绝不编一个 */
  senderName?: string;
  text: string;
  imageKeys: string[];
  /**
   * 话题 id。**只有话题里的消息才有** —— 普通群和私聊为空。
   *
   * 出站靠它决定要不要回进话题：有值就以「回复触发这轮的那条消息 +
   * reply_in_thread」的方式发，答案才落在提问的那个话题下；没值就照旧直接发进
   * 会话。不能一律按话题发 —— 普通群里那样会把每条回答都变成一个新话题。
   */
  threadId?: string;
}

/**
 * 一次出站要发去哪儿。`chatId` 之外的两项只在话题场景下有值。
 *
 * 用对象而不是再加两个位置参数：`GatewayLike` 的方法是方法语法，参数逆变检查
 * 是双变的，实现少写一个可选参数编译期一声不吭（`gateway-arity.test.ts` 就是
 * 为这个而生）。多带的字段被实现忽略时，至少不会静默发错地方。
 */
export interface SendTarget {
  chatId: string;
  /** 回复挂在哪条消息上。走 im.v1.message.reply 而不是 message.create */
  replyTo?: string;
  /** 是否回进话题 */
  inThread?: boolean;
}
