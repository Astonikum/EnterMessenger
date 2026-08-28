import { useEffect, useRef, useState } from "react";
import { AuthView } from "./views/auth-view";
import { MessengerView } from "./views/messenger-view";
import { readTabState, writeTabState } from "./lib/app-state";
import { EMPTY_MESSAGES } from "./lib/empty-messages";
import { clearMessageCache, MESSAGE_CACHE_KEY_PREFIX, readMessageCache, readMessageCacheAsync, writeMessageCache } from "./lib/message-cache";
import { acknowledgeMessage, createConversation, fetchPublicAccountKey, fetchPublicDeviceKeys, mapRemoteConversation, markConversationRead, openRealtime, registerDeviceKey, searchUser, sendMessage as sendRemoteMessage, syncDeviceHistory, syncProfile, type DeviceHistoryEntry, type RealtimeEvent, type RemoteDeliveryReceipt, type RemoteMessage, type RemoteReadReceipt, type SearchUser, type SyncResponse, uploadMedia } from "./lib/enter-api";
import { accountKeyBundle, decodeMessagePayload, decryptMessage, deleteDeviceKeys, deviceKeyBundle, encryptMessage, ensureAccountKey, ensureDeviceKeys, readAccountKey, type PublicAccountKey, type PublicDeviceKey } from "./lib/e2e";
import { encryptMedia, isAudioAttachment } from "./lib/media";
import type { PendingMedia } from "./components/message-composer";
import { formatMessageTime, makeId } from "./lib/utils";
import { migrateLocalServerAddress } from "./lib/server-address";
import { createRealtimeQueue, createSyncQueue } from "./lib/sync-queue";
import { notifyIncomingMessage, subscribeToNotificationActions } from "./lib/notifications";
import type { Conversation, Message, OutboxEntry, Profile } from "./types";

const LEGACY_OUTBOX_KEY = "enter-outbox";
const OUTBOX_KEY_PREFIX = "enter-outbox:";
const ALL_FOLDER = "all";
const DEFAULT_FOLDER = "Личное";

function folderNames(conversations: Conversation[]) {
  return [...new Set([DEFAULT_FOLDER, ...conversations.map((conversation) => conversation.folder).filter((folder): folder is string => Boolean(folder))])];
}

function messagePreview(message: Message) {
  if (message.text.trim()) return message.text;
  const attachments = message.attachments ?? [];
  if (attachments.some(({ kind }) => kind === "image")) return "[Фото]";
  if (attachments.some(({ kind }) => kind === "video")) return "[Видео]";
  if (attachments.some(isAudioAttachment)) return "[Аудио]";
  return attachments.length > 0 ? "[Файлы]" : "";
}

function readProfiles() {
  try {
    const stored = localStorage.getItem("enter-profiles");
    const parsed = stored ? JSON.parse(stored) : null;
    if (!Array.isArray(parsed)) return [];
    const profiles = (parsed as Profile[]).filter((profile) => typeof profile?.token === "string" && profile.token.length > 0);
    const migrated = profiles.map((profile) => ({ ...profile, server: migrateLocalServerAddress(profile.server) }));
    if (migrated.some((profile, index) => profile.server !== profiles[index].server)) localStorage.setItem("enter-profiles", JSON.stringify(migrated));
    return migrated;
  } catch {
    return [];
  }
}

function profileAddress(profile: Profile) {
  return `${profile.handle.replace(/^@+/, "")}@${profile.server.replace(/^https?:\/\//, "")}`;
}

function readOutbox(): Record<string, OutboxEntry[]> {
  const outbox: Record<string, OutboxEntry[]> = {};
  try {
    const legacy = JSON.parse(localStorage.getItem(LEGACY_OUTBOX_KEY) ?? "{}");
    if (legacy && typeof legacy === "object") Object.assign(outbox, legacy as Record<string, OutboxEntry[]>);
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (!key?.startsWith(OUTBOX_KEY_PREFIX)) continue;
      const profileId = key.slice(OUTBOX_KEY_PREFIX.length);
      const parsed = JSON.parse(localStorage.getItem(key) ?? "[]");
      if (profileId && Array.isArray(parsed)) outbox[profileId] = parsed as OutboxEntry[];
    }
  } catch {
    // Outbox recovery must not block app startup.
  }
  return outbox;
}

function readOutboxProfile(profileId: string) {
  try {
    const parsed = JSON.parse(localStorage.getItem(`${OUTBOX_KEY_PREFIX}${profileId}`) ?? "[]");
    return Array.isArray(parsed) ? parsed as OutboxEntry[] : [];
  } catch {
    return [];
  }
}

function retryDelay(attempts: number) {
  return Math.min(60_000, 1000 * 2 ** Math.min(attempts, 6));
}

function isUnauthorized(reason: unknown) {
  return reason instanceof Error && /\b401\b/.test(reason.message);
}

async function prepareProfile(profile: Profile, password?: string) {
  const device = await ensureDeviceKeys(profile.id);
  const account = password ? await ensureAccountKey(profile.id, password) : await readAccountKey(profile.id);
  await registerDeviceKey(profile, deviceKeyBundle(device), account ? { keyId: account.keyId, encryptionPublicKey: accountKeyBundle(account, profileAddress(profile)).encryptionPublicKey } : undefined);
  return { device, account: account ? accountKeyBundle(account, profileAddress(profile)) : null, bundle: { ...deviceKeyBundle(device), address: profileAddress(profile) } satisfies PublicDeviceKey };
}

async function allDeviceKeys(profile: Profile, ownBundle: PublicDeviceKey) {
  try {
    const keys = await fetchPublicDeviceKeys(profile, profileAddress(profile));
    return keys.some((key) => key.keyId === ownBundle.keyId) ? keys : [ownBundle, ...keys];
  } catch {
    return [ownBundle];
  }
}

async function decryptRemoteMessage(profile: Profile, remote: RemoteMessage, knownSenderDevices?: PublicDeviceKey[]): Promise<Message> {
  const senderDevices = knownSenderDevices ?? await fetchPublicDeviceKeys(profile, remote.envelope.sender);
  const sender = senderDevices.find((device) => device.deviceId === remote.envelope.sender_device);
  if (!sender) throw new Error("Ключ устройства отправителя не найден");
  const payload = decodeMessagePayload(await decryptMessage(profile, remote.envelope, sender));
  return {
    id: remote.envelope.message_id,
    author: remote.author,
    text: payload.text,
    editOf: payload.editOf,
    attachments: payload.attachments,
    time: formatMessageTime(new Date(remote.createdAt)),
    stackId: remote.stackId,
    envelope: remote.envelope,
  };
}

function resolveMessageEdits(messages: Message[]) {
  const baseMessages = messages.filter((message) => !message.editOf);
  const editEvents = messages.filter((message) => Boolean(message.editOf));
  editEvents.forEach((edit) => {
    const targetIndex = baseMessages.findIndex((message) => message.id === edit.editOf);
    if (targetIndex >= 0) baseMessages[targetIndex] = { ...baseMessages[targetIndex], text: edit.text, edited: true };
  });
  return [...baseMessages, ...editEvents];
}

function mergeRemoteMessages(current: Record<string, Message[]>, incoming: Array<{ conversationId: string; message: Message }>) {
  const next = { ...current };
  incoming.forEach(({ conversationId, message }) => {
    const existing = next[conversationId] ?? [];
    const existingIndex = existing.findIndex((item) => item.id === message.id);
    if (existingIndex >= 0) {
      const replaced = [...existing];
      replaced[existingIndex] = { ...replaced[existingIndex], ...message, readAt: message.readAt ?? replaced[existingIndex].readAt, deliveredAt: message.deliveredAt ?? replaced[existingIndex].deliveredAt };
      next[conversationId] = replaced;
    } else {
      next[conversationId] = [...existing, message];
    }
    next[conversationId] = resolveMessageEdits(next[conversationId]);
  });
  return next;
}

function mergeReadReceipts(current: Record<string, Message[]>, receipts: RemoteReadReceipt[]) {
  if (receipts.length === 0) return current;
  const readAtByMessage = new Map(receipts.map((receipt) => [receipt.messageId, receipt.readAt]));
  return Object.fromEntries(Object.entries(current).map(([conversationId, messages]) => [conversationId, messages.map((message) => {
    const readAt = readAtByMessage.get(message.id);
    return readAt && (!message.readAt || readAt > message.readAt) ? { ...message, readAt } : message;
  })]));
}

function mergeDeliveryReceipts(current: Record<string, Message[]>, receipts: RemoteDeliveryReceipt[]) {
  if (receipts.length === 0) return current;
  const deliveredAtByMessage = new Map(receipts.map((receipt) => [receipt.messageId, receipt.deliveredAt]));
  return Object.fromEntries(Object.entries(current).map(([conversationId, messages]) => [conversationId, messages.map((message) => {
    const deliveredAt = deliveredAtByMessage.get(message.id);
    return deliveredAt && (!message.deliveredAt || deliveredAt > message.deliveredAt) ? { ...message, deliveredAt } : message;
  })]));
}

// #preview default {}
export default function App() {
  const [profiles, setProfiles] = useState<Profile[]>(readProfiles);
  const [activeProfileId, setActiveProfileId] = useState<string | null>(() => {
    const stored = readTabState().activeProfileId;
    return stored && profiles.some((profile) => profile.id === stored) ? stored : profiles[0]?.id ?? null;
  });
  const [activeConversationId, setActiveConversationId] = useState<string | null>(() => {
    const storedProfile = readTabState().activeProfileId;
    return storedProfile ? readTabState().activeConversationByProfile?.[storedProfile] ?? null : null;
  });
  const [activeFolder, setActiveFolder] = useState<string>(() => {
    const state = readTabState();
    const profileId = state.activeProfileId;
    return profileId ? state.activeFolderByProfile?.[profileId] ?? ALL_FOLDER : ALL_FOLDER;
  });
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const [editingMessage, setEditingMessage] = useState<Message | null>(null);
  const [messageToForward, setMessageToForward] = useState<Message | null>(null);
  const [conversations, setConversations] = useState<Conversation[]>(() => readMessageCache(activeProfileId)?.conversations ?? []);
  const [messagesByProfile, setMessagesByProfile] = useState<Record<string, Record<string, Message[]>>>(() => Object.fromEntries(profiles.map((profile) => [profile.id, readMessageCache(profile.id)?.messages ?? EMPTY_MESSAGES])));
  const [syncCursors, setSyncCursors] = useState<Record<string, number>>(() => Object.fromEntries(profiles.map((profile) => [profile.id, readMessageCache(profile.id)?.cursor ?? 0])));
  const [outboxByProfile, setOutboxByProfile] = useState<Record<string, OutboxEntry[]>>(readOutbox);
  const [syncConnected, setSyncConnected] = useState(false);
  const [showAuth, setShowAuth] = useState(false);
  const [showProfile, setShowProfile] = useState(() => readTabState().showProfile ?? false);
  const [showSettings, setShowSettings] = useState(() => readTabState().showSettings ?? false);
  const [searchResult, setSearchResult] = useState<SearchUser | null>(null);
  const [searchBusy, setSearchBusy] = useState(false);
  const [searchError, setSearchError] = useState("");
  const searchRequestId = useRef(0);
  const [messageError, setMessageError] = useState("");
  const [mediaUploadProgress, setMediaUploadProgress] = useState<number | null>(null);
  const messagesByProfileRef = useRef(messagesByProfile);
  const activeConversationIdRef = useRef(activeConversationId);
  const syncCursorsRef = useRef(syncCursors);
  const outboxRef = useRef(outboxByProfile);
  const retryingOutbox = useRef(new Set<string>());
  const cacheUpdatedAtRef = useRef<Record<string, number>>(Object.fromEntries(profiles.map((profile) => [profile.id, readMessageCache(profile.id)?.updatedAt ?? 0])));
  const skipNextCacheWriteRef = useRef(false);
  const persistedOutboxProfilesRef = useRef(new Set(Object.keys(outboxByProfile)));

  function persistMessageCache(profileId: string, profileMessages: Record<string, Message[]>, cursor: number, profileConversations: Conversation[]) {
    cacheUpdatedAtRef.current[profileId] = writeMessageCache(profileId, profileMessages, cursor, profileConversations);
  }

  const activeProfile = profiles.find((profile) => profile.id === activeProfileId);
  const activeConversation = conversations.find((conversation) => conversation.id === activeConversationId);
  const availableFolders = folderNames(conversations);
  const activeProfileMessages = activeProfileId ? messagesByProfile[activeProfileId] ?? EMPTY_MESSAGES : EMPTY_MESSAGES;
  const messages = activeConversationId ? (activeProfileMessages[activeConversationId] ?? []).filter((message) => !message.editOf) : [];
  const conversationsWithPreviews = conversations.map((conversation) => {
    const conversationMessages = (activeProfileMessages[conversation.id] ?? []).filter((message) => !message.editOf);
    const latestMessage = conversationMessages[conversationMessages.length - 1];
    return latestMessage ? { ...conversation, lastMessage: messagePreview(latestMessage), time: latestMessage.time } : { ...conversation, lastMessage: "", time: "" };
  });

  useEffect(() => {
    messagesByProfileRef.current = messagesByProfile;
  }, [messagesByProfile]);

  useEffect(() => {
    activeConversationIdRef.current = activeConversationId;
  }, [activeConversationId]);

  useEffect(() => {
    let active = true;
    let dispose: (() => void) | null = null;
    void subscribeToNotificationActions((profileId, conversationId) => {
      if (!profiles.some((profile) => profile.id === profileId)) return;
      setActiveProfileId(profileId);
      setActiveConversationId(conversationId);
      setShowSettings(false);
    }).then((cleanup) => {
      if (active) dispose = cleanup;
      else cleanup();
    });
    const openConversation = (event: Event) => {
      const detail = (event as CustomEvent<{ profileId?: string; conversationId?: string }>).detail;
      if (!detail?.profileId || !detail.conversationId || !profiles.some((profile) => profile.id === detail.profileId)) return;
      setActiveProfileId(detail.profileId);
      setActiveConversationId(detail.conversationId);
      setShowSettings(false);
    };
    window.addEventListener("enter:open-conversation", openConversation);
    return () => {
      active = false;
      dispose?.();
      window.removeEventListener("enter:open-conversation", openConversation);
    };
  }, [profiles]);

  useEffect(() => {
    syncCursorsRef.current = syncCursors;
  }, [syncCursors]);

  useEffect(() => {
    outboxRef.current = outboxByProfile;
    const nextProfiles = new Set(Object.keys(outboxByProfile));
    try {
      for (const profileId of persistedOutboxProfilesRef.current) {
        if (!nextProfiles.has(profileId)) localStorage.removeItem(`${OUTBOX_KEY_PREFIX}${profileId}`);
      }
      for (const [profileId, entries] of Object.entries(outboxByProfile)) {
        if (entries.length > 0) localStorage.setItem(`${OUTBOX_KEY_PREFIX}${profileId}`, JSON.stringify(entries));
        else localStorage.removeItem(`${OUTBOX_KEY_PREFIX}${profileId}`);
      }
      persistedOutboxProfilesRef.current = nextProfiles;
    } catch { /* Outbox stays in memory until storage recovers. */ }
  }, [outboxByProfile]);

  useEffect(() => {
    if (!activeProfileId) return;
    const timer = window.setTimeout(() => {
      if (skipNextCacheWriteRef.current) {
        skipNextCacheWriteRef.current = false;
        return;
      }
      persistMessageCache(activeProfileId, messagesByProfile[activeProfileId] ?? EMPTY_MESSAGES, syncCursors[activeProfileId] ?? 0, conversations);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [activeProfileId, conversations, messagesByProfile, syncCursors]);

  useEffect(() => {
    if (!activeProfileId) return;
    const flush = () => persistMessageCache(activeProfileId, messagesByProfile[activeProfileId] ?? EMPTY_MESSAGES, syncCursors[activeProfileId] ?? 0, conversations);
    window.addEventListener("pagehide", flush);
    return () => window.removeEventListener("pagehide", flush);
  }, [activeProfileId, conversations, messagesByProfile, syncCursors]);

  useEffect(() => {
    const state = readTabState();
    writeTabState({
      ...state,
      activeProfileId,
      activeConversationByProfile: activeProfileId
        ? { ...state.activeConversationByProfile, [activeProfileId]: activeConversationId }
        : state.activeConversationByProfile,
      activeFolderByProfile: activeProfileId
        ? { ...state.activeFolderByProfile, [activeProfileId]: activeFolder }
        : state.activeFolderByProfile,
      showProfile,
      showSettings,
    });
  }, [activeConversationId, activeFolder, activeProfileId, showProfile, showSettings]);

  useEffect(() => {
    const cached = activeProfileId ? readMessageCache(activeProfileId) : null;
    setConversations(cached?.conversations ?? []);
    setActiveConversationId(activeProfileId ? readTabState().activeConversationByProfile?.[activeProfileId] ?? null : null);
    setActiveFolder(activeProfileId ? readTabState().activeFolderByProfile?.[activeProfileId] ?? ALL_FOLDER : ALL_FOLDER);
  }, [activeProfileId]);

  useEffect(() => {
    if (activeFolder !== ALL_FOLDER && !availableFolders.includes(activeFolder)) setActiveFolder(ALL_FOLDER);
  }, [activeFolder, availableFolders]);

  useEffect(() => {
    const handleStorage = (event: StorageEvent) => {
      if (event.key === "enter-profiles") {
        setProfiles(readProfiles());
        return;
      }
      if (event.key?.startsWith(OUTBOX_KEY_PREFIX)) {
        const profileId = event.key.slice(OUTBOX_KEY_PREFIX.length);
        if (!profileId) return;
        const entries = readOutboxProfile(profileId);
        setOutboxByProfile((current) => {
          if (entries.length === 0) {
            if (!(profileId in current)) return current;
            const { [profileId]: _removed, ...rest } = current;
            return rest;
          }
          return { ...current, [profileId]: entries };
        });
        return;
      }
      if (!activeProfileId || !event.key?.startsWith(MESSAGE_CACHE_KEY_PREFIX)) return;
      const profileId = event.key.slice(MESSAGE_CACHE_KEY_PREFIX.length);
      if (profileId !== activeProfileId) return;
      const cached = readMessageCache(profileId);
      if (!cached || (cached.updatedAt ?? 0) <= (cacheUpdatedAtRef.current[profileId] ?? 0)) return;
      cacheUpdatedAtRef.current[profileId] = cached.updatedAt ?? Date.now();
      skipNextCacheWriteRef.current = true;
      setMessagesByProfile((current) => {
        const existing = current[profileId] ?? EMPTY_MESSAGES;
        const incoming = Object.entries(cached.messages).flatMap(([conversationId, conversationMessages]) => conversationMessages.map((message) => ({ conversationId, message })));
        return { ...current, [profileId]: mergeRemoteMessages(existing, incoming) };
      });
      if (cached.conversations) {
        setConversations((current) => {
          const cachedIds = new Set(cached.conversations!.map((conversation) => conversation.id));
          const localOnly = current.filter((conversation) => !cachedIds.has(conversation.id));
          const localById = new Map(current.map((conversation) => [conversation.id, conversation]));
          return [...cached.conversations!.map((conversation) => {
            const local = localById.get(conversation.id);
            return local ? { ...conversation, pinned: local.pinned, muted: local.muted, archived: local.archived, deleted: local.deleted, folder: local.folder } : conversation;
          }), ...localOnly];
        });
      }
      setSyncCursors((current) => ({ ...current, [profileId]: Math.max(current[profileId] ?? 0, cached.cursor) }));
    };
    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
  }, [activeProfileId]);

  useEffect(() => {
    if (activeProfileId && profiles.some((profile) => profile.id === activeProfileId)) return;
    const nextProfileId = profiles[0]?.id ?? null;
    setActiveProfileId(nextProfileId);
    setActiveConversationId(nextProfileId ? readTabState().activeConversationByProfile?.[nextProfileId] ?? null : null);
  }, [activeProfileId, profiles]);

  useEffect(() => {
    if (!activeProfile || !activeConversationId) return;
    let cancelled = false;
    setConversations((current) => current.some((conversation) => conversation.id === activeConversationId && (conversation.unread ?? 0) > 0)
      ? current.map((conversation) => conversation.id === activeConversationId ? { ...conversation, unread: 0 } : conversation)
      : current);
    const markRead = () => {
      if (document.visibilityState !== "visible") return;
      void markConversationRead(activeProfile, activeConversationId).then(() => {
        if (cancelled) return;
        setConversations((current) => current.map((conversation) => conversation.id === activeConversationId ? { ...conversation, unread: 0 } : conversation));
      }).catch(() => undefined);
    };
    markRead();
    document.addEventListener("visibilitychange", markRead);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", markRead);
    };
  }, [activeConversationId, activeProfile?.id, activeProfile?.token, messages.length]);

  useEffect(() => {
    if (!activeProfile || showAuth) return;
    setSyncConnected(false);
    let cancelled = false;
    let cursor = syncCursorsRef.current[activeProfile.id] ?? 0;
    let ownBundle: PublicDeviceKey | null = null;
    let ownAccount: PublicAccountKey | null = null;
    let preparing = false;
    let nextPrepareAt = 0;
    const historySyncInFlight = new Set<string>();
    const historySyncComplete = new Set<string>();
    const historySyncSent = new Map<string, Set<string>>();
    const profile = activeProfile;
    const senderDeviceCache = new Map<string, Promise<PublicDeviceKey[]>>();

    function senderDevicesFor(address: string) {
      const cached = senderDeviceCache.get(address);
      if (cached) return cached;
      const request = fetchPublicDeviceKeys(profile, address);
      senderDeviceCache.set(address, request);
      return request;
    }

    function historyMessageKey(message: Message) {
      return `${message.id}:${message.text}`;
    }

    async function ensureOwnBundle() {
      if (ownBundle || preparing || Date.now() < nextPrepareAt) return ownBundle;
      preparing = true;
      try {
        const prepared = await prepareProfile(profile);
        if (!prepared.account) {
          setMessageError("Для переноса истории войдите в аккаунт заново");
          setShowAuth(true);
          return null;
        }
        ownBundle = prepared.bundle;
        ownAccount = prepared.account;
        nextPrepareAt = 0;
        return ownBundle;
      } catch (reason) {
        nextPrepareAt = Date.now() + 5000;
        if (isUnauthorized(reason)) {
          setMessageError("РЎРµСЃСЃРёСЏ СЃРµСЂРІРµСЂР° РёСЃС‚РµРєР»Р°. Р’РѕР№РґРёС‚Рµ СЃРЅРѕРІР°");
          setShowAuth(true);
        }
        return null;
      } finally {
        preparing = false;
      }
    }

    async function backfillHistoryToAccount() {
      const target = ownAccount;
      if (cancelled || !ownBundle || !target) return;
      const profileMessages = messagesByProfileRef.current[profile.id] ?? EMPTY_MESSAGES;
      const history = Object.entries(profileMessages).flatMap(([conversationId, conversationMessages]) => conversationMessages.filter((message) => !message.editOf).map((message) => ({ conversationId, message })));
      if (history.length === 0) return;
      const sent = historySyncSent.get(target.keyId) ?? new Set<string>();
      const pendingHistory = history.filter(({ message }) => !sent.has(historyMessageKey(message)));
      if (pendingHistory.length === 0) return;
      const historyVersion = `${pendingHistory.length}:${pendingHistory[pendingHistory.length - 1]?.message.id ?? ""}`;
      const targetKey = `${target.keyId}:${historyVersion}`;
      if (historySyncComplete.has(targetKey) || historySyncInFlight.has(targetKey)) return;
      historySyncInFlight.add(targetKey);
      try {
        for (let index = 0; index < pendingHistory.length; index += 50) {
          const chunk = pendingHistory.slice(index, index + 50);
          const entries = await Promise.all(chunk.map(async ({ conversationId, message }): Promise<DeviceHistoryEntry> => ({
            conversationId,
            messageId: message.id,
            sourceKeyId: message.envelope?.key_id,
            envelope: await encryptMessage(profile, conversationId, message, target),
          })));
          await syncDeviceHistory(profile, entries);
          chunk.forEach(({ message }) => sent.add(historyMessageKey(message)));
        }
        historySyncSent.set(target.keyId, sent);
        historySyncComplete.add(targetKey);
      } catch (reason) {
        if (isUnauthorized(reason)) setShowAuth(true);
      } finally {
        historySyncInFlight.delete(targetKey);
      }
    }

    async function backfillHistoryToDevices() {
      const sourceBundle = ownBundle;
      if (cancelled || !sourceBundle) return;
      let devices: PublicDeviceKey[];
      try {
        devices = await allDeviceKeys(profile, sourceBundle);
      } catch {
        return;
      }
      const profileMessages = messagesByProfileRef.current[profile.id] ?? EMPTY_MESSAGES;
      const history = Object.entries(profileMessages).flatMap(([conversationId, conversationMessages]) => conversationMessages.filter((message) => !message.editOf).map((message) => ({ conversationId, message })));
      if (history.length === 0) return;

      for (const target of devices) {
        if (target.keyId === sourceBundle.keyId) continue;
        const sent = historySyncSent.get(target.keyId) ?? new Set<string>();
        const pendingHistory = history.filter(({ message }) => !sent.has(historyMessageKey(message)));
        if (pendingHistory.length === 0) continue;
        const historyVersion = `${pendingHistory.length}:${pendingHistory[pendingHistory.length - 1]?.message.id ?? ""}`;
        const targetKey = `${target.deviceId}:${target.keyId}:${historyVersion}`;
        if (historySyncComplete.has(targetKey) || historySyncInFlight.has(targetKey)) continue;
        historySyncInFlight.add(targetKey);
        try {
          for (let index = 0; index < pendingHistory.length; index += 50) {
            const chunk = pendingHistory.slice(index, index + 50);
            const entries = await Promise.all(chunk.map(async ({ conversationId, message }): Promise<DeviceHistoryEntry> => ({
              conversationId,
              messageId: message.id,
              sourceKeyId: message.envelope?.key_id,
              envelope: await encryptMessage(profile, conversationId, message, target),
            })));
            await syncDeviceHistory(profile, entries);
            chunk.forEach(({ message }) => sent.add(historyMessageKey(message)));
          }
          historySyncSent.set(target.keyId, sent);
          historySyncComplete.add(targetKey);
        } catch (reason) {
          if (isUnauthorized(reason)) {
            setMessageError("Сессия сервера истекла. Войдите снова");
            setShowAuth(true);
          }
        } finally {
          historySyncInFlight.delete(targetKey);
        }
      }
    }

    const knownConversationIds = new Set(conversations.map((conversation) => conversation.id));
    const seenMessageIds = new Set(Object.values(messagesByProfileRef.current[profile.id] ?? EMPTY_MESSAGES).flat().map((message) => message.id));
    let retryRealtime: () => void | Promise<void> = () => undefined;
    const advanceCursor = (nextCursor: number) => {
      if (nextCursor <= cursor) return;
      cursor = nextCursor;
      syncCursorsRef.current[profile.id] = nextCursor;
      setSyncCursors((current) => ({ ...current, [profile.id]: Math.max(current[profile.id] ?? 0, nextCursor) }));
    };

    async function applySyncResult(result: SyncResponse) {
      if (cancelled) return false;
      setSyncConnected(true);
      result.conversations.forEach((conversation) => knownConversationIds.add(conversation.id));
      setConversations((current) => result.conversations.map((remote) => {
        const mapped = mapRemoteConversation(remote);
        const local = current.find((conversation) => conversation.id === mapped.id);
        return local ? { ...mapped, pinned: local.pinned, muted: local.muted, archived: local.archived, deleted: local.deleted, folder: local.folder } : mapped;
      }));
      if (!(await ensureOwnBundle()) || cancelled || !ownBundle) return false;
      const ownKeyIds = new Set([ownBundle.keyId, ownAccount?.keyId].filter((value): value is string => Boolean(value)));
      const deviceMessages = result.messages.filter((message) => ownKeyIds.has(message.envelope.key_id));
      const decryptedMessages = (await Promise.all(deviceMessages.map(async (message) => {
        try {
          const senderDevices = await senderDevicesFor(message.envelope.sender);
          return { conversationId: message.conversationId, message: await decryptRemoteMessage(profile, message, senderDevices) };
        } catch {
          return null;
        }
      }))).filter((value): value is { conversationId: string; message: Message } => value !== null);
      const decryptFailures = deviceMessages.length - decryptedMessages.length;
      if (cancelled) return false;
      const acknowledged = [...new Set(decryptedMessages
        .filter(({ message }) => message.author === "them")
        .map(({ message }) => message.id))];
      try {
        await Promise.all(acknowledged.map((messageId) => acknowledgeMessage(profile, messageId)));
      } catch {
        if (!cancelled) setMessageError("Не удалось подтвердить получение сообщения. Синхронизация повторится.");
        return false;
      }
      decryptedMessages.forEach(({ message }) => seenMessageIds.add(message.id));
      setMessagesByProfile((current) => {
        const existing = current[profile.id] ?? EMPTY_MESSAGES;
        return { ...current, [profile.id]: mergeDeliveryReceipts(mergeReadReceipts(mergeRemoteMessages(existing, decryptedMessages), result.readReceipts), result.deliveryReceipts) };
      });
      if (decryptFailures === 0) advanceCursor(Math.max(cursor, result.nextCursor));
      setMessageError(decryptFailures > 0 ? `Не удалось расшифровать ${decryptFailures} сообщений. Курсор не сдвинут, синхронизация повторится.` : "");
      void backfillHistoryToAccount();
      void backfillHistoryToDevices();
      void retryOutboxForProfile(profile.id);
      return decryptFailures === 0;
    }

    const syncOnce = createSyncQueue(async () => {
      if (cancelled) return;
      try {
        cursor = Math.max(cursor, syncCursorsRef.current[profile.id] ?? 0);
        await applySyncResult(await syncProfile(profile, cursor));
      } catch (reason) {
        if (cancelled) return;
        setSyncConnected(false);
        if (isUnauthorized(reason)) {
          setMessageError("Сессия сервера истекла. Войдите снова");
          setShowAuth(true);
        }
        // Cached messages remain available while the server is offline or the session expired.
      }
      retryRealtime();
    });

    type DirectRealtimeEvent = Extract<RealtimeEvent, { cursor: number }>;
    async function applyRealtimeEvent(event: DirectRealtimeEvent) {
      if (event.type === "message") {
        if (!knownConversationIds.has(event.message.conversationId)) {
          const before = cursor;
          await syncOnce();
          return cursor > before;
        }
        if (!(await ensureOwnBundle()) || cancelled || !ownBundle) return false;
        const ownKeyIds = new Set([ownBundle.keyId, ownAccount?.keyId].filter((value): value is string => Boolean(value)));
        if (!ownKeyIds.has(event.message.envelope.key_id)) return true;
        try {
          const message = await decryptRemoteMessage(profile, event.message, await senderDevicesFor(event.message.envelope.sender));
          if (message.author === "them") {
            try {
              await acknowledgeMessage(profile, message.id);
            } catch {
              setMessageError("Не удалось подтвердить получение realtime-сообщения. Синхронизация повторится.");
              return false;
            }
          }
          const isNewMessage = !seenMessageIds.has(message.id);
          seenMessageIds.add(message.id);
          setMessagesByProfile((current) => {
            const existing = current[profile.id] ?? EMPTY_MESSAGES;
            return { ...current, [profile.id]: mergeRemoteMessages(existing, [{ conversationId: event.message.conversationId, message }]) };
          });
          if (isNewMessage && event.message.author === "them") {
            setConversations((current) => current.map((conversation) => conversation.id === event.message.conversationId && conversation.id !== activeConversationId ? { ...conversation, unread: (conversation.unread ?? 0) + 1 } : conversation));
            if (activeConversationIdRef.current !== event.message.conversationId || document.visibilityState !== "visible" || !document.hasFocus()) {
              const conversation = conversations.find((item) => item.id === event.message.conversationId);
              void notifyIncomingMessage({ profileId: profile.id, conversationId: event.message.conversationId, title: conversation?.name ?? "Enter", text: message.text });
            }
          }
          setMessageError("");
          return true;
        } catch {
          setMessageError("Не удалось расшифровать realtime-сообщение. Синхронизация повторится.");
          return false;
        }
      }
      setMessagesByProfile((current) => {
        const existing = current[profile.id] ?? EMPTY_MESSAGES;
        const messages = event.type === "readReceipt"
          ? mergeReadReceipts(existing, [{ messageId: event.messageId, readAt: event.readAt }])
          : mergeDeliveryReceipts(existing, [{ messageId: event.messageId, deliveredAt: event.deliveredAt }]);
        return { ...current, [profile.id]: messages };
      });
      return true;
    }

    const realtimeQueue = createRealtimeQueue<DirectRealtimeEvent>(() => cursor, advanceCursor, applyRealtimeEvent, syncOnce);
    retryRealtime = realtimeQueue.retry;
    let realtimeSnapshot = Promise.resolve();

    let realtime: WebSocket | null = null;
    let reconnectTimer: number | null = null;
    let fallbackInterval: number | null = null;
    let reconnectDelay = 1000;

    const startFallbackSync = () => {
      if (fallbackInterval === null) fallbackInterval = window.setInterval(() => void syncOnce(), 500);
    };
    const stopFallbackSync = () => {
      if (fallbackInterval !== null) {
        window.clearInterval(fallbackInterval);
        fallbackInterval = null;
      }
    };
    const scheduleRealtimeReconnect = () => {
      if (cancelled || reconnectTimer !== null) return;
      const delay = reconnectDelay;
      reconnectDelay = Math.min(30_000, reconnectDelay * 2);
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = null;
        connectRealtime();
      }, delay);
    };
    const handleRealtimeClose = () => {
      if (cancelled) return;
      startFallbackSync();
      scheduleRealtimeReconnect();
    };
    const connectRealtime = () => {
      if (cancelled) return;
      try {
        realtime = openRealtime(profile, cursor, (event) => {
          if (event.type === "ready") {
            reconnectDelay = 1000;
            stopFallbackSync();
            setSyncConnected(true);
          } else if (event.type === "sync") {
            realtimeSnapshot = realtimeSnapshot.then(() => applySyncResult(event)).then(() => realtimeQueue.retry());
          } else if (event.type === "message" || event.type === "readReceipt" || event.type === "deliveryReceipt") {
            realtimeSnapshot = realtimeSnapshot.then(() => { realtimeQueue.enqueue(event); });
          } else if (event.type === "presence") {
            setConversations((current) => current.map((conversation) => conversation.id === event.conversationId
              ? { ...conversation, online: event.online, lastSeenAt: event.lastSeenAt }
              : conversation));
          } else if (event.type === "error") {
            realtime?.close();
          }
        }, handleRealtimeClose);
      } catch {
        handleRealtimeClose();
      }
    };

    void (async () => {
      try {
        const cached = await readMessageCacheAsync(profile.id);
        if (cancelled) return;
        if (cached) {
          cacheUpdatedAtRef.current[profile.id] = Math.max(cacheUpdatedAtRef.current[profile.id] ?? 0, cached.updatedAt ?? 0);
          cursor = Math.max(cursor, cached.cursor);
          syncCursorsRef.current[profile.id] = Math.max(syncCursorsRef.current[profile.id] ?? 0, cursor);
          messagesByProfileRef.current = { ...messagesByProfileRef.current, [profile.id]: cached.messages };
          setMessagesByProfile((current) => ({ ...current, [profile.id]: cached.messages }));
          if (cached.conversations) setConversations(cached.conversations);
        }
        await syncOnce();
      } catch (reason) {
        if (cancelled) return;
        setSyncConnected(false);
        if (isUnauthorized(reason)) {
          setMessageError("Сессия сервера истекла. Войдите снова");
          setShowAuth(true);
        }
        // Cached messages remain available while the server is offline or the session expired.
      }
    })();
    connectRealtime();
    const wake = () => { if (document.visibilityState === "visible") void syncOnce(); };
    document.addEventListener("visibilitychange", wake);
    window.addEventListener("focus", wake);
    return () => {
      cancelled = true;
      realtime?.close();
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      stopFallbackSync();
      document.removeEventListener("visibilitychange", wake);
      window.removeEventListener("focus", wake);
    };
  }, [activeProfileId, activeProfile?.token, showAuth]);

  async function addProfile(profile: Profile, password: string) {
    const { device } = await prepareProfile(profile, password);
    const nextProfile = { ...profile, deviceId: device.deviceId };
    const nextProfiles = [...profiles.filter((item) => item.id !== nextProfile.id), nextProfile];
    setProfiles(nextProfiles);
    localStorage.setItem("enter-profiles", JSON.stringify(nextProfiles));
    setActiveProfileId(nextProfile.id);
    const cached = readMessageCache(nextProfile.id);
    setMessagesByProfile((current) => ({ ...current, [nextProfile.id]: cached?.messages ?? EMPTY_MESSAGES }));
    const cachedCursor = cached?.cursor ?? 0;
    syncCursorsRef.current[nextProfile.id] = cachedCursor;
    setSyncCursors((current) => ({ ...current, [nextProfile.id]: cachedCursor }));
    setConversations(cached?.conversations ?? []);
    setActiveConversationId(readTabState().activeConversationByProfile?.[nextProfile.id] ?? null);
    setActiveFolder(readTabState().activeFolderByProfile?.[nextProfile.id] ?? ALL_FOLDER);
    setShowAuth(false);
  }

  async function removeProfile(profile: Profile) {
    const nextProfiles = profiles.filter((item) => item.id !== profile.id);
    setProfiles(nextProfiles);
    localStorage.setItem("enter-profiles", JSON.stringify(nextProfiles));
    clearMessageCache(profile.id);
    void deleteDeviceKeys(profile.id).catch(() => undefined);
    setMessagesByProfile((current) => {
      const { [profile.id]: _removed, ...rest } = current;
      return rest;
    });
    setSyncCursors((current) => {
      const { [profile.id]: _removed, ...rest } = current;
      return rest;
    });
    delete syncCursorsRef.current[profile.id];
    setOutboxByProfile((current) => {
      const { [profile.id]: _removed, ...rest } = current;
      return rest;
    });
    if (activeProfileId === profile.id) {
      setActiveProfileId(nextProfiles[0]?.id ?? null);
      setActiveConversationId(null);
      setActiveFolder(ALL_FOLDER);
      setReplyTo(null);
      setEditingMessage(null);
    }
  }

  async function searchForUser(rawQuery: string) {
    if (!activeProfile) return;
    const requestId = ++searchRequestId.current;
    const query = rawQuery.trim();
    if (!query || (query.includes("@") && !/^@[^@]+(?:@[^@]+)?$/.test(query))) {
      setSearchResult(null);
      setSearchError("");
      setSearchBusy(false);
      return;
    }
    setSearchBusy(true);
    setSearchError("");
    setSearchResult(null);
    try {
      const result = await searchUser(activeProfile, query);
      if (requestId === searchRequestId.current) setSearchResult(result);
    } catch (reason) {
      if (requestId === searchRequestId.current) setSearchError(reason instanceof Error && reason.message.includes("404") ? "Пользователь не найден" : reason instanceof Error ? reason.message : "Пользователь не найден");
    } finally {
      if (requestId === searchRequestId.current) setSearchBusy(false);
    }
  }

  async function openSearchUser(user: SearchUser) {
    if (!activeProfile) return;
    if (user.deviceCount === 0) {
      setSearchError("У пользователя нет активного устройства");
      return;
    }
    const existing = conversations.find((conversation) => conversation.handle === user.address);
    if (existing) {
      setConversations((current) => current.map((conversation) => conversation.id === existing.id ? { ...conversation, deleted: false } : conversation));
      setActiveConversationId(existing.id);
      setSearchResult(null);
      setSearchError("");
      return;
    }
    try {
      const remote = await createConversation(activeProfile, user);
      const conversation = mapRemoteConversation(remote);
      setConversations((current) => current.some((item) => item.id === conversation.id) ? current : [...current, conversation]);
      setActiveConversationId(conversation.id);
      setSearchResult(null);
      setSearchError("");
    } catch {
      setSearchError("Не удалось создать диалог");
    }
  }

  function updateLocalMessage(profileId: string, conversationId: string, messageId: string, update: (message: Message) => Message) {
    setMessagesByProfile((current) => {
      const profileMessages = current[profileId] ?? EMPTY_MESSAGES;
      const messages = profileMessages[conversationId] ?? [];
      return { ...current, [profileId]: { ...profileMessages, [conversationId]: messages.map((item) => item.id === messageId ? update(item) : item) } };
    });
  }

  function queueOutbox(profileId: string, conversationId: string, message: Message) {
    setOutboxByProfile((current) => {
      const entries = current[profileId] ?? [];
      if (entries.some((entry) => entry.id === message.id)) return current;
      return { ...current, [profileId]: [...entries, { id: message.id, conversationId, message: { ...message, deliveryStatus: undefined }, attempts: 0, nextAttemptAt: Date.now() }] };
    });
  }

  function removeOutbox(profileId: string, messageId: string) {
    setOutboxByProfile((current) => {
      const entries = (current[profileId] ?? []).filter((entry) => entry.id !== messageId);
      return entries.length === (current[profileId] ?? []).length ? current : { ...current, [profileId]: entries };
    });
  }

  function failOutbox(profileId: string, messageId: string) {
    setOutboxByProfile((current) => {
      const entries = (current[profileId] ?? []).map((entry) => entry.id === messageId ? { ...entry, attempts: entry.attempts + 1, nextAttemptAt: Date.now() + retryDelay(entry.attempts + 1) } : entry);
      return { ...current, [profileId]: entries };
    });
  }

  async function sendMessageToConversation(conversationId: string, message: Message, pendingMedia: PendingMedia[] = [], fromOutbox = false) {
    if (!activeProfileId || !activeProfile) return;
    const profile = activeProfile;
    const conversation = conversations.find((item) => item.id === conversationId || (conversationId === "favorites" && item.handle === "favorites"));
    if (!conversation || conversation.canWrite === false) return;
    const targetConversationId = conversation.id;
    const isEdit = Boolean(message.editOf);
    setMessageError("");
    const hasPendingMedia = pendingMedia.length > 0 && !fromOutbox;
    if (hasPendingMedia) setMediaUploadProgress(0);
    if (!hasPendingMedia) queueOutbox(activeProfile.id, targetConversationId, message);
    if (fromOutbox) {
      updateLocalMessage(activeProfile.id, targetConversationId, message.id, (current) => ({ ...current, deliveryStatus: "pending" }));
    } else if (!isEdit && !hasPendingMedia) {
      const pendingMessage = { ...message, deliveryStatus: "pending" } satisfies Message;
      setMessagesByProfile((current) => {
        const profileMessages = current[activeProfile.id] ?? EMPTY_MESSAGES;
        return { ...current, [activeProfile.id]: { ...profileMessages, [targetConversationId]: [...(profileMessages[targetConversationId] ?? []), pendingMessage] } };
      });
      setConversations((current) => current.map((item) => item.id === targetConversationId ? { ...item, lastMessage: messagePreview(message), time: message.time } : item));
    }
    try {
      const { bundle, account } = await prepareProfile(profile);
      const isDirectConversation = Boolean(conversation.handle && conversation.handle !== "favorites");
      const [ownDevices, fetchedRecipientDevices, fetchedRecipientAccount] = await Promise.all([
        allDeviceKeys(profile, bundle),
        isDirectConversation ? fetchPublicDeviceKeys(profile, conversation.handle!) : Promise.resolve<PublicDeviceKey[]>([]),
        isDirectConversation ? fetchPublicAccountKey(profile, conversation.handle!) : Promise.resolve<PublicAccountKey | undefined>(undefined),
      ]);
      const recipientDevices = isDirectConversation ? fetchedRecipientDevices : ownDevices;
      const recipientAccount = isDirectConversation ? fetchedRecipientAccount : account;
      const recipients = [recipientAccount, ...recipientDevices, ...ownDevices].filter((device): device is PublicDeviceKey | PublicAccountKey => Boolean(device)).filter((device, index, devices) => devices.findIndex((item) => item.keyId === device.keyId) === index);
      const mediaRecipient = recipients[0]?.address;
      if (hasPendingMedia && !mediaRecipient) throw new Error("Не найден получатель вложения");
      let uploadedAttachments = message.attachments;
      if (hasPendingMedia) {
        uploadedAttachments = [];
        for (const [index, { file }] of pendingMedia.entries()) {
          const encrypted = await encryptMedia(file);
          await uploadMedia(profile, targetConversationId, encrypted.attachment.id, mediaRecipient!, encrypted.ciphertext, (progress) => setMediaUploadProgress(Math.round(((index + progress / 100) / pendingMedia.length) * 100)));
          uploadedAttachments.push(encrypted.attachment);
        }
        setMediaUploadProgress(100);
      }
      const messageToSend: Message = uploadedAttachments ? { ...message, attachments: uploadedAttachments } : message;
      if (hasPendingMedia) {
        queueOutbox(activeProfile.id, targetConversationId, messageToSend);
        if (!isEdit) {
          const pendingMessage = { ...messageToSend, deliveryStatus: "pending" } satisfies Message;
          setMessagesByProfile((current) => {
            const profileMessages = current[activeProfile.id] ?? EMPTY_MESSAGES;
            return { ...current, [activeProfile.id]: { ...profileMessages, [targetConversationId]: [...(profileMessages[targetConversationId] ?? []), pendingMessage] } };
          });
          setConversations((current) => current.map((item) => item.id === targetConversationId ? { ...item, lastMessage: messagePreview(messageToSend), time: messageToSend.time } : item));
        }
      }
      const envelopes = await Promise.all(recipients.map((recipient) => encryptMessage(profile, targetConversationId, messageToSend, recipient)));
      const localEnvelope = envelopes.find((envelope) => envelope.key_id === account?.keyId) ?? envelopes[0];
      const localMessage: Message = { ...messageToSend, envelope: localEnvelope, deliveryStatus: "pending" };
      updateLocalMessage(profile.id, targetConversationId, messageToSend.id, (current) => ({ ...current, ...localMessage }));
      const sent = await sendRemoteMessage(profile, targetConversationId, localMessage, envelopes);
      updateLocalMessage(profile.id, targetConversationId, messageToSend.id, (current) => ({ ...current, ...localMessage, time: formatMessageTime(new Date(sent.message.createdAt)), stackId: sent.message.stackId, deliveryStatus: undefined }));
      removeOutbox(profile.id, messageToSend.id);
      setMessageError("");
      setMediaUploadProgress(null);
    } catch (reason) {
      setMediaUploadProgress(null);
      updateLocalMessage(profile.id, targetConversationId, message.id, (current) => ({ ...current, deliveryStatus: "failed" }));
      failOutbox(profile.id, message.id);
      if (isUnauthorized(reason)) {
        setShowAuth(true);
        setMessageError("Сессия сервера истекла. Войдите снова");
        return;
      }
      setMessageError(hasPendingMedia ? "Не удалось загрузить вложение. Сообщение не отправлено." : "Сообщение сохранено локально. Повторю отправку после восстановления соединения.");
    }
  }

  async function retryOutboxForProfile(profileId: string) {
    if (activeProfileId !== profileId) return;
    const now = Date.now();
    for (const entry of outboxRef.current[profileId] ?? []) {
      if (entry.nextAttemptAt > now || retryingOutbox.current.has(entry.id)) continue;
      retryingOutbox.current.add(entry.id);
      void sendMessageToConversation(entry.conversationId, entry.message, [], true).finally(() => retryingOutbox.current.delete(entry.id));
    }
  }

  function sendMessage(message: Message, pendingMedia?: PendingMedia[]) {
    if (activeConversationId) void sendMessageToConversation(activeConversationId, message, pendingMedia);
  }

  function updateActiveMessage(messageId: string, update: (message: Message) => Message | null) {
    if (!activeProfileId || !activeConversationId) return;
    setMessagesByProfile((current) => {
      const profileMessages = current[activeProfileId] ?? EMPTY_MESSAGES;
      const nextMessages = (profileMessages[activeConversationId] ?? []).flatMap((message) => {
        if (message.id !== messageId) return [message];
        const next = update(message);
        return next ? [next] : [];
      });
      return { ...current, [activeProfileId]: { ...profileMessages, [activeConversationId]: nextMessages } };
    });
  }

  function replyToMessage(message: Message) {
    setEditingMessage(null);
    setReplyTo(message);
  }

  function editMessage(message: Message) {
    if (message.author !== "me") return;
    setReplyTo(null);
    setEditingMessage(message);
  }

  function applyMessageEdit(message: Message) {
    if (message.author !== "me") return;
    const conversationId = activeConversationId;
    updateActiveMessage(message.id, () => message);
    setEditingMessage(null);
    if (conversationId) {
      void sendMessageToConversation(conversationId, { id: makeId(), author: "me", text: message.text, time: message.time, editOf: message.id });
    }
  }

  function toggleMessagePinned(message: Message) {
    updateActiveMessage(message.id, (current) => ({ ...current, pinned: !current.pinned }));
  }

  function reactToMessage(message: Message, reaction: string) {
    updateActiveMessage(message.id, (current) => ({ ...current, reaction: current.reaction === reaction ? undefined : reaction }));
  }

  function deleteMessage(message: Message) {
    updateActiveMessage(message.id, () => null);
  }

  async function saveMessage(message: Message) {
    const favorites = conversations.find((conversation) => conversation.handle === "favorites");
    if (!favorites || !activeProfile) return;
    const savedMessage: Message = { ...message, id: makeId(), author: "me", time: formatMessageTime(), pinned: false, reaction: undefined, replyTo: undefined };
    await sendMessageToConversation(favorites.id, savedMessage);
  }

  async function forwardMessage(message: Message, conversationId: string) {
    const forwardedMessage: Message = {
      ...message,
      id: makeId(),
      author: "me",
      time: formatMessageTime(),
      replyTo: undefined,
      reaction: undefined,
      pinned: false,
      edited: undefined,
      envelope: undefined,
    };
    setMessageToForward(null);
    await sendMessageToConversation(conversationId, forwardedMessage);
  }

  function togglePinned(conversationId: string) {
    setConversations((current) => current.map((conversation) => conversation.id === conversationId ? { ...conversation, pinned: !conversation.pinned } : conversation));
  }

  function toggleMuted(conversationId: string) {
    setConversations((current) => current.map((conversation) => conversation.id === conversationId ? { ...conversation, muted: !conversation.muted } : conversation));
  }

  function markUnread(conversationId: string) {
    setConversations((current) => current.map((conversation) => conversation.id === conversationId ? { ...conversation, unread: Math.max(conversation.unread ?? 0, 1) } : conversation));
  }

  function archiveConversation(conversationId: string) {
    setConversations((current) => current.map((conversation) => conversation.id === conversationId ? { ...conversation, archived: true } : conversation));
    if (activeConversationId === conversationId) setActiveConversationId(null);
  }

  function addToFolder(conversationId: string) {
    setConversations((current) => current.map((conversation) => conversation.id === conversationId ? { ...conversation, folder: conversation.folder ? undefined : DEFAULT_FOLDER } : conversation));
  }

  function deleteConversation(conversationId: string) {
    setConversations((current) => current.map((conversation) => conversation.id === conversationId ? { ...conversation, deleted: true } : conversation));
    if (activeConversationId === conversationId) setActiveConversationId(null);
  }

  function reorderConversations(sourceId: string, targetId: string) {
    setConversations((current) => {
      const sourceIndex = current.findIndex((conversation) => conversation.id === sourceId);
      const targetIndex = current.findIndex((conversation) => conversation.id === targetId);
      if (sourceIndex < 0 || targetIndex < 0) return current;
      const next = [...current];
      const [moved] = next.splice(sourceIndex, 1);
      next.splice(targetIndex, 0, moved);
      return next;
    });
  }

  function selectProfile(profile: Profile) {
    if (activeProfileId) persistMessageCache(activeProfileId, messagesByProfile[activeProfileId] ?? EMPTY_MESSAGES, syncCursors[activeProfileId] ?? 0, conversations);
    const cached = readMessageCache(profile.id);
    setActiveProfileId(profile.id);
    setActiveConversationId(readTabState().activeConversationByProfile?.[profile.id] ?? null);
    setActiveFolder(readTabState().activeFolderByProfile?.[profile.id] ?? ALL_FOLDER);
    setConversations(cached?.conversations ?? []);
    setReplyTo(null);
    setEditingMessage(null);
    setMessageToForward(null);
    setSearchResult(null);
    setSearchError("");
  }

  function selectFolder(folder: string) {
    setActiveFolder(folder);
    if (folder !== ALL_FOLDER && activeConversation?.folder !== folder) setActiveConversationId(null);
  }

  if (profiles.length === 0 || showAuth) {
    return <AuthView onAuthenticated={addProfile} onCancel={profiles.length > 0 ? () => setShowAuth(false) : undefined} />;
  }

  return (
    <MessengerView
      profiles={profiles}
      activeProfile={activeProfile}
      folders={availableFolders}
      activeFolder={activeFolder}
      conversations={conversationsWithPreviews}
      syncConnected={syncConnected}
      activeConversationId={activeConversationId}
      activeConversation={activeConversation}
      messages={messages}
      messageToForward={messageToForward}
      showProfile={showProfile}
      showSettings={showSettings}
      messageError={messageError}
      mediaUploadProgress={mediaUploadProgress}
      replyTo={replyTo}
      editingMessage={editingMessage}
      onSelectProfile={selectProfile}
      onRemoveProfile={removeProfile}
      onAddProfile={() => setShowAuth(true)}
      searchUser={searchResult}
      searchBusy={searchBusy}
      searchError={searchError}
      onSearchUser={searchForUser}
      onOpenSearchUser={openSearchUser}
      onSelectConversation={setActiveConversationId}
      onSelectFolder={selectFolder}
      onTogglePinned={togglePinned}
      onToggleMuted={toggleMuted}
      onMarkUnread={markUnread}
      onArchive={archiveConversation}
      onAddToFolder={addToFolder}
      onDelete={deleteConversation}
      onReorder={reorderConversations}
      onBack={() => { setActiveConversationId(null); setShowProfile(false); setShowSettings(false); }}
      onToggleProfile={() => { setShowProfile((value) => !value); setShowSettings(false); }}
      onCloseProfile={() => setShowProfile(false)}
      onToggleSettings={() => { setShowSettings((value) => !value); setShowProfile(false); }}
      onCloseSettings={() => setShowSettings(false)}
      onSendMessage={sendMessage}
      onReply={replyToMessage}
      onStartEditMessage={editMessage}
      onEditMessage={applyMessageEdit}
      onToggleMessagePinned={toggleMessagePinned}
      onSaveMessage={saveMessage}
      onDeleteMessage={deleteMessage}
      onReactToMessage={reactToMessage}
      onForwardMessage={setMessageToForward}
      onSendForwardedMessage={forwardMessage}
      onCloseForward={() => setMessageToForward(null)}
      onCancelMessageContext={() => { setReplyTo(null); setEditingMessage(null); }}
    />
  );
}
