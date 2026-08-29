import type { EncryptedMessage } from "./protocol.ts";
import type { Conversation, Message, MessageAttachment, OutboxEntry } from "./types.ts";

export type MessageLimits = {
  perConversation: number;
  total: number;
};

export type ProfileMessageLimits = {
  perConversation: number;
  perProfile: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isEncryptedMessage(value: unknown): value is EncryptedMessage {
  if (!isRecord(value)) return false;
  return ["protocol", "message_id", "conversation_id", "sender", "recipient", "sender_device", "key_id", "created_at", "nonce", "ephemeral_public_key", "ciphertext", "associated_data", "signature"]
    .every((key) => typeof value[key] === "string");
}

export function isCachedAttachment(value: unknown): value is MessageAttachment {
  if (!isRecord(value)) return false;
  return ["image", "video", "audio", "file"].includes(value.kind as string)
    && typeof value.id === "string"
    && typeof value.name === "string"
    && typeof value.mimeType === "string"
    && typeof value.size === "number"
    && Number.isFinite(value.size)
    && value.size >= 0
    && typeof value.sha256 === "string"
    && typeof value.key === "string"
    && typeof value.nonce === "string";
}

export function isCachedMessage(value: unknown): value is Message {
  if (!isRecord(value)) return false;
  return typeof value.id === "string"
    && (value.author === "me" || value.author === "them")
    && typeof value.text === "string"
    && typeof value.time === "string"
    && (value.encryptedMessage === undefined || isEncryptedMessage(value.encryptedMessage))
    && (value.attachments === undefined || (Array.isArray(value.attachments) && value.attachments.every(isCachedAttachment)));
}

export function isCachedConversation(value: unknown): value is Conversation {
  if (!isRecord(value)) return false;
  return typeof value.id === "string"
    && typeof value.name === "string"
    && typeof value.avatar === "string"
    && typeof value.lastMessage === "string"
    && typeof value.time === "string";
}

export function limitMessageList(messages: Message[], limit: number) {
  return messages.length > limit ? messages.slice(-limit) : messages;
}

export function limitMessagesByTotal(messages: Record<string, Message[]>, limits: MessageLimits) {
  const limited: Record<string, Message[]> = {};
  let remaining = limits.total;

  for (const [conversationId, conversationMessages] of Object.entries(messages)) {
    const recent = limitMessageList(conversationMessages, limits.perConversation);
    const allowed = Math.min(remaining, recent.length);
    limited[conversationId] = allowed > 0 ? recent.slice(-allowed) : [];
    remaining -= allowed;
    if (remaining === 0) break;
  }

  return limited;
}

export function exceedsMessageLimits(messages: Record<string, Message[]>, limits: MessageLimits) {
  let total = 0;
  for (const conversationMessages of Object.values(messages)) {
    if (conversationMessages.length > limits.perConversation) return true;
    total += conversationMessages.length;
    if (total > limits.total) return true;
  }
  return false;
}

export function limitMessagesByProfile(value: Record<string, Record<string, Message[]>>, limits: ProfileMessageLimits) {
  const limited: Record<string, Record<string, Message[]>> = {};
  for (const [profileId, conversations] of Object.entries(value)) {
    let remaining = limits.perProfile;
    const kept = Object.entries(conversations).reverse().flatMap(([conversationId, messages]) => {
      if (remaining <= 0) return [];
      const recent = limitMessageList(messages, limits.perConversation).slice(-remaining);
      remaining -= recent.length;
      return [[conversationId, recent] as const];
    }).reverse();
    limited[profileId] = Object.fromEntries(kept);
  }
  return limited;
}

export function sanitizeMessagesByProfile(value: unknown, limits: ProfileMessageLimits) {
  if (!isRecord(value) || limits.perProfile <= 0) return {};
  const parsed: Record<string, Record<string, Message[]>> = {};
  for (const [profileId, conversations] of Object.entries(value)) {
    if (!isRecord(conversations)) {
      parsed[profileId] = {};
      continue;
    }
    parsed[profileId] = Object.fromEntries(Object.entries(conversations).map(([conversationId, messages]) => [
      conversationId,
      Array.isArray(messages) ? messages.filter(isCachedMessage) : [],
    ]));
  }
  return limitMessagesByProfile(parsed, limits);
}

export function isOutboxEntry(value: unknown, maxAttempts: number): value is OutboxEntry {
  if (!isRecord(value)) return false;
  return typeof value.id === "string"
    && typeof value.conversationId === "string"
    && isCachedMessage(value.message)
    && typeof value.attempts === "number"
    && Number.isFinite(value.attempts)
    && value.attempts >= 0
    && value.attempts < maxAttempts
    && typeof value.nextAttemptAt === "number"
    && Number.isFinite(value.nextAttemptAt);
}

export function limitOutboxEntries(entries: OutboxEntry[], maxAttempts: number, maxEntries: number) {
  return entries
    .filter((entry) => entry.attempts < maxAttempts)
    .map((entry) => ({ ...entry, attempts: Math.floor(entry.attempts) }))
    .slice(-maxEntries);
}

export function sanitizeOutboxByProfile(value: unknown, maxAttempts: number, maxEntries: number) {
  if (!isRecord(value)) return {};
  return Object.fromEntries(Object.entries(value).map(([profileId, entries]) => [
    profileId,
    Array.isArray(entries) ? limitOutboxEntries(entries.filter((entry): entry is OutboxEntry => isOutboxEntry(entry, maxAttempts)), maxAttempts, maxEntries) : [],
  ]));
}

export function sanitizeSyncCursors(value: unknown): Record<string, number> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(Object.entries(value)
    .filter(([, cursor]) => typeof cursor === "number" && Number.isFinite(cursor) && cursor >= 0)
    .map(([profileId, cursor]) => [profileId, Math.floor(cursor as number)]));
}
