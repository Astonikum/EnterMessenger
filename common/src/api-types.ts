import type { EncryptedMessage } from "./protocol.ts";
import type { ChatFolder } from "./types.ts";

export type RemoteConversation = {
  id: string;
  serverId?: string;
  name: string;
  handle?: string | null;
  avatar: string;
  subtitle?: string | null;
  canWrite: boolean;
  lastMessage: string;
  lastMessageAt?: number | null;
  pinned: boolean;
  online: boolean;
  lastSeenAt?: number | null;
  unread: number;
};

export type RemoteMessage = {
  id: string;
  conversationId: string;
  author: "me" | "them";
  createdAt: number;
  stackId: string;
  encryptedMessage: EncryptedMessage;
};

export type RemoteReadReceipt = { messageId: string; readAt: number };
export type RemoteDeliveryReceipt = { messageId: string; deliveredAt: number };
export type SyncResponse = {
  nextCursor: number;
  conversations: RemoteConversation[];
  folders?: ChatFolder[];
  messages: RemoteMessage[];
  readReceipts: RemoteReadReceipt[];
  deliveryReceipts: RemoteDeliveryReceipt[];
};

export type RealtimeEvent =
  | { type: "ready"; version: number }
  | ({ type: "sync" } & SyncResponse)
  | { type: "message"; cursor: number; message: RemoteMessage }
  | { type: "readReceipt"; cursor: number; messageId: string; readAt: number }
  | { type: "deliveryReceipt"; cursor: number; messageId: string; deliveredAt: number }
  | { type: "presence"; conversationId: string; online: boolean; lastSeenAt: number }
  | { type: "folders"; folders: ChatFolder[] }
  | { type: "pong" }
  | { type: "error"; code: string };

export type DeviceHistoryEntry = {
  conversationId: string;
  messageId: string;
  sourceKeyId?: string;
  encryptedMessage: EncryptedMessage;
};

export type AccountSettings = {
  id: string;
  name: string;
  handle: string;
  showOnline: boolean;
  showLastSeen: boolean;
  readReceipts: boolean;
  typingIndicators: boolean;
  showPhone: boolean;
  showProfilePhoto: boolean;
  allowForwarding: boolean;
  allowCalls: boolean;
  suggestPeople: boolean;
};

export type AccountSettingsPatch = Partial<Pick<AccountSettings, "name" | "showOnline" | "showLastSeen" | "readReceipts" | "typingIndicators" | "showPhone" | "showProfilePhoto" | "allowForwarding" | "allowCalls" | "suggestPeople">>;

export type BlockedAccount = {
  id: string;
  address: string;
  handle: string;
  name: string;
  server: string;
  createdAt: number;
};

export type ChangePasswordPayload = {
  currentPassword: string;
  newPassword: string;
};

export type ClientDeviceMetadata = {
  platform: string;
  deviceName: string;
  appVersion: string;
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
