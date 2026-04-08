export interface Session {
  sessionId: string;
  chatId: string;
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
  activeSessionId: string;
  sessions: Session[];
}
