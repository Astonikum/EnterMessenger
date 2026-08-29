import { ENTER_PROTOCOL_VERSION } from "./protocol.ts";
import { isChatFolder } from "./folders.ts";
import type { AccountSettings, BlockedAccount, RealtimeEvent, RemoteConversation, RemoteMessage, SyncResponse } from "./api-types.ts";
import type { EncryptedMessage } from "./protocol.ts";

export const MAX_ENCRYPTED_MESSAGE_CIPHERTEXT_LENGTH = 2_000_000;
export const MAX_SYNC_ITEMS = 1_000;
export const MAX_FOLDERS = 100;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function isString(value: unknown, maxLength = 4096): value is string {
  return typeof value === "string" && value.length <= maxLength;
}

export function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isIdentifier(value: unknown, maxLength = 128): value is string {
  return isString(value, maxLength) && value.length > 0 && !/[\u0000-\u001f\u007f]/.test(value);
}

function isUnixMillis(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]) {
  return Object.keys(value).every((key) => keys.includes(key));
}

export function isEncryptedMessage(value: unknown): value is EncryptedMessage {
  if (!isRecord(value) || value.protocol !== ENTER_PROTOCOL_VERSION) return false;
  return ["message_id", "conversation_id", "sender", "recipient", "sender_device", "key_id", "created_at", "nonce", "ephemeral_public_key", "ciphertext", "associated_data", "signature"]
    .every((key) => isString(value[key], key === "ciphertext" ? MAX_ENCRYPTED_MESSAGE_CIPHERTEXT_LENGTH : 4096));
}

export function isRemoteConversation(value: unknown): value is RemoteConversation {
  return isRecord(value)
    && isString(value.id, 256)
    && (value.serverId === undefined || isString(value.serverId, 256))
    && isString(value.name, 256)
    && (value.handle === undefined || value.handle === null || isString(value.handle, 512))
    && isString(value.avatar, 2048)
    && (value.subtitle === undefined || value.subtitle === null || isString(value.subtitle, 512))
    && typeof value.canWrite === "boolean"
    && isString(value.lastMessage, 2_000_000)
    && (value.lastMessageAt === undefined || value.lastMessageAt === null || isNumber(value.lastMessageAt))
    && typeof value.pinned === "boolean"
    && typeof value.online === "boolean"
    && (value.lastSeenAt === undefined || value.lastSeenAt === null || isNumber(value.lastSeenAt))
    && isNumber(value.unread)
    && value.unread >= 0;
}

export function isRemoteMessage(value: unknown): value is RemoteMessage {
  return isRecord(value)
    && isString(value.id, 256)
    && isString(value.conversationId, 256)
    && (value.author === "me" || value.author === "them")
    && isNumber(value.createdAt)
    && isString(value.stackId, 256)
    && isEncryptedMessage(value.encryptedMessage);
}

export function isReceipt(value: unknown, field: "readAt" | "deliveredAt") {
  return isRecord(value) && isString(value.messageId, 256) && isNumber(value[field]);
}

export function isFolderList(value: unknown): value is NonNullable<SyncResponse["folders"]> {
  return Array.isArray(value) && value.length <= MAX_FOLDERS && value.every(isChatFolder);
}

export function isSyncResponse(value: unknown): value is SyncResponse {
  return isRecord(value)
    && isNumber(value.nextCursor)
    && value.nextCursor >= 0
    && Array.isArray(value.conversations)
    && value.conversations.length <= MAX_SYNC_ITEMS
    && value.conversations.every(isRemoteConversation)
    && Array.isArray(value.messages)
    && value.messages.length <= MAX_SYNC_ITEMS
    && value.messages.every(isRemoteMessage)
    && Array.isArray(value.readReceipts)
    && value.readReceipts.length <= MAX_SYNC_ITEMS
    && value.readReceipts.every((item) => isReceipt(item, "readAt"))
    && Array.isArray(value.deliveryReceipts)
    && value.deliveryReceipts.length <= MAX_SYNC_ITEMS
    && value.deliveryReceipts.every((item) => isReceipt(item, "deliveredAt"))
    && (value.folders === undefined || isFolderList(value.folders));
}

export function isRealtimeEvent(value: unknown): value is RealtimeEvent {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  if (value.type === "ready") return isNumber(value.version);
  if (value.type === "sync") return isSyncResponse(value);
  if (value.type === "message") return isNumber(value.cursor) && value.cursor >= 0 && isRemoteMessage(value.message);
  if (value.type === "readReceipt") return isNumber(value.cursor) && value.cursor >= 0 && isReceipt(value, "readAt");
  if (value.type === "deliveryReceipt") return isNumber(value.cursor) && value.cursor >= 0 && isReceipt(value, "deliveredAt");
  if (value.type === "presence") return isString(value.conversationId, 256) && typeof value.online === "boolean" && isNumber(value.lastSeenAt);
  if (value.type === "folders") return isFolderList(value.folders);
  if (value.type === "pong") return true;
  return value.type === "error" && isString(value.code, 128);
}

export function isAcceptedResponse(value: unknown): value is { accepted: boolean } {
  return isRecord(value) && typeof value.accepted === "boolean";
}

export function isTimestampResponse(value: unknown, field: "readAt" | "deliveredAt"): value is Record<string, number> {
  return isRecord(value) && isNumber(value[field]);
}

export function isAccountSettings(value: unknown): value is AccountSettings {
  return isRecord(value)
    && hasOnlyKeys(value, ["id", "name", "handle", "showOnline", "showLastSeen", "readReceipts", "typingIndicators", "showPhone", "showProfilePhoto", "allowForwarding", "allowCalls", "suggestPeople"])
    && isString(value.id, 256)
    && isString(value.name, 256)
    && isString(value.handle, 256)
    && typeof value.showOnline === "boolean"
    && typeof value.showLastSeen === "boolean"
    && typeof value.readReceipts === "boolean"
    && typeof value.typingIndicators === "boolean"
    && typeof value.showPhone === "boolean"
    && typeof value.showProfilePhoto === "boolean"
    && typeof value.allowForwarding === "boolean"
    && typeof value.allowCalls === "boolean"
    && typeof value.suggestPeople === "boolean";
}

export function isBlockedAccount(value: unknown): value is BlockedAccount {
  return isRecord(value)
    && hasOnlyKeys(value, ["id", "address", "handle", "name", "server", "createdAt"])
    && isString(value.id, 256)
    && isString(value.address, 2048)
    && isString(value.handle, 256)
    && isString(value.name, 256)
    && isString(value.server, 2048)
    && isUnixMillis(value.createdAt);
}

export function isBlockedAccountList(value: unknown): value is BlockedAccount[] {
  return Array.isArray(value) && value.length <= 10_000 && value.every(isBlockedAccount);
}

export function isDeviceHistoryResponse(value: unknown): value is { accepted: number; nextCursor: number } {
  return isRecord(value)
    && isNumber(value.accepted)
    && value.accepted >= 0
    && isNumber(value.nextCursor)
    && value.nextCursor >= 0;
}
