export interface Session {
  sessionId: string;
  chatId: string;
  threadId?: string;
  channelType: string;
  claudeSessionId?: string;
  createdAt: number;
  lastActiveAt: number;
  title?: string;
  isActive: boolean;
  sessionNum: number;
  isGroup?: boolean;
}

export interface ChatSessionState {
  chatId: string;
  threadId?: string;
  activeSessionId: string;
  sessions: Session[];
}
