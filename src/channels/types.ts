export interface InboundMessage {
  channelType: string;
  chatId: string;
  senderId: string;
  senderName: string;
  messageId: string;
  text: string;
  isGroup: boolean;
  threadId?: string;
  replyToMessageId?: string;
  attachments?: Attachment[];
  raw: unknown;
}

export interface Attachment {
  type: "photo" | "document" | "audio" | "voice" | "video";
  fileId: string;
  fileName?: string;
  mimeType?: string;
  localPath?: string;
}

export interface OutboundMessage {
  chatId: string;
  text: string;
  parseMode?: "html" | "markdown";
  replyToMessageId?: string;
  attachments?: OutboundAttachment[];
}

export interface OutboundAttachment {
  type: "file" | "photo";
  path: string;
  caption?: string;
}

export type MessageHandler = (msg: InboundMessage) => Promise<void>;
export type CommandHandler = (msg: InboundMessage) => Promise<void>;

export interface ChannelAdapter {
  readonly type: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  send(msg: OutboundMessage): Promise<string>;
  editMessage(chatId: string, messageId: string, text: string): Promise<void>;
  onMessage(handler: MessageHandler): void;
  onCommand(command: string, handler: CommandHandler): void;
  sendTyping(chatId: string): Promise<void>;
}
