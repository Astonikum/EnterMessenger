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
  pinned?: boolean;
  muted?: boolean;
  archived?: boolean;
  deleted?: boolean;
  folder?: string;
  lastSeenAt?: number;
};

export type Message = {
  id: string;
  author: "me" | "them";
  text: string;
  time: string;
  stackId?: string;
  replyTo?: { id: string; text: string };
  editOf?: string;
  reaction?: string;
  pinned?: boolean;
  edited?: boolean;
  readAt?: number;
  deliveredAt?: number;
  deliveryStatus?: "pending" | "failed";
  envelope?: import("./protocol").EncryptedEnvelope;
};

export type OutboxEntry = {
  id: string;
  conversationId: string;
  message: Message;
  attempts: number;
  nextAttemptAt: number;
};

export type SearchUser = {
  id: string;
  address: string;
  handle: string;
  name: string;
  server: string;
  serverId?: string;
  avatar: string;
  deviceCount: number;
};
