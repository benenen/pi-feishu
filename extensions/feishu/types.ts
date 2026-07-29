export interface InboundMessage {
  /** 用于给这条消息加表情回应 */
  messageId: string;
  chatId: string;
  senderId: string;
  text: string;
  imageKeys: string[];
}
