import type { Message, OutboxEntry } from "./types";
import type { CachePolicy } from "./settings";
import {
  isOutboxEntry as isCommonOutboxEntry,
  limitMessageList as limitCommonMessageList,
  limitMessagesByProfile as limitCommonMessagesByProfile,
  limitOutboxEntries as limitCommonOutboxEntries,
  sanitizeMessagesByProfile as sanitizeCommonMessagesByProfile,
  sanitizeOutboxByProfile as sanitizeCommonOutboxByProfile,
  sanitizeSyncCursors,
} from "../../common/src/storage-models.ts";

export { sanitizeSyncCursors };

const CACHE_LIMITS: Record<CachePolicy, { perConversation: number; perProfile: number }> = {
  standard: { perConversation: 500, perProfile: 5_000 },
  minimal: { perConversation: 50, perProfile: 500 },
  disabled: { perConversation: 0, perProfile: 0 },
};
export const MAX_CACHED_MESSAGES_PER_CONVERSATION = CACHE_LIMITS.standard.perConversation;
export const MAX_CACHED_MESSAGES_PER_PROFILE = CACHE_LIMITS.standard.perProfile;
export const MAX_OUTBOX_ENTRIES = 100;
export const MAX_OUTBOX_ATTEMPTS = 8;

export { retryDelay } from "../../common/src/message-state.ts";

export function limitMessageList(messages: Message[], policy: CachePolicy = "standard") {
  return limitCommonMessageList(messages, CACHE_LIMITS[policy].perConversation);
}

export function limitMessagesByProfile(value: Record<string, Record<string, Message[]>>, policy: CachePolicy = "standard") {
  if (policy === "disabled") return {};
  return limitCommonMessagesByProfile(value, CACHE_LIMITS[policy]);
}

export function sanitizeMessagesByProfile(value: unknown, policy: CachePolicy = "standard"): Record<string, Record<string, Message[]>> {
  if (policy === "disabled") return {};
  return sanitizeCommonMessagesByProfile(value, CACHE_LIMITS[policy]);
}

export function isOutboxEntry(value: unknown): value is OutboxEntry {
  return isCommonOutboxEntry(value, MAX_OUTBOX_ATTEMPTS);
}

export function limitOutboxEntries(entries: OutboxEntry[]) {
  return limitCommonOutboxEntries(entries, MAX_OUTBOX_ATTEMPTS, MAX_OUTBOX_ENTRIES);
}

export function sanitizeOutboxByProfile(value: unknown): Record<string, OutboxEntry[]> {
  return sanitizeCommonOutboxByProfile(value, MAX_OUTBOX_ATTEMPTS, MAX_OUTBOX_ENTRIES);
}
