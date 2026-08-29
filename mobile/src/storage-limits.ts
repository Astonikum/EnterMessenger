import type { EncryptedMessage } from "./protocol";
import type { Message, MessageAttachment, OutboxEntry } from "./types";

export const MAX_CACHED_MESSAGES_PER_CONVERSATION = 500;
export const MAX_CACHED_MESSAGES_PER_PROFILE = 5_000;
export const MAX_OUTBOX_ENTRIES = 100;
export const MAX_OUTBOX_ATTEMPTS = 8;

export function retryDelay(attempts: number) {
  return Math.min(60_000, 1000 * 2 ** Math.min(attempts, 6));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isEncryptedMessage(value: unknown): value is EncryptedMessage {
  if (!isRecord(value)) return false;
  return ["protocol", "message_id", "conversation_id", "sender", "recipient", "sender_device", "key_id", "created_at", "nonce", "ephemeral_public_key", "ciphertext", "associated_data", "signature"]
    .every((key) => typeof value[key] === "string");
}

function isAttachment(value: unknown): value is MessageAttachment {
  if (!isRecord(value)) return false;
  return typeof value.id === "string"
    && ["image", "video", "audio", "file"].includes(value.kind as string)
    && typeof value.name === "string"
    && typeof value.mimeType === "string"
    && typeof value.size === "number"
    && Number.isFinite(value.size)
    && value.size >= 0
    && typeof value.sha256 === "string"
    && typeof value.key === "string"
    && typeof value.nonce === "string";
}

function isCachedMessage(value: unknown): value is Message {
  if (!isRecord(value)) return false;
  return typeof value.id === "string"
    && (value.author === "me" || value.author === "them")
    && typeof value.text === "string"
    && typeof value.time === "string"
    && (value.encryptedMessage === undefined || isEncryptedMessage(value.encryptedMessage))
    && (value.attachments === undefined || (Array.isArray(value.attachments) && value.attachments.every(isAttachment)));
}

export function limitMessageList(messages: Message[]) {
  return messages.length > MAX_CACHED_MESSAGES_PER_CONVERSATION
    ? messages.slice(-MAX_CACHED_MESSAGES_PER_CONVERSATION)
    : messages;
}

export function limitMessagesByProfile(value: Record<string, Record<string, Message[]>>) {
  return Object.fromEntries(Object.entries(value).map(([profileId, conversations]) => {
    let remaining = MAX_CACHED_MESSAGES_PER_PROFILE;
    const kept = Object.entries(conversations).reverse().flatMap(([conversationId, messages]) => {
      if (remaining <= 0) return [];
      const limited = limitMessageList(messages).slice(-remaining);
      remaining -= limited.length;
      return [[conversationId, limited] as const];
    }).reverse();
    return [profileId, Object.fromEntries(kept)];
  }));
}

export function sanitizeMessagesByProfile(value: unknown): Record<string, Record<string, Message[]>> {
  if (!isRecord(value)) return {};
  const parsed = Object.fromEntries(Object.entries(value).map(([profileId, conversations]) => {
    if (!isRecord(conversations)) return [profileId, {}] as const;
    const validConversations = Object.fromEntries(Object.entries(conversations).map(([conversationId, messages]) => [
      conversationId,
      Array.isArray(messages) ? messages.filter(isCachedMessage) : [],
    ]));
    return [profileId, validConversations] as const;
  }));
  return limitMessagesByProfile(parsed);
}

export function sanitizeSyncCursors(value: unknown): Record<string, number> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([, cursor]) => typeof cursor === "number" && Number.isFinite(cursor) && cursor >= 0).map(([profileId, cursor]) => [profileId, Math.floor(cursor as number)]));
}

export function isOutboxEntry(value: unknown): value is OutboxEntry {
  if (!isRecord(value)) return false;
  return typeof value.id === "string"
    && typeof value.conversationId === "string"
    && isCachedMessage(value.message)
    && typeof value.attempts === "number"
    && Number.isInteger(value.attempts)
    && value.attempts >= 0
    && value.attempts < MAX_OUTBOX_ATTEMPTS
    && typeof value.nextAttemptAt === "number"
    && Number.isFinite(value.nextAttemptAt);
}

export function limitOutboxEntries(entries: OutboxEntry[]) {
  return entries.filter((entry) => entry.attempts < MAX_OUTBOX_ATTEMPTS).slice(-MAX_OUTBOX_ENTRIES);
}

export function sanitizeOutboxByProfile(value: unknown): Record<string, OutboxEntry[]> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(Object.entries(value).map(([profileId, entries]) => [
    profileId,
    Array.isArray(entries) ? limitOutboxEntries(entries.filter(isOutboxEntry)) : [],
  ]));
}
