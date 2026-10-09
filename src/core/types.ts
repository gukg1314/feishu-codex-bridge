export interface BridgeSettings {
  appId: string;
  allowedOpenIds: string[];
  allowedChatIds: string[];
  workingDirectory: string;
  model: string;
  effort: string;
  sessionTimeoutHours: number;
  allowGroupMentions: boolean;
  launchAtLogin: boolean;
  autoConnect: boolean;
  hideDockIcon: boolean;
}

export interface BridgeStatus {
  state: 'stopped' | 'starting' | 'running' | 'stopping' | 'error';
  activeTurns: number;
  queuedMessages: number;
  lastError?: string;
}

export type BridgeLog = (level: 'INFO' | 'WARN' | 'ERROR', message: string) => void;

export interface IncomingAttachment {
  kind: 'image' | 'file';
  path: string;
  name?: string;
  mimeType?: string;
}

export interface IncomingMessage {
  messageId: string;
  chatId: string;
  chatType: 'p2p' | 'group';
  senderOpenId: string;
  text: string;
  mentionsBot: boolean;
  replyToMessageId?: string;
  attachments: IncomingAttachment[];
}

export interface CardAction {
  cardMessageId: string;
  actorOpenId: string;
  action: 'stop' | 'answer' | 'approve' | 'deny' | 'select' | 'cancel' | 'page';
  value?: string;
  version?: number;
}

export interface CardSnapshot {
  sessionId: string;
  ownerOpenId: string;
  chatType?: 'p2p' | 'group';
  prompt: string;
  status: 'running' | 'completed' | 'stopped' | 'failed' | 'question' | 'approval' | 'control';
  summary?: string;
  currentStep?: string;
  steps?: { title: string; detail?: string }[];
  details?: string[];
  version: number;
  question?: { text: string; options?: string[] };
  approval?: { title: string; detail?: string };
  control?: {
    title: string;
    detail?: string;
    options: { label: string; value: string }[];
    page?: number;
    pages?: number;
    busy?: boolean;
  };
}

export interface LarkTransport {
  start(handlers: {
    onMessage: (message: IncomingMessage) => Promise<void> | void;
    onAction: (action: CardAction) => Promise<void> | void;
  }): Promise<void>;
  stop(): Promise<void>;
  updateSettings?(settings: BridgeSettings): Promise<void> | void;
  sendCard(chatId: string, snapshot: CardSnapshot): Promise<string>;
  updateCard(cardMessageId: string, snapshot: CardSnapshot): Promise<void>;
  sendText(chatId: string, text: string): Promise<void>;
  sendImage(chatId: string, path: string): Promise<void>;
  sendFile(chatId: string, path: string): Promise<void>;
  addReaction(messageId: string, emojiType: string): Promise<string>;
  removeReaction(messageId: string, reactionId: string): Promise<void>;
}
