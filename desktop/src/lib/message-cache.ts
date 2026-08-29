import type { Conversation, Message } from "../types";
import type { CachePolicy } from "./local-settings";
import { exceedsMessageLimits, isCachedConversation, isCachedMessage, limitMessagesByTotal } from "../../../common/src/storage-models.ts";

const CACHE_VERSION = 2;
export const MESSAGE_CACHE_KEY_PREFIX = "enter-message-cache:";
const CACHE_DATABASE_NAME = "enter-cache";
const CACHE_DATABASE_VERSION = 1;
const CACHE_STORE = "profiles";
const CACHE_LIMITS: Record<CachePolicy, { perConversation: number; total: number }> = {
  standard: { perConversation: 200, total: 1000 },
  minimal: { perConversation: 50, total: 250 },
  disabled: { perConversation: 0, total: 0 },
};

type MessageCachePayload = {
  version: typeof CACHE_VERSION;
  updatedAt: number;
  cursor?: number;
  messages: Record<string, Message[]>;
  conversations?: Conversation[];
};

export type MessageCache = {
  cursor: number;
  messages: Record<string, Message[]>;
  conversations?: Conversation[];
  updatedAt?: number;
};

type StoredMessageCache = MessageCachePayload & { profileId: string };

const indexedWrites = new Map<string, Promise<void>>();

function cacheKey(profileId: string) {
  return `${MESSAGE_CACHE_KEY_PREFIX}${profileId}`;
}

function limitMessages(messages: Record<string, Message[]>, policy: CachePolicy) {
  return limitMessagesByTotal(messages, CACHE_LIMITS[policy]);
}

function exceedsCacheLimits(messages: Record<string, Message[]>, policy: CachePolicy) {
  return exceedsMessageLimits(messages, CACHE_LIMITS[policy]);
}

function parseCache(value: unknown, policy: CachePolicy, limit = true): MessageCache | null {
  if (!value || typeof value !== "object") return null;
  const payload = value as Partial<MessageCachePayload>;
  if (![1, CACHE_VERSION].includes(payload.version as number) || !payload.messages || typeof payload.messages !== "object") return null;

  const messages = Object.fromEntries(Object.entries(payload.messages).map(([conversationId, conversationMessages]) => [conversationId, Array.isArray(conversationMessages) ? conversationMessages.filter(isCachedMessage) : []]));
  const conversations = Array.isArray(payload.conversations) ? payload.conversations.filter(isCachedConversation).map((conversation) => ({ ...conversation, online: conversation.handle === "official" ? true : conversation.online })) : undefined;
  const overLimit = exceedsCacheLimits(messages, policy);
  return {
    cursor: overLimit ? 0 : typeof payload.cursor === "number" && payload.cursor >= 0 ? payload.cursor : 0,
    messages: limit ? limitMessages(messages, policy) : messages,
    conversations,
    updatedAt: typeof payload.updatedAt === "number" ? payload.updatedAt : undefined,
  };
}

function openCacheDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB is unavailable"));
      return;
    }
    const request = indexedDB.open(CACHE_DATABASE_NAME, CACHE_DATABASE_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(CACHE_STORE)) request.result.createObjectStore(CACHE_STORE, { keyPath: "profileId" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Cache database is unavailable"));
  });
}

function readIndexedCache(profileId: string) {
  return openCacheDatabase().then((database) => new Promise<StoredMessageCache | undefined>((resolve, reject) => {
    const transaction = database.transaction(CACHE_STORE, "readonly");
    const request = transaction.objectStore(CACHE_STORE).get(profileId);
    let value: StoredMessageCache | undefined;
    request.onsuccess = () => { value = request.result as StoredMessageCache | undefined; };
    request.onerror = () => reject(request.error ?? new Error("Cache read failed"));
    transaction.oncomplete = () => { database.close(); resolve(value); };
    transaction.onerror = () => { database.close(); reject(transaction.error ?? new Error("Cache read failed")); };
  }));
}

function writeIndexedCache(profileId: string, payload: MessageCachePayload) {
  const previous = indexedWrites.get(profileId) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(() => openCacheDatabase().then((database) => new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(CACHE_STORE, "readwrite");
    transaction.objectStore(CACHE_STORE).put({ ...payload, profileId });
    transaction.oncomplete = () => { database.close(); resolve(); };
    transaction.onerror = () => { database.close(); reject(transaction.error ?? new Error("Cache write failed")); };
  })));
  indexedWrites.set(profileId, next);
  void next.then(() => {
    if (indexedWrites.get(profileId) === next) indexedWrites.delete(profileId);
  }, () => {
    if (indexedWrites.get(profileId) === next) indexedWrites.delete(profileId);
  });
}

function deleteIndexedCache(profileId: string) {
  const previous = indexedWrites.get(profileId) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(() => openCacheDatabase().then((database) => new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(CACHE_STORE, "readwrite");
    transaction.objectStore(CACHE_STORE).delete(profileId);
    transaction.oncomplete = () => { database.close(); resolve(); };
    transaction.onerror = () => { database.close(); reject(transaction.error ?? new Error("Cache delete failed")); };
  })));
  indexedWrites.set(profileId, next);
  void next.then(() => {
    if (indexedWrites.get(profileId) === next) indexedWrites.delete(profileId);
  }, () => {
    if (indexedWrites.get(profileId) === next) indexedWrites.delete(profileId);
  });
}

export function readMessageCache(profileId: string | null | undefined, policy: CachePolicy = "standard"): MessageCache | null {
  if (!profileId) return null;
  if (policy === "disabled") return null;

  try {
    const raw = localStorage.getItem(cacheKey(profileId));
    if (!raw) return null;
    return parseCache(JSON.parse(raw), policy);
  } catch {
    return null;
  }
}

export async function readMessageCacheAsync(profileId: string | null | undefined, policy: CachePolicy = "standard"): Promise<MessageCache | null> {
  if (!profileId) return null;
  if (policy === "disabled") return null;
  const local = readMessageCache(profileId, policy);
  try {
    const stored = await readIndexedCache(profileId);
    const indexed = stored ? parseCache(stored, policy) : null;
    if ((indexed?.updatedAt ?? 0) >= (local?.updatedAt ?? 0)) return indexed ?? local;
  } catch {
    // IndexedDB is an enhancement; the synchronous local cache remains the fallback.
  }
  return local;
}

export function writeMessageCache(profileId: string, messages: Record<string, Message[]>, cursor = 0, conversations?: Conversation[], policy: CachePolicy = "standard") {
  if (policy === "disabled") {
    clearMessageCache(profileId);
    return Date.now();
  }
  const truncated = exceedsCacheLimits(messages, policy);
  const payload: MessageCachePayload = {
    version: CACHE_VERSION,
    updatedAt: Date.now(),
    cursor: truncated ? 0 : cursor,
    messages: limitMessages(messages, policy),
    conversations,
  };

  try {
    localStorage.setItem(cacheKey(profileId), JSON.stringify(payload));
  } catch {
    // Cache failures must never block sending or rendering messages.
  }
  writeIndexedCache(profileId, payload);
  return payload.updatedAt;
}

export function clearMessageCache(profileId: string) {
  try {
    localStorage.removeItem(cacheKey(profileId));
  } catch {
    // Cache cleanup must never block removing a local profile.
  }
  deleteIndexedCache(profileId);
}
