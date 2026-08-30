import type { EncryptedMessage } from "./protocol.ts";

export type Profile = {
  id: string;
  name: string;
  handle: string;
  server: string;
  serverId?: string;
  color: string;
  token: string;
  serverName?: string;
  serverLogo?: string;
  deviceId?: string;
};

export type FolderTemplate = "custom" | "personal" | "all";
export type FolderIcon = "folder" | "chat" | "person" | "star" | "bookmark";
export type ChatFolder = {
  id: string;
  name: string;
  template: FolderTemplate;
  icon: FolderIcon;
  chatIds: string[];
};

export type Conversation = {
  id: string;
  serverId?: string;
  name: string;
  handle?: string;
  avatar: string;
  lastMessage: string;
  time: string;
  subtitle?: string;
  canWrite?: boolean;
  unread?: number;
  online?: boolean;
  lastSeenAt?: number;
  pinned?: boolean;
  muted?: boolean;
  archived?: boolean;
  deleted?: boolean;
};

export type MessageAttachment = {
  id: string;
  kind: "image" | "video" | "audio" | "file";
  name: string;
  mimeType: string;
  size: number;
  sha256: string;
  key: string;
  nonce: string;
  width?: number;
  height?: number;
  durationMs?: number;
};

export type MessageReactionEvent = {
  targetMessageId: string;
  reaction: string | null;
};

export type Message = {
  id: string;
  author: "me" | "them";
  text: string;
  time: string;
  attachments?: MessageAttachment[];
  stackId?: string;
  replyTo?: { id: string; text: string };
  reactionEvent?: MessageReactionEvent;
  editOf?: string;
  reaction?: string;
  pinned?: boolean;
  edited?: boolean;
  readAt?: number;
  deliveredAt?: number;
  deliveryStatus?: "pending" | "failed";
  encryptedMessage?: EncryptedMessage;
};

export type OutboxEntry = {
  id: string;
  conversationId: string;
  message: Message;
  attempts: number;
  nextAttemptAt: number;
  blocked?: boolean;
};
