import { useEffect, useRef, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { AuthView } from "./views/auth-view";
import { MessengerView } from "./views/messenger-view";
import { readTabState, writeTabState } from "./lib/app-state";
import { EMPTY_MESSAGES } from "./lib/empty-messages";
import { clearMessageCache, MESSAGE_CACHE_KEY_PREFIX, readMessageCache, readMessageCacheAsync, writeMessageCache } from "./lib/message-cache";
import { acknowledgeMessage, createConversation, downloadMedia, fetchPublicAccountKey, fetchPublicDeviceKeys, mapRemoteConversation, markConversationRead, openRealtime, registerDeviceKey, searchUser, sendMessage as sendRemoteMessage, syncDeviceHistory, syncProfile, updateAccountFolders, type DeviceHistoryEntry, type RealtimeClose, type RealtimeEvent, type RemoteMessage, type SearchUser, type SyncResponse, uploadMedia } from "./lib/enter-api";
import { accountKeyBundle, decodeMessagePayload, decryptMessage, deleteDeviceKeys, deviceKeyBundle, encryptMessage, ensureAccountKey, ensureDeviceKeys, readAccountKey, type PublicAccountKey, type PublicDeviceKey } from "./lib/e2e";
import { decryptMedia, encryptMedia, encryptMediaBytes } from "./lib/media";
import type { PendingMedia } from "./components/message-composer";
import { formatMessageTime, makeId } from "./lib/utils";
import { migrateLocalServerAddress, normalizeServerAddress } from "./lib/server-address";
import { createRealtimeQueue, createSyncQueue } from "./lib/sync-queue";
import { notifyIncomingMessage, subscribeToNotificationActions } from "./lib/notifications";
import { applyLocalSettings, readLocalSettings, writeLocalSettings, type LocalClientSettings } from "./lib/local-settings";
import { SettingsPanel } from "./components/settings-panel";
import { LogsPanel } from "./components/logs-panel";
import { FolderDialog } from "./components/folder-dialog";
import { logEvent } from "./lib/logs";
import { friendlyError } from "./lib/client-errors";
import { folderContains, readFolders, writeFolders } from "./lib/folders";
import type { AppPanel } from "./components/app-rail";
import type { ChatFolder, Conversation, Message, OutboxEntry, Profile } from "./types";
import { messagePreview } from "../../common/src/messages.ts";
import { formatProfileAddress } from "../../common/src/address.ts";
import { applyBeforeAcknowledge, isUnauthorized, mergeRemoteMessages, reconcileRemoteMessages, retryDelay } from "../../common/src/message-state.ts";
import { clearConversationUnread, incrementConversationUnread } from "../../common/src/conversations.ts";
import { createPresenceLifecycle } from "../../common/src/presence-lifecycle.ts";
import { createPresenceStateMachine, PRESENCE_HEARTBEAT_TIMEOUT_MS, shouldKeepPresenceConnection } from "../../common/src/presence.ts";
import { markMessageStateApplied, timingElapsed, timingNow } from "../../common/src/timing.ts";

const LEGACY_OUTBOX_KEY = "enter-outbox";
const OUTBOX_KEY_PREFIX = "enter-outbox:";
const ALL_FOLDER = "all";
const MAX_DECRYPT_RETRIES = 3;
const MAX_OUTBOX_ENTRIES = 100;
const MAX_OUTBOX_ATTEMPTS = 5;

function isStoredProfile(value: unknown): value is Profile {
  if (!value || typeof value !== "object") return false;
  const profile = value as Partial<Profile>;
  return typeof profile.id === "string"
    && typeof profile.name === "string"
    && typeof profile.handle === "string"
    && typeof profile.server === "string"
    && typeof profile.color === "string"
    && typeof profile.token === "string"
    && profile.token.length > 0;
}

function readProfiles() {
  try {
    const stored = localStorage.getItem("enter-profiles");
    const parsed = stored ? JSON.parse(stored) : null;
    if (!Array.isArray(parsed)) return [];
    const profiles = parsed.filter(isStoredProfile);
    const migrated = profiles.map((profile) => {
      const server = normalizeServerAddress(migrateLocalServerAddress(profile.server));
      return server ? { ...profile, server } : null;
    }).filter((profile): profile is Profile => profile !== null);
    if (migrated.length !== profiles.length || migrated.some((profile, index) => profile.server !== profiles[index]?.server)) {
      try { localStorage.setItem("enter-profiles", JSON.stringify(migrated)); } catch { /* Keep valid profiles in memory. */ }
    }
    return migrated;
  } catch {
    return [];
  }
}

function isStoredOutboxEntry(value: unknown): value is OutboxEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<OutboxEntry>;
  const message = entry.message as Partial<Message> | undefined;
  return typeof entry.id === "string"
    && typeof entry.conversationId === "string"
    && Boolean(message)
    && typeof message?.id === "string"
    && (message.author === "me" || message.author === "them")
    && typeof message.text === "string"
    && typeof message.time === "string"
    && typeof entry.attempts === "number"
    && Number.isFinite(entry.attempts)
    && entry.attempts >= 0
    && typeof entry.nextAttemptAt === "number"
    && Number.isFinite(entry.nextAttemptAt);
}

function sanitizeOutbox(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value
    .filter(isStoredOutboxEntry)
    .filter((entry) => entry.attempts < MAX_OUTBOX_ATTEMPTS)
    .map((entry) => ({ ...entry, attempts: Math.floor(entry.attempts) }))
    .slice(-MAX_OUTBOX_ENTRIES);
}

function readOutbox(): Record<string, OutboxEntry[]> {
  const outbox: Record<string, OutboxEntry[]> = {};
  try {
    const legacy = JSON.parse(localStorage.getItem(LEGACY_OUTBOX_KEY) ?? "{}");
    if (legacy && typeof legacy === "object" && !Array.isArray(legacy)) {
      for (const [profileId, entries] of Object.entries(legacy)) {
        const sanitized = sanitizeOutbox(entries);
        if (sanitized.length > 0) outbox[profileId] = sanitized;
      }
    }
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (!key?.startsWith(OUTBOX_KEY_PREFIX)) continue;
      const profileId = key.slice(OUTBOX_KEY_PREFIX.length);
      const parsed = JSON.parse(localStorage.getItem(key) ?? "[]");
      const sanitized = sanitizeOutbox(parsed);
      if (profileId && sanitized.length > 0) outbox[profileId] = sanitized;
    }
  } catch {
    // Outbox recovery must not block app startup.
  }
  return outbox;
}

function readOutboxProfile(profileId: string) {
  try {
    const parsed = JSON.parse(localStorage.getItem(`${OUTBOX_KEY_PREFIX}${profileId}`) ?? "[]");
    return sanitizeOutbox(parsed);
  } catch {
    return [];
  }
}

async function prepareProfile(profile: Profile, password?: string) {
  const device = await ensureDeviceKeys(profile.id);
  const account = password ? await ensureAccountKey(profile.id, password) : await readAccountKey(profile.id);
  await registerDeviceKey(profile, deviceKeyBundle(device), account ? { keyId: account.keyId, encryptionPublicKey: accountKeyBundle(account, formatProfileAddress(profile.handle, profile.server)).encryptionPublicKey } : undefined);
  logEvent("crypto", "Device keys ready", password ? "after sign-in" : "local key check", "success");
  return { device, account: account ? accountKeyBundle(account, formatProfileAddress(profile.handle, profile.server)) : null, bundle: { ...deviceKeyBundle(device), address: formatProfileAddress(profile.handle, profile.server) } satisfies PublicDeviceKey };
}

async function allDeviceKeys(profile: Profile, ownBundle: PublicDeviceKey) {
  try {
    const keys = await fetchPublicDeviceKeys(profile, formatProfileAddress(profile.handle, profile.server));
    return keys.some((key) => key.keyId === ownBundle.keyId) ? keys : [ownBundle, ...keys];
  } catch {
    return [ownBundle];
  }
}

async function decryptRemoteMessage(profile: Profile, remote: RemoteMessage, knownSenderDevices?: PublicDeviceKey[]): Promise<Message> {
  const senderDevices = knownSenderDevices ?? await fetchPublicDeviceKeys(profile, remote.encryptedMessage.sender);
  const sender = senderDevices.find((device) => device.deviceId === remote.encryptedMessage.sender_device);
  if (!sender) throw new Error("Ключ устройства отправителя не найден");
  const payload = decodeMessagePayload(await decryptMessage(profile, remote.encryptedMessage, sender));
  return {
    id: remote.encryptedMessage.message_id,
    author: remote.author,
    text: payload.text,
    editOf: payload.editOf,
    attachments: payload.attachments,
    replyTo: payload.replyTo,
    reactionEvent: payload.reactionEvent,
    time: formatMessageTime(new Date(remote.createdAt)),
    stackId: remote.stackId,
    encryptedMessage: remote.encryptedMessage,
  };
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
  const [localSettings, setLocalSettings] = useState<LocalClientSettings>(() => readLocalSettings());
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const [editingMessage, setEditingMessage] = useState<Message | null>(null);
  const [messageToForward, setMessageToForward] = useState<Message | null>(null);
  const [conversations, setConversations] = useState<Conversation[]>(() => readMessageCache(activeProfileId, localSettings.cachePolicy)?.conversations ?? []);
  const [messagesByProfile, setMessagesByProfile] = useState<Record<string, Record<string, Message[]>>>(() => Object.fromEntries(profiles.map((profile) => [profile.id, readMessageCache(profile.id, localSettings.cachePolicy)?.messages ?? EMPTY_MESSAGES])));
  const [syncCursors, setSyncCursors] = useState<Record<string, number>>(() => Object.fromEntries(profiles.map((profile) => [profile.id, readMessageCache(profile.id, localSettings.cachePolicy)?.cursor ?? 0])));
  const [outboxByProfile, setOutboxByProfile] = useState<Record<string, OutboxEntry[]>>(readOutbox);
  const [syncConnected, setSyncConnected] = useState(false);
  const [showAuth, setShowAuth] = useState(false);
  const [activePanel, setActivePanel] = useState<AppPanel>(() => {
    const state = readTabState();
    return state.panel ?? (state.showProfile ? "profile" : "chats");
  });
  const [foldersByProfile, setFoldersByProfile] = useState<Record<string, ChatFolder[]>>(() => Object.fromEntries(profiles.map((profile) => [profile.id, readFolders(profile.id)])));
  const [folderEditor, setFolderEditor] = useState<ChatFolder | "new" | null>(null);
  const [folderPickerConversationId, setFolderPickerConversationId] = useState<string | null>(null);
  const [searchResult, setSearchResult] = useState<SearchUser | null>(null);
  const [searchBusy, setSearchBusy] = useState(false);
  const [searchError, setSearchError] = useState("");
  const searchRequestId = useRef(0);
  const [messageError, setMessageError] = useState("");
  const [mediaUploadProgress, setMediaUploadProgress] = useState<number | null>(null);
  const messagesByProfileRef = useRef(messagesByProfile);
  const activeConversationIdRef = useRef(activeConversationId);
  const activePanelRef = useRef<AppPanel>(activePanel);
  const syncCursorsRef = useRef(syncCursors);
  const outboxRef = useRef(outboxByProfile);
  const retryingOutbox = useRef(new Set<string>());
  const cacheUpdatedAtRef = useRef<Record<string, number>>(Object.fromEntries(profiles.map((profile) => [profile.id, readMessageCache(profile.id, localSettings.cachePolicy)?.updatedAt ?? 0])));
  const skipNextCacheWriteRef = useRef(false);
  const persistedOutboxProfilesRef = useRef(new Set(Object.keys(outboxByProfile)));
  const mediaOperationRef = useRef(0);
  const mediaAbortRef = useRef<AbortController | null>(null);
  activeConversationIdRef.current = activeConversationId;
  activePanelRef.current = activePanel;
  const folderWritesRef = useRef<Record<string, Promise<void>>>({});

  useEffect(() => {
    applyLocalSettings(localSettings);
  }, [localSettings]);

  useEffect(() => {
    if (localSettings.cachePolicy === "disabled") profiles.forEach((profile) => clearMessageCache(profile.id));
  }, [localSettings.cachePolicy, profiles]);

  useEffect(() => {
    Object.entries(foldersByProfile).forEach(([profileId, folders]) => writeFolders(profileId, folders));
  }, [foldersByProfile]);

  function cancelMediaOperation() {
    mediaOperationRef.current += 1;
    mediaAbortRef.current?.abort();
    mediaAbortRef.current = null;
    setMediaUploadProgress(null);
  }

  function setOutboxProfile(profileId: string, entries: OutboxEntry[]) {
    const next = { ...outboxRef.current };
    if (entries.length > 0) next[profileId] = entries;
    else delete next[profileId];
    outboxRef.current = next;
    setOutboxByProfile(next);
  }

  function persistMessageCache(profileId: string, profileMessages: Record<string, Message[]>, cursor: number, profileConversations: Conversation[]) {
    cacheUpdatedAtRef.current[profileId] = writeMessageCache(profileId, profileMessages, cursor, profileConversations, localSettings.cachePolicy);
  }

  function setFoldersAndSync(profileId: string, nextFolders: ChatFolder[]) {
    setFoldersByProfile((current) => ({ ...current, [profileId]: nextFolders }));
    const profile = profiles.find((item) => item.id === profileId);
    if (!profile) return;
    const previous = folderWritesRef.current[profileId] ?? Promise.resolve();
    const write = previous.catch(() => undefined).then(async () => {
      const saved = await updateAccountFolders(profile, nextFolders);
      setFoldersByProfile((current) => ({ ...current, [profileId]: saved }));
    }).catch((reason) => {
      if (isUnauthorized(reason)) setShowAuth(true);
      setMessageError(friendlyError(reason, "Не удалось сохранить папки"));
    });
    folderWritesRef.current[profileId] = write;
  }

  const activeProfile = profiles.find((profile) => profile.id === activeProfileId);
  const activeConversation = conversations.find((conversation) => conversation.id === activeConversationId);
  const availableFolders = activeProfileId ? foldersByProfile[activeProfileId] ?? [] : [];
  const folderPickerConversation = conversations.find((conversation) => conversation.id === folderPickerConversationId);
  const activeProfileMessages = activeProfileId ? messagesByProfile[activeProfileId] ?? EMPTY_MESSAGES : EMPTY_MESSAGES;
  const messages = activeConversationId ? (activeProfileMessages[activeConversationId] ?? []).filter((message) => !message.editOf) : [];
  const cachedMessageCount = Object.values(activeProfileMessages).reduce((total, items) => total + items.length, 0);
  const activeOutboxCount = activeProfileId ? outboxByProfile[activeProfileId]?.length ?? 0 : 0;
  const conversationsWithPreviews = conversations.map((conversation) => {
    const conversationMessages = (activeProfileMessages[conversation.id] ?? []).filter((message) => !message.editOf);
    const latestMessage = conversationMessages[conversationMessages.length - 1];
    return latestMessage ? { ...conversation, lastMessage: messagePreview(latestMessage), time: latestMessage.time } : { ...conversation, lastMessage: "", time: "" };
  });

  useEffect(() => {
    messagesByProfileRef.current = messagesByProfile;
  }, [messagesByProfile]);

  useEffect(() => {
    let active = true;
    let dispose: (() => void) | null = null;
    void subscribeToNotificationActions((profileId, conversationId) => {
      if (!profiles.some((profile) => profile.id === profileId)) return;
      setActiveProfileId(profileId);
      selectConversation(conversationId);
      setActivePanel("chats");
    }).then((cleanup) => {
      if (active) dispose = cleanup;
      else cleanup();
    });
    const openConversation = (event: Event) => {
      const detail = (event as CustomEvent<{ profileId?: string; conversationId?: string }>).detail;
      if (!detail?.profileId || !detail.conversationId || !profiles.some((profile) => profile.id === detail.profileId)) return;
      setActiveProfileId(detail.profileId);
      selectConversation(detail.conversationId);
      setActivePanel("chats");
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
  }, [activeProfileId, conversations, localSettings.cachePolicy, messagesByProfile, syncCursors]);

  useEffect(() => {
    if (!activeProfileId) return;
    const flush = () => persistMessageCache(activeProfileId, messagesByProfile[activeProfileId] ?? EMPTY_MESSAGES, syncCursors[activeProfileId] ?? 0, conversations);
    window.addEventListener("pagehide", flush);
    return () => window.removeEventListener("pagehide", flush);
  }, [activeProfileId, conversations, localSettings.cachePolicy, messagesByProfile, syncCursors]);

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
      panel: activePanel,
    });
  }, [activeConversationId, activeFolder, activePanel, activeProfileId]);

  useEffect(() => {
    const cached = activeProfileId ? readMessageCache(activeProfileId, localSettings.cachePolicy) : null;
    setConversations(cached?.conversations ?? []);
    setActiveConversationId(activeProfileId ? readTabState().activeConversationByProfile?.[activeProfileId] ?? null : null);
    setActiveFolder(activeProfileId ? readTabState().activeFolderByProfile?.[activeProfileId] ?? ALL_FOLDER : ALL_FOLDER);
  }, [activeProfileId, localSettings.cachePolicy]);

  useEffect(() => {
    if (activeFolder !== ALL_FOLDER && !availableFolders.some((folder) => folder.id === activeFolder)) setActiveFolder(ALL_FOLDER);
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
      const cached = readMessageCache(profileId, localSettings.cachePolicy);
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
            return local ? { ...conversation, pinned: local.pinned, muted: local.muted, archived: local.archived, deleted: local.deleted } : conversation;
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
    if (!activeProfile || !activeConversationId || activePanel !== "chats") return;
    let cancelled = false;
    setConversations((current) => clearConversationUnread(current, activeConversationId, true));
    const markRead = () => {
      if (document.visibilityState !== "visible" || !document.hasFocus()) return;
      void markConversationRead(activeProfile, activeConversationId).then(() => {
        if (cancelled) return;
        setConversations((current) => clearConversationUnread(current, activeConversationId, true));
      }).catch(() => undefined);
    };
    markRead();
    document.addEventListener("visibilitychange", markRead);
    window.addEventListener("focus", markRead);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", markRead);
      window.removeEventListener("focus", markRead);
    };
  }, [activeConversationId, activePanel, activeProfile?.id, activeProfile?.token, messages.length]);

  useEffect(() => {
    if (!activeProfile || showAuth) return;
    setSyncConnected(false);
    let cancelled = false;
    const isWindowForeground = () => document.visibilityState === "visible" && document.hasFocus();
    let foreground = isWindowForeground();
    const presence = createPresenceStateMachine({
      appActive: foreground,
      visible: document.visibilityState === "visible",
      focused: document.hasFocus(),
      networkOnline: navigator.onLine !== false,
      realtimeReady: false,
      lastHeartbeatAt: null,
    });
    const presenceConnectionAllowed = () => shouldKeepPresenceConnection(presence.getInputs());
    const visibleActiveConversationId = () => (
      foreground && activePanelRef.current === "chats" && document.visibilityState === "visible" && document.hasFocus()
        ? activeConversationIdRef.current
        : null
    );
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
    const decryptAttempts = new Map<string, number>();
    const quarantinedMessageIds = new Set<string>();
    let syncNotificationsReady = false;
    let syncNotificationsAllowed = false;

    function senderDevicesFor(address: string) {
      const cached = senderDeviceCache.get(address);
      if (cached) return cached;
      const request = fetchPublicDeviceKeys(profile, address);
      senderDeviceCache.set(address, request);
      void request.catch(() => {
        if (senderDeviceCache.get(address) === request) senderDeviceCache.delete(address);
      });
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
        logEvent("crypto", "Own device key loaded", undefined, "success");
        return ownBundle;
      } catch (reason) {
        nextPrepareAt = Date.now() + 5000;
        logEvent("crypto", "Failed to prepare device keys", reason instanceof Error ? reason.message : "Key error", "error");
        if (isUnauthorized(reason)) {
          setMessageError("Сессия сервера истекла. Войдите снова");
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
            sourceKeyId: message.encryptedMessage?.key_id,
            encryptedMessage: await encryptMessage(profile, conversationId, message, target),
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
              sourceKeyId: message.encryptedMessage?.key_id,
              encryptedMessage: await encryptMessage(profile, conversationId, message, target),
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
    const realtimeReceivedAt = new Map<number, number>();
    let retryRealtime: () => void | Promise<void> = () => undefined;
    const advanceCursor = (nextCursor: number) => {
      if (nextCursor <= cursor) return;
      cursor = nextCursor;
      syncCursorsRef.current[profile.id] = nextCursor;
      setSyncCursors((current) => ({ ...current, [profile.id]: Math.max(current[profile.id] ?? 0, nextCursor) }));
    };

    async function applySyncResult(result: SyncResponse) {
      if (cancelled || !presenceConnectionAllowed()) return false;
      logEvent("sync", "Sync package received", `chats ${result.conversations.length}, messages ${result.messages.length}, cursor ${result.nextCursor}`);
      setSyncConnected(true);
      if (result.folders) setFoldersByProfile((current) => ({ ...current, [profile.id]: result.folders! }));
      result.conversations.forEach((conversation) => knownConversationIds.add(conversation.id));
      setConversations((current) => clearConversationUnread(result.conversations.map((remote) => {
        const mapped = mapRemoteConversation(remote);
        const local = current.find((conversation) => conversation.id === mapped.id);
        return local ? { ...mapped, pinned: local.pinned, muted: local.muted, archived: local.archived, deleted: local.deleted } : mapped;
      }), visibleActiveConversationId()));
      if (!(await ensureOwnBundle()) || cancelled || !presenceConnectionAllowed() || !ownBundle) return false;
      const ownKeyIds = new Set([ownBundle.keyId, ownAccount?.keyId].filter((value): value is string => Boolean(value)));
      const deviceMessages = result.messages.filter((message) => ownKeyIds.has(message.encryptedMessage.key_id));
      let quarantinedCount = 0;
      const retryingFailures: string[] = [];
      const decryptedMessages = (await Promise.all(deviceMessages.map(async (message) => {
        const messageId = message.encryptedMessage.message_id;
        if (quarantinedMessageIds.has(messageId)) {
          quarantinedCount += 1;
          return null;
        }
        try {
          const senderDevices = await senderDevicesFor(message.encryptedMessage.sender);
          const decrypted = await decryptRemoteMessage(profile, message, senderDevices);
          decryptAttempts.delete(messageId);
          return { conversationId: message.conversationId, message: decrypted };
        } catch (reason) {
          logEvent("crypto", "Message decryption failed", reason instanceof Error ? reason.message : "Decryption error", "error");
          const attempts = (decryptAttempts.get(messageId) ?? 0) + 1;
          if (attempts >= MAX_DECRYPT_RETRIES) {
            quarantinedMessageIds.add(messageId);
            decryptAttempts.delete(messageId);
            quarantinedCount += 1;
          } else {
            decryptAttempts.set(messageId, attempts);
            retryingFailures.push(messageId);
          }
          return null;
        }
      }))).filter((value): value is { conversationId: string; message: Message } => value !== null);
      logEvent("crypto", "Sync decryption completed", `success ${decryptedMessages.length}, retries ${retryingFailures.length}, skipped ${quarantinedCount}`, retryingFailures.length || quarantinedCount ? "warn" : "success");
      if (cancelled || !presenceConnectionAllowed()) return false;
      const newIncomingMessages = decryptedMessages.filter(({ message }) => message.author === "them" && !message.reactionEvent && !seenMessageIds.has(message.id));
      const acknowledged = [...new Set(decryptedMessages
        .filter(({ message }) => message.author === "them")
        .map(({ message }) => message.id))];
      await applyBeforeAcknowledge(
        () => {
          decryptedMessages.forEach(({ message }) => seenMessageIds.add(message.id));
          setMessagesByProfile((current) => {
            const existing = current[profile.id] ?? EMPTY_MESSAGES;
            return { ...current, [profile.id]: reconcileRemoteMessages(existing, decryptedMessages, result.readReceipts, result.deliveryReceipts) };
          });
        },
        () => Promise.all(acknowledged.map((messageId) => acknowledgeMessage(profile, messageId))).then(() => undefined),
        (reason) => logEvent("sync", "Message acknowledgement failed", reason instanceof Error ? reason.message : "Acknowledgement error", "warn"),
      );
      if (syncNotificationsReady && syncNotificationsAllowed) {
        newIncomingMessages.forEach(({ conversationId, message }) => {
          if (visibleActiveConversationId() === conversationId) return;
          const conversation = conversations.find((item) => item.id === conversationId)
            ?? result.conversations.find((item) => item.id === conversationId);
          void notifyIncomingMessage({ profileId: profile.id, conversationId, title: conversation?.name ?? "Enter", text: message.text });
        });
      }
      if (retryingFailures.length === 0) advanceCursor(Math.max(cursor, result.nextCursor));
      if (retryingFailures.length === 0) syncNotificationsReady = true;
      setMessageError(retryingFailures.length > 0
        ? `Не удалось расшифровать ${retryingFailures.length} сообщений. Повторю попытку (осталось ${MAX_DECRYPT_RETRIES - Math.max(...retryingFailures.map((messageId) => decryptAttempts.get(messageId) ?? 0))}).`
        : quarantinedCount > 0
          ? `Пропущено ${quarantinedCount} сообщений, которые не удалось расшифровать после ${MAX_DECRYPT_RETRIES} попыток.`
          : "");
      void backfillHistoryToAccount();
      void backfillHistoryToDevices();
      void retryOutboxForProfile(profile.id);
      return retryingFailures.length === 0;
    }

    const syncOnce = createSyncQueue(async () => {
      if (cancelled || !presenceConnectionAllowed()) return;
      try {
        cursor = Math.max(cursor, syncCursorsRef.current[profile.id] ?? 0);
        await applySyncResult(await syncProfile(profile, cursor));
      } catch (reason) {
        if (cancelled || !presenceConnectionAllowed()) return;
        logEvent("sync", "Sync failed", reason instanceof Error ? reason.message : "Sync error", "error");
        setSyncConnected(false);
        if (isUnauthorized(reason)) {
          setMessageError("Сессия сервера истекла. Войдите снова");
          setShowAuth(true);
        } else {
          setMessageError(friendlyError(reason, "Не удалось синхронизировать данные. Проверьте соединение."));
        }
        // Cached messages remain available while the server is offline or the session expired.
      }
      if (presenceConnectionAllowed()) retryRealtime();
    });

    type DirectRealtimeEvent = Extract<RealtimeEvent, { cursor: number }>;
    async function applyRealtimeEvent(event: DirectRealtimeEvent) {
      if (cancelled || !presenceConnectionAllowed()) return false;
      const receivedAt = realtimeReceivedAt.get(event.cursor) ?? timingNow();
      realtimeReceivedAt.delete(event.cursor);
      if (event.type === "message") {
        if (!knownConversationIds.has(event.message.conversationId)) {
          const before = cursor;
          await syncOnce();
          return cursor > before;
        }
        if (!(await ensureOwnBundle()) || cancelled || !presenceConnectionAllowed() || !ownBundle) return false;
        const cryptoReadyAt = timingNow();
        const ownKeyIds = new Set([ownBundle.keyId, ownAccount?.keyId].filter((value): value is string => Boolean(value)));
        if (!ownKeyIds.has(event.message.encryptedMessage.key_id)) return true;
        try {
          const senderKeysStartedAt = timingNow();
          const senderDevices = await senderDevicesFor(event.message.encryptedMessage.sender);
          const decryptStartedAt = timingNow();
          const message = await decryptRemoteMessage(profile, event.message, senderDevices);
          logEvent("realtime", "Message decrypted", `cursor ${event.cursor}; websocket-to-crypto-ready ${timingElapsed(receivedAt, cryptoReadyAt)}ms; sender-keys ${timingElapsed(senderKeysStartedAt, decryptStartedAt)}ms; decrypt ${timingElapsed(decryptStartedAt)}ms`, "info");
          const isNewMessage = !seenMessageIds.has(message.id);
          return await applyBeforeAcknowledge(
            () => {
              seenMessageIds.add(message.id);
              const isActiveChat = visibleActiveConversationId() === event.message.conversationId;
              setMessagesByProfile((current) => {
                const existing = current[profile.id] ?? EMPTY_MESSAGES;
                return { ...current, [profile.id]: reconcileRemoteMessages(existing, [{ conversationId: event.message.conversationId, message }]) };
              });
              if (isActiveChat) markMessageStateApplied(message.id);
              logEvent("realtime", "Message state applied", `cursor ${event.cursor}; websocket-to-state ${timingElapsed(receivedAt)}ms; active ${isActiveChat}`, "info");
              if (isNewMessage && event.message.author === "them" && !message.reactionEvent) {
                setConversations((current) => incrementConversationUnread(current, event.message.conversationId, visibleActiveConversationId(), isActiveChat));
                if (isActiveChat) {
                  void markConversationRead(profile, event.message.conversationId).catch(() => undefined);
                }
                if (!isActiveChat) {
                  const conversation = conversations.find((item) => item.id === event.message.conversationId);
                  void notifyIncomingMessage({ profileId: profile.id, conversationId: event.message.conversationId, title: conversation?.name ?? "Enter", text: message.text });
                }
              }
              setMessageError("");
              return true;
            },
            message.author === "them" ? () => acknowledgeMessage(profile, message.id).then(() => undefined) : () => Promise.resolve(),
            (reason) => logEvent("realtime", "Message acknowledgement failed", reason instanceof Error ? reason.message : "Acknowledgement error", "warn"),
          );
        } catch (reason) {
          logEvent("crypto", "Realtime message decryption failed", reason instanceof Error ? reason.message : "Decryption error", "error");
          setMessageError("Не удалось расшифровать realtime-сообщение. Синхронизация повторится.");
          return false;
        }
      }
      setMessagesByProfile((current) => {
        const existing = current[profile.id] ?? EMPTY_MESSAGES;
        const messages = event.type === "readReceipt"
          ? reconcileRemoteMessages(existing, [], [{ messageId: event.messageId, readAt: event.readAt }])
          : reconcileRemoteMessages(existing, [], [], [{ messageId: event.messageId, deliveredAt: event.deliveredAt }]);
        return { ...current, [profile.id]: messages };
      });
      return true;
    }

    const realtimeQueue = createRealtimeQueue<DirectRealtimeEvent>(() => cursor, advanceCursor, applyRealtimeEvent, syncOnce);
    retryRealtime = realtimeQueue.retry;
    let realtimeSnapshot: Promise<unknown> = Promise.resolve();

    let realtime: WebSocket | null = null;
    let reconnectTimer: number | null = null;
    let fallbackTimer: number | null = null;
    let fallbackDelay = 5_000;
    let realtimeReady = false;
    let reconnectDelay = 1000;
    let heartbeatTimer: number | null = null;
    let lastRealtimePongAt = 0;

    const startFallbackSync = () => {
      if (!presenceConnectionAllowed() || fallbackTimer !== null || realtimeReady) return;
      fallbackTimer = window.setTimeout(() => {
        fallbackTimer = null;
        if (cancelled || !presenceConnectionAllowed() || realtimeReady) return;
        syncNotificationsAllowed = true;
        void syncOnce().catch(() => undefined).then(() => {
          if (cancelled || !presenceConnectionAllowed() || realtimeReady) return;
          fallbackDelay = Math.min(30_000, fallbackDelay * 2);
          startFallbackSync();
        });
      }, fallbackDelay);
    };
    const stopFallbackSync = () => {
      if (fallbackTimer !== null) {
        window.clearTimeout(fallbackTimer);
        fallbackTimer = null;
      }
      fallbackDelay = 5_000;
      syncNotificationsAllowed = false;
    };
    const scheduleRealtimeReconnect = () => {
      if (cancelled || !presenceConnectionAllowed() || reconnectTimer !== null) return;
      const delay = reconnectDelay;
      reconnectDelay = Math.min(30_000, reconnectDelay * 2);
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = null;
        if (presenceConnectionAllowed()) connectRealtime();
      }, delay);
    };
    const handleRealtimeClose = (details?: RealtimeClose) => {
      lastRealtimePongAt = 0;
      presence.update({ realtimeReady: false, lastHeartbeatAt: null });
      if (cancelled || !presenceConnectionAllowed()) return;
      realtimeReady = false;
      const closeDetails = details ? `code ${details.code}, clean ${details.wasClean}${details.reason ? `, reason ${details.reason}` : ""}` : "code unknown";
      logEvent("realtime", "Realtime connection closed", `${closeDetails}; switching to reconnect`, "warn");
      void syncOnce();
      startFallbackSync();
      scheduleRealtimeReconnect();
    };
    const connectRealtime = () => {
      if (cancelled || !presenceConnectionAllowed() || realtime !== null) return;
      let socket: WebSocket | null = null;
      try {
        socket = openRealtime(profile, cursor, (event) => {
          if (cancelled || !presenceConnectionAllowed() || realtime !== socket) return;
          if (event.type === "pong") {
            lastRealtimePongAt = Date.now();
            presence.update({ lastHeartbeatAt: lastRealtimePongAt });
          } else if (event.type === "ready") {
            realtimeReady = true;
            lastRealtimePongAt = Date.now();
            presence.update({ realtimeReady: true, lastHeartbeatAt: lastRealtimePongAt });
            logEvent("realtime", "Realtime connection established", undefined, "success");
            reconnectDelay = 1000;
            stopFallbackSync();
            setSyncConnected(true);
          } else if (event.type === "sync") {
            queueRealtimeTask(async () => {
              await applySyncResult(event);
              await realtimeQueue.retry();
            });
          } else if (event.type === "folders") {
            setFoldersByProfile((current) => ({ ...current, [profile.id]: event.folders }));
          } else if (event.type === "message" || event.type === "readReceipt" || event.type === "deliveryReceipt") {
            realtimeReceivedAt.set(event.cursor, timingNow());
            logEvent("realtime", "Realtime event queued", `type ${event.type}; cursor ${event.cursor}`, "info");
            queueRealtimeTask(() => { realtimeQueue.enqueue(event); });
          } else if (event.type === "presence") {
            setConversations((current) => current.map((conversation) => conversation.id === event.conversationId
              ? { ...conversation, online: event.online, lastSeenAt: event.lastSeenAt }
              : conversation));
          } else if (event.type === "error") {
            logEvent("realtime", "Realtime returned an error", "closing connection", "error");
            socket?.close();
          }
        }, (details) => {
          if (realtime !== socket) return;
          realtime = null;
          handleRealtimeClose(details);
        });
        realtime = socket;
      } catch (reason) {
        logEvent("realtime", "Failed to start Realtime", reason instanceof Error ? reason.message : "WebSocket error", "error");
        handleRealtimeClose();
      }
    };

    const queueRealtimeTask = (task: () => unknown | Promise<unknown>) => {
      realtimeSnapshot = realtimeSnapshot
        .catch((reason) => {
          logEvent("realtime", "Realtime pipeline recovered", reason instanceof Error ? reason.message : "Realtime pipeline error", "warn");
        })
        .then(task)
        .catch((reason) => {
          if (cancelled || !presenceConnectionAllowed()) return;
          logEvent("realtime", "Realtime pipeline failed", reason instanceof Error ? reason.message : "Realtime pipeline error", "error");
          void syncOnce();
        });
    };

    const stopRealtimeHeartbeat = () => {
      if (heartbeatTimer !== null) {
        window.clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
    };
    const startRealtimeHeartbeat = () => {
      if (heartbeatTimer !== null) return;
      heartbeatTimer = window.setInterval(() => {
        if (cancelled || !presenceConnectionAllowed()) return;
        if (!realtimeReady || !realtime) return;
        const socket = realtime;
        if (lastRealtimePongAt > 0 && Date.now() - lastRealtimePongAt > PRESENCE_HEARTBEAT_TIMEOUT_MS) {
          logEvent("realtime", "Realtime heartbeat timeout", "closing stale connection", "warn");
          realtime = null;
          realtimeReady = false;
          presence.update({ realtimeReady: false, lastHeartbeatAt: null });
          socket.close();
          handleRealtimeClose();
          return;
        }
        if (socket.readyState !== 1) {
          realtime = null;
          realtimeReady = false;
          presence.update({ realtimeReady: false, lastHeartbeatAt: null });
          socket.close();
          handleRealtimeClose();
          return;
        }
        try {
          socket.send(JSON.stringify({ type: "ping" }));
        } catch {
          realtime = null;
          realtimeReady = false;
          presence.update({ realtimeReady: false, lastHeartbeatAt: null });
          socket.close();
          handleRealtimeClose();
        }
      }, 15_000);
    };

    const suspendRealtime = () => {
      if (reconnectTimer !== null) {
        window.clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      stopFallbackSync();
      stopRealtimeHeartbeat();
      realtimeReady = false;
      lastRealtimePongAt = 0;
      presence.update({ realtimeReady: false, lastHeartbeatAt: null });
      const socket = realtime;
      realtime = null;
      socket?.close();
      setSyncConnected(false);
    };

    const resumeRealtime = () => {
      if (cancelled || !presenceConnectionAllowed()) return;
      reconnectDelay = 1000;
      startRealtimeHeartbeat();
      void syncOnce();
      connectRealtime();
    };

    void (async () => {
      try {
        const cached = await readMessageCacheAsync(profile.id, localSettings.cachePolicy);
        if (cancelled) return;
        if (cached) {
          cacheUpdatedAtRef.current[profile.id] = Math.max(cacheUpdatedAtRef.current[profile.id] ?? 0, cached.updatedAt ?? 0);
          cursor = Math.max(cursor, cached.cursor);
          syncCursorsRef.current[profile.id] = Math.max(syncCursorsRef.current[profile.id] ?? 0, cursor);
          messagesByProfileRef.current = { ...messagesByProfileRef.current, [profile.id]: cached.messages };
          setMessagesByProfile((current) => ({ ...current, [profile.id]: cached.messages }));
          if (cached.conversations) setConversations(cached.conversations);
        }
        if (presenceConnectionAllowed()) await syncOnce();
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
    const lifecycle = createPresenceLifecycle(foreground, {
      onForeground: () => {
        foreground = true;
        presence.update({
          appActive: true,
          visible: true,
          focused: true,
        });
        resumeRealtime();
      },
      onBackground: () => {
        foreground = false;
        presence.update({
          appActive: false,
          visible: document.visibilityState === "visible",
          focused: document.hasFocus(),
          realtimeReady: false,
          lastHeartbeatAt: null,
        });
        suspendRealtime();
      },
    });
    const handleWindowLifecycle = (focusedOverride?: boolean) => {
      const visible = document.visibilityState === "visible";
      const focused = focusedOverride ?? document.hasFocus();
      presence.update({ visible, focused, appActive: visible && focused });
      lifecycle.setForeground(visible && focused);
    };
    const handleVisibilityChange = () => handleWindowLifecycle();
    const handleWindowFocus = () => handleWindowLifecycle(true);
    const handleWindowBlur = () => handleWindowLifecycle(false);
    lifecycle.start();
    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("focus", handleWindowFocus);
    window.addEventListener("blur", handleWindowBlur);
    const handleOnline = () => {
      const wasAllowed = presenceConnectionAllowed();
      presence.update({ networkOnline: true });
      if (!wasAllowed) resumeRealtime();
    };
    const handleOffline = () => {
      presence.update({ networkOnline: false });
      suspendRealtime();
    };
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    let removeTauriLifecycle: (() => void) | null = null;
    if (isTauri()) {
      void import("@tauri-apps/api/window").then(async ({ getCurrentWindow }) => {
        const currentWindow = getCurrentWindow();
        const removeFocus = await currentWindow.onFocusChanged(({ payload }) => handleWindowLifecycle(payload));
        const removeClose = await currentWindow.onCloseRequested(() => {
          presence.update({ appActive: false, visible: false, focused: false, realtimeReady: false, lastHeartbeatAt: null });
          lifecycle.setForeground(false);
        });
        const cleanup = () => {
          removeFocus();
          removeClose();
        };
        if (cancelled) cleanup();
        else removeTauriLifecycle = cleanup;
      }).catch(() => undefined);
    }
    return () => {
      cancelled = true;
      lifecycle.stop();
      suspendRealtime();
      removeTauriLifecycle?.();
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("focus", handleWindowFocus);
      window.removeEventListener("blur", handleWindowBlur);
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, [activeProfileId, activeProfile?.token, showAuth]);

  async function addProfile(profile: Profile, password: string) {
    const { device } = await prepareProfile(profile, password);
    const nextProfile = { ...profile, deviceId: device.deviceId };
    const nextProfiles = [...profiles.filter((item) => item.id !== nextProfile.id), nextProfile];
    setProfiles(nextProfiles);
    try {
      localStorage.setItem("enter-profiles", JSON.stringify(nextProfiles));
    } catch {
      throw new Error("Не удалось сохранить профиль на этом устройстве");
    }
    const pendingEntries = outboxRef.current[nextProfile.id] ?? [];
    if (pendingEntries.some((entry) => entry.blocked)) {
      setOutboxProfile(nextProfile.id, pendingEntries.map((entry) => ({ ...entry, blocked: undefined, attempts: 0, nextAttemptAt: Date.now() })));
    }
    setActiveProfileId(nextProfile.id);
    const cached = readMessageCache(nextProfile.id, localSettings.cachePolicy);
    setMessagesByProfile((current) => ({ ...current, [nextProfile.id]: cached?.messages ?? EMPTY_MESSAGES }));
    const cachedCursor = cached?.cursor ?? 0;
    syncCursorsRef.current[nextProfile.id] = cachedCursor;
    setSyncCursors((current) => ({ ...current, [nextProfile.id]: cachedCursor }));
    setConversations(cached?.conversations ?? []);
    setActiveConversationId(readTabState().activeConversationByProfile?.[nextProfile.id] ?? null);
    setActiveFolder(readTabState().activeFolderByProfile?.[nextProfile.id] ?? ALL_FOLDER);
    setFoldersByProfile((current) => ({ ...current, [nextProfile.id]: current[nextProfile.id] ?? readFolders(nextProfile.id) }));
    setShowAuth(false);
  }

  async function removeProfile(profile: Profile) {
    if (activeProfileId === profile.id) cancelMediaOperation();
    const nextProfiles = profiles.filter((item) => item.id !== profile.id);
    setProfiles(nextProfiles);
    try {
      localStorage.setItem("enter-profiles", JSON.stringify(nextProfiles));
    } catch { /* Keep the in-memory removal; reload will restore the profile. */ }
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
    setFoldersByProfile((current) => {
      const { [profile.id]: _removed, ...rest } = current;
      return rest;
    });
    if (activeProfileId === profile.id) {
      setActiveProfileId(nextProfiles[0]?.id ?? null);
      setActiveConversationId(null);
      setActiveFolder(ALL_FOLDER);
      setReplyTo(null);
      setEditingMessage(null);
      setActivePanel("chats");
    }
  }

  function updateLocalSettings(settings: LocalClientSettings) {
    setLocalSettings(settings);
    writeLocalSettings(settings);
  }

  function clearActiveMessageCache() {
    if (!activeProfileId) return;
    clearMessageCache(activeProfileId);
    skipNextCacheWriteRef.current = true;
    cacheUpdatedAtRef.current[activeProfileId] = Date.now();
    syncCursorsRef.current[activeProfileId] = 0;
    setMessagesByProfile((current) => ({ ...current, [activeProfileId]: EMPTY_MESSAGES }));
    setSyncCursors((current) => ({ ...current, [activeProfileId]: 0 }));
    setConversations([]);
    setActiveConversationId(null);
  }

  function clearActiveOutbox() {
    if (activeProfileId) setOutboxProfile(activeProfileId, []);
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
      if (requestId === searchRequestId.current) setSearchError(friendlyError(reason, "Пользователь не найден"));
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
      selectConversation(existing.id);
      setSearchResult(null);
      setSearchError("");
      return;
    }
    try {
      const remote = await createConversation(activeProfile, user);
      const conversation = mapRemoteConversation(remote);
      setConversations((current) => current.some((item) => item.id === conversation.id) ? current : [...current, conversation]);
      selectConversation(conversation.id);
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

  function selectConversation(conversationId: string | null) {
    activeConversationIdRef.current = conversationId;
    activePanelRef.current = "chats";
    setActiveConversationId(conversationId);
    setReplyTo(null);
    setEditingMessage(null);
    setConversations((current) => clearConversationUnread(current, conversationId));
  }

  function queueOutbox(profileId: string, conversationId: string, message: Message) {
    const entries = outboxRef.current[profileId] ?? [];
    if (entries.some((entry) => entry.id === message.id)) return true;
    if (entries.length >= MAX_OUTBOX_ENTRIES) return false;
    setOutboxProfile(profileId, [...entries, { id: message.id, conversationId, message: { ...message, deliveryStatus: undefined }, attempts: 0, nextAttemptAt: Date.now() }]);
    return true;
  }

  function removeOutbox(profileId: string, messageId: string) {
    const current = outboxRef.current[profileId] ?? [];
    const entries = current.filter((entry) => entry.id !== messageId);
    if (entries.length !== current.length) setOutboxProfile(profileId, entries);
  }

  function failOutbox(profileId: string, messageId: string, blocked = false) {
    const current = outboxRef.current[profileId] ?? [];
    const entry = current.find((item) => item.id === messageId);
    if (!entry) return 0;
    const attempts = entry.attempts + 1;
    const entries = blocked
      ? current.map((item) => item.id === messageId ? { ...item, attempts, blocked: true, nextAttemptAt: Number.MAX_SAFE_INTEGER } : item)
      : attempts >= MAX_OUTBOX_ATTEMPTS
        ? current.filter((item) => item.id !== messageId)
        : current.map((item) => item.id === messageId ? { ...item, attempts, nextAttemptAt: Date.now() + retryDelay(attempts) } : item);
    setOutboxProfile(profileId, entries);
    return attempts;
  }

  async function sendMessageToConversation(conversationId: string, message: Message, pendingMedia: PendingMedia[] = [], fromOutbox = false) {
    if (!activeProfileId || !activeProfile) return;
    const profile = activeProfile;
    const sendStartedAt = timingNow();
    logEvent("send", fromOutbox ? "Retrying message send" : "Preparing message", `attachments ${pendingMedia.length}`);
    const conversation = conversations.find((item) => item.id === conversationId || (conversationId === "favorites" && item.handle === "favorites"));
    if (!conversation || conversation.canWrite === false) {
      if (fromOutbox) removeOutbox(profile.id, message.id);
      else setMessageError("Этот чат больше недоступен для отправки");
      return;
    }
    const targetConversationId = conversation.id;
    const isEdit = Boolean(message.editOf);
    const isReactionEvent = Boolean(message.reactionEvent);
    setMessageError("");
    const hasPendingMedia = pendingMedia.length > 0 && !fromOutbox;
    if (!fromOutbox && !hasPendingMedia && !queueOutbox(profile.id, targetConversationId, message)) {
      setMessageError("Очередь отправки переполнена. Дождитесь отправки предыдущих сообщений.");
      return;
    }
    if (!fromOutbox && hasPendingMedia && (outboxRef.current[profile.id]?.length ?? 0) >= MAX_OUTBOX_ENTRIES) {
      setMessageError("Очередь отправки переполнена. Дождитесь отправки предыдущих сообщений.");
      return;
    }
    const mediaOperation = hasPendingMedia ? ++mediaOperationRef.current : null;
    const mediaController = hasPendingMedia ? new AbortController() : null;
    if (mediaController) {
      mediaAbortRef.current?.abort();
      mediaAbortRef.current = mediaController;
    }
    const updateMediaProgress = (progress: number) => {
      if (mediaOperation === mediaOperationRef.current) setMediaUploadProgress(progress);
    };
    if (hasPendingMedia) setMediaUploadProgress(0);
    if (fromOutbox) {
      updateLocalMessage(profile.id, targetConversationId, message.id, (current) => ({ ...current, deliveryStatus: "pending" }));
    } else if (!isEdit && !hasPendingMedia && !isReactionEvent) {
      const pendingMessage = { ...message, deliveryStatus: "pending" } satisfies Message;
      setMessagesByProfile((current) => {
        const profileMessages = current[profile.id] ?? EMPTY_MESSAGES;
        return { ...current, [profile.id]: mergeRemoteMessages(profileMessages, [{ conversationId: targetConversationId, message: pendingMessage }]) };
      });
      markMessageStateApplied(message.id, timingNow(), "send");
      setConversations((current) => current.map((item) => item.id === targetConversationId ? { ...item, lastMessage: messagePreview(message), time: message.time } : item));
      logEvent("send", "Message optimistic apply scheduled", `message ${message.id}; local ${timingElapsed(sendStartedAt)}ms`, "info");
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
      if (recipients.length === 0) throw new Error("Не найдены ключи получателя");
      const mediaRecipient = recipients[0]?.address;
      if (hasPendingMedia && !mediaRecipient) throw new Error("Не найден получатель вложения");
      let uploadedAttachments = message.attachments;
      if (hasPendingMedia) {
        uploadedAttachments = [];
        for (const [index, pending] of pendingMedia.entries()) {
          const encrypted = "file" in pending ? await encryptMedia(pending.file) : pending.encrypted;
          await uploadMedia(profile, targetConversationId, encrypted.attachment.id, mediaRecipient!, encrypted.ciphertext, (progress) => updateMediaProgress(Math.round(((index + progress / 100) / pendingMedia.length) * 100)), mediaController?.signal);
          uploadedAttachments.push(encrypted.attachment);
        }
        updateMediaProgress(100);
      }
      const messageToSend: Message = uploadedAttachments ? { ...message, attachments: uploadedAttachments } : message;
      if (hasPendingMedia) {
        if (!queueOutbox(profile.id, targetConversationId, messageToSend)) throw new Error("OUTBOX_FULL");
        if (!isEdit) {
          const pendingMessage = { ...messageToSend, deliveryStatus: "pending" } satisfies Message;
          setMessagesByProfile((current) => {
            const profileMessages = current[profile.id] ?? EMPTY_MESSAGES;
            return { ...current, [profile.id]: mergeRemoteMessages(profileMessages, [{ conversationId: targetConversationId, message: pendingMessage }]) };
          });
          setConversations((current) => current.map((item) => item.id === targetConversationId ? { ...item, lastMessage: messagePreview(messageToSend), time: messageToSend.time } : item));
        }
      }
      const encryptionStartedAt = timingNow();
      const encryptedMessages = await Promise.all(recipients.map((recipient) => encryptMessage(profile, targetConversationId, messageToSend, recipient)));
      logEvent("crypto", "Message encrypted", `recipients ${encryptedMessages.length}; prepare ${timingElapsed(sendStartedAt, encryptionStartedAt)}ms; encrypt ${timingElapsed(encryptionStartedAt)}ms`, "success");
      const localEncryptedMessage = encryptedMessages.find((encryptedMessage) => encryptedMessage.key_id === account?.keyId) ?? encryptedMessages[0];
      const localMessage: Message = { ...messageToSend, encryptedMessage: localEncryptedMessage, deliveryStatus: "pending" };
      updateLocalMessage(profile.id, targetConversationId, messageToSend.id, (current) => ({ ...current, ...localMessage }));
      const transportStartedAt = timingNow();
      const sent = await sendRemoteMessage(profile, targetConversationId, localMessage, encryptedMessages);
      updateLocalMessage(profile.id, targetConversationId, messageToSend.id, (current) => ({ ...current, ...localMessage, time: formatMessageTime(new Date(sent.message.createdAt)), stackId: sent.message.stackId, deliveryStatus: undefined }));
      removeOutbox(profile.id, messageToSend.id);
      setMessageError("");
      if (mediaOperation === mediaOperationRef.current) {
        if (mediaAbortRef.current === mediaController) mediaAbortRef.current = null;
        setMediaUploadProgress(null);
      }
      logEvent("send", "Message sent", `message ${message.id}; local-to-accepted ${timingElapsed(sendStartedAt)}ms; transport ${timingElapsed(transportStartedAt)}ms`, "success");
    } catch (reason) {
      if (hasPendingMedia && mediaOperation !== mediaOperationRef.current) return;
      if (mediaOperation === mediaOperationRef.current) {
        if (mediaAbortRef.current === mediaController) mediaAbortRef.current = null;
        setMediaUploadProgress(null);
      }
      if (reason instanceof Error && reason.message === "OUTBOX_FULL") {
        logEvent("send", "Send queue is full", undefined, "warn");
        setMessageError("Очередь отправки переполнена. Дождитесь отправки предыдущих сообщений.");
        return;
      }
      updateLocalMessage(profile.id, targetConversationId, message.id, (current) => ({ ...current, deliveryStatus: "failed" }));
      if (isUnauthorized(reason)) {
        logEvent("send", "Session expired during send", undefined, "error");
        failOutbox(profile.id, message.id, true);
        setShowAuth(true);
        setMessageError("Сессия сервера истекла. Войдите снова");
        return;
      }
      const attempts = failOutbox(profile.id, message.id);
      logEvent("send", "Message send failed", `${reason instanceof Error ? reason.message : "error"}; attempt ${attempts}`, "error");
      setMessageError(attempts >= MAX_OUTBOX_ATTEMPTS
        ? "Сообщение не отправлено после нескольких попыток и удалено из очереди."
        : friendlyError(reason, hasPendingMedia ? "Не удалось загрузить вложение. Сообщение не отправлено." : "Сообщение сохранено локально. Повторю отправку после восстановления соединения."));
    }
  }

  async function retryOutboxForProfile(profileId: string) {
    if (activeProfileId !== profileId) return;
    const now = Date.now();
    for (const entry of outboxRef.current[profileId] ?? []) {
      if (entry.blocked || entry.attempts >= MAX_OUTBOX_ATTEMPTS || entry.nextAttemptAt > now || retryingOutbox.current.has(entry.id)) continue;
      retryingOutbox.current.add(entry.id);
      logEvent("send", "Retrying queued message", `attempt ${entry.attempts + 1}`);
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
    if (!activeConversationId || activeConversation?.canWrite === false) return;
    const nextReaction = message.reaction === reaction ? null : reaction;
    updateActiveMessage(message.id, (current) => ({ ...current, reaction: nextReaction ?? undefined }));
    void sendMessageToConversation(activeConversationId, {
      id: makeId(),
      author: "me",
      text: "",
      time: formatMessageTime(),
      reactionEvent: { targetMessageId: message.id, reaction: nextReaction },
    });
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
    setMessageToForward(null);
    try {
      const pendingMedia: PendingMedia[] = activeProfile && message.attachments?.length
        ? await Promise.all(message.attachments.map(async (attachment) => {
            const plaintext = await decryptMedia(await downloadMedia(activeProfile, attachment.id), attachment);
            return { encrypted: await encryptMediaBytes(plaintext, attachment) };
          }))
        : [];
      await sendMessageToConversation(conversationId, {
        ...message,
        id: makeId(),
        author: "me",
        time: formatMessageTime(),
        attachments: undefined,
        replyTo: undefined,
        reaction: undefined,
        pinned: false,
        edited: undefined,
        encryptedMessage: undefined,
      }, pendingMedia);
    } catch (reason) {
      setMessageError(friendlyError(reason, "Не удалось подготовить вложение"));
    }
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
    if (activeConversationId === conversationId) selectConversation(null);
  }

  function saveFolder(draft: Pick<ChatFolder, "name" | "template" | "icon">) {
    if (!activeProfileId) return;
    const folders = foldersByProfile[activeProfileId] ?? [];
    const nextFolders = folderEditor !== "new" && folderEditor
      ? folders.map((folder) => folder.id === folderEditor.id ? { ...folder, ...draft } : folder)
      : [...folders, { id: makeId(), ...draft, chatIds: [] }];
    setFoldersAndSync(activeProfileId, nextFolders);
    setFolderEditor(null);
  }

  function deleteFolder(folder: ChatFolder) {
    if (!activeProfileId || !window.confirm(`Удалить папку «${folder.name}»?`)) return;
    setFoldersAndSync(activeProfileId, (foldersByProfile[activeProfileId] ?? []).filter((item) => item.id !== folder.id));
    if (activeFolder === folder.id) setActiveFolder(ALL_FOLDER);
  }

  function toggleConversationFolder(conversationId: string, folderId: string, included: boolean) {
    const folder = availableFolders.find((item) => item.id === folderId);
    if (!activeProfileId || !folder || folder.template !== "custom") return;
    const nextFolders = (foldersByProfile[activeProfileId] ?? []).map((item) => item.id === folderId ? { ...item, chatIds: included ? [...new Set([...item.chatIds, conversationId])] : item.chatIds.filter((chatId) => chatId !== conversationId) } : item);
    setFoldersAndSync(activeProfileId, nextFolders);
  }

  function deleteConversation(conversationId: string) {
    setConversations((current) => current.map((conversation) => conversation.id === conversationId ? { ...conversation, deleted: true } : conversation));
    if (activeConversationId === conversationId) selectConversation(null);
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
    if (profile.id !== activeProfileId) cancelMediaOperation();
    if (activeProfileId) persistMessageCache(activeProfileId, messagesByProfile[activeProfileId] ?? EMPTY_MESSAGES, syncCursors[activeProfileId] ?? 0, conversations);
    const cached = readMessageCache(profile.id, localSettings.cachePolicy);
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
    const definition = availableFolders.find((item) => item.id === folder);
    if (folder !== ALL_FOLDER && (!definition || !activeConversation || !folderContains(definition, activeConversation))) selectConversation(null);
  }

  if (profiles.length === 0 || showAuth) {
    return <AuthView onAuthenticated={addProfile} onCancel={profiles.length > 0 ? () => setShowAuth(false) : undefined} />;
  }

  return (
    <>
      <MessengerView
        profiles={profiles}
        activeProfile={activeProfile}
        folders={availableFolders}
        activeFolder={activeFolder}
        chatListLayout={localSettings.chatListLayout}
        mediaSettings={localSettings.media}
        conversations={conversationsWithPreviews}
        syncConnected={syncConnected}
        activeConversationId={activeConversationId}
        activeConversation={activeConversation}
        messages={messages}
        messageToForward={messageToForward}
        activePanel={activePanel}
        settingsPanel={activePanel === "settings" && activeProfile ? <SettingsPanel profile={activeProfile} localSettings={localSettings} messageCount={cachedMessageCount} outboxCount={activeOutboxCount} onLocalSettingsChange={updateLocalSettings} onClearMessageCache={clearActiveMessageCache} onClearOutbox={clearActiveOutbox} onRemoveProfile={removeProfile} onClose={() => setActivePanel("chats")} /> : null}
        logsPanel={activePanel === "logs" ? <LogsPanel onClose={() => setActivePanel("chats")} /> : null}
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
        onSelectConversation={selectConversation}
        onSelectFolder={selectFolder}
        onTogglePinned={togglePinned}
        onToggleMuted={toggleMuted}
        onMarkUnread={markUnread}
        onArchive={archiveConversation}
        onManageFolders={(conversationId) => setFolderPickerConversationId(conversationId)}
        folderPickerConversation={folderPickerConversation}
        onCloseFolderPicker={() => setFolderPickerConversationId(null)}
        onToggleConversationFolder={toggleConversationFolder}
        onCreateFolder={() => setFolderEditor("new")}
        onEditFolder={(folder) => setFolderEditor(folder)}
        onDeleteFolder={deleteFolder}
        onDelete={deleteConversation}
        onReorder={reorderConversations}
        onSelectPanel={setActivePanel}
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
      <FolderDialog open={folderEditor !== null} folder={folderEditor === "new" ? null : folderEditor} onClose={() => setFolderEditor(null)} onSave={saveFolder} />
    </>
  );
}
