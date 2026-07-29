export interface InboundMessage {
  chatId: string;
  senderId: string;
  text: string;
  imageKeys: string[];
}
