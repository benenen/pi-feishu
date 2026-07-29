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
}
