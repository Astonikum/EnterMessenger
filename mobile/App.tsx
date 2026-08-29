import AsyncStorage from "@react-native-async-storage/async-storage";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import notifee, { EventType } from "@notifee/react-native";
import { useBatteryLevel } from "react-native-device-info";
import { Alert, Animated, AppState, Appearance, Easing, Image, PanResponder, Platform, Pressable, StatusBar, StyleSheet, Text, View, useColorScheme, useWindowDimensions } from "react-native";
import { initialWindowMetrics, SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { AuthScreen } from "./src/components/AuthScreen";
import { ConversationList, type Action } from "./src/components/ConversationList";
import { ChatScreen, ForwardSheet } from "./src/components/ChatScreen";
import { Icon } from "./src/components/Icon";
import { ProfileSheet } from "./src/components/ProfileSheet";
import { SettingsScreen } from "./src/components/SettingsScreen";
import { ProfileScreen } from "./src/components/ProfileScreen";
import { LogsScreen } from "./src/components/LogsScreen";
import { logEvent } from "./src/logs";
import { friendlyError } from "./src/client-errors";
import { EMPTY_MESSAGES, makeId, messageTime } from "./src/data";
import { accountKeyBundle, decodeMessagePayload, decryptMessage, deleteDeviceKeys, deviceKeyBundle, encryptMessage, ensureAccountKey, ensureDeviceKeys, readAccountKey, type PublicAccountKey, type PublicDeviceKey } from "./src/rn-e2e";
import { acknowledgeMessage, createConversation, deleteAccount as deleteRemoteAccount, downloadMedia, fetchPublicAccountKey, fetchPublicDeviceKeys, mapRemoteConversation, markConversationRead, openRealtime, registerDeviceKey, registerPushToken, searchUser, sendMessage as sendRemoteMessage, syncDeviceHistory, syncProfile, updateAccountFolders, type RealtimeClose, type RealtimeEvent, type RemoteMessage, type SyncResponse, uploadMedia } from "./src/rn-api";
import { decryptMedia, encryptMedia, encryptMediaBytes } from "./src/media";
import type { PendingMedia } from "./src/components/ChatScreen";
import { colors, fonts, makeThemeColors } from "./src/theme";
import { migrateLocalServerAddress } from "./src/rn-address";
import { createRealtimeQueue, createSyncQueue } from "./src/sync-queue";
import { createRealtimeLifecycle } from "./src/realtime-lifecycle";
import { configureNotifications, notifyIncomingMessage, registerForPushNotifications } from "./src/notifications";
import type { Conversation, Message, OutboxEntry, Profile, SearchUser } from "./src/types";
import { messagePreview } from "../common/src/messages.ts";
import { deleteSessionToken, readSessionToken, writeSessionToken } from "./src/secure-session";
import { limitMessageList, limitMessagesByProfile, limitOutboxEntries, MAX_OUTBOX_ATTEMPTS, retryDelay, sanitizeMessagesByProfile, sanitizeOutboxByProfile, sanitizeSyncCursors } from "./src/storage-limits";
import { isCachedConversation } from "../common/src/storage-models.ts";
import { folderContains, sanitizeFoldersByProfile, type ChatFolder } from "./src/folders";
import { DEFAULT_SETTINGS, readSettings, type MobileSettings } from "./src/settings";
import { CommonDebugProvider } from "./src/common-debug";
import { isUnauthorized, mergeDeliveryReceipts, mergeReadReceipts, mergeRemoteMessages } from "../common/src/message-state.ts";
import { formatProfileAddress } from "../common/src/address.ts";

const PROFILES_KEY = "enter-profiles";
const MESSAGES_KEY = "enter-mobile-messages";
const CURSORS_KEY = "enter-mobile-sync-cursors";
const CONVERSATIONS_KEY = "enter-mobile-conversations";
const FOLDERS_KEY = "enter-mobile-folders";
const NAVIGATION_KEY = "enter-mobile-navigation";
const OUTBOX_KEY = "enter-mobile-outbox";
const ALL_FOLDER = "all";
const MAX_DECRYPT_RETRIES = 3;

type Screen = "inbox" | "chat" | "profile" | "settings" | "logs";
type MessagesByProfile = Record<string, Record<string, Message[]>>;
type ConversationsByProfile = Record<string, Conversation[]>;
type FoldersByProfile = Record<string, ChatFolder[]>;
type NavigationState = {
  activeProfileId?: string | null;
  activeConversationByProfile?: Record<string, string | null>;
  activeFolderByProfile?: Record<string, string>;
  screen?: Screen;
};

type StoredProfile = Omit<Profile, "token"> & { token?: string };

function isStoredProfile(value: unknown): value is StoredProfile {
  if (!value || typeof value !== "object") return false;
  const profile = value as Partial<StoredProfile>;
  return typeof profile.id === "string"
    && typeof profile.name === "string"
    && typeof profile.handle === "string"
    && typeof profile.server === "string"
    && typeof profile.color === "string"
    && (profile.token === undefined || typeof profile.token === "string")
    && (profile.serverId === undefined || typeof profile.serverId === "string")
    && (profile.serverName === undefined || typeof profile.serverName === "string")
    && (profile.serverLogo === undefined || typeof profile.serverLogo === "string")
    && (profile.deviceId === undefined || typeof profile.deviceId === "string");
}

function persistJson(key: string, value: unknown) {
  void AsyncStorage.setItem(key, JSON.stringify(value)).catch(() => undefined);
}

function profileForStorage(profile: Profile): StoredProfile {
  const { token: _token, ...metadata } = profile;
  return metadata;
}

async function prepareProfile(profile: Profile, password?: string) {
  const device = await ensureDeviceKeys(profile.id);
  const account = password ? await ensureAccountKey(profile.id, password) : await readAccountKey(profile.id);
  await registerDeviceKey(profile, deviceKeyBundle(device), account ? { keyId: account.keyId, encryptionPublicKey: account.encryptionPublicKey } : undefined);
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
  return { id: remote.encryptedMessage.message_id, author: remote.author, text: payload.text, editOf: payload.editOf, attachments: payload.attachments, time: messageTime(new Date(remote.createdAt)), stackId: remote.stackId, encryptedMessage: remote.encryptedMessage };
}

export default function App() {
  const [hydrated, setHydrated] = useState(false);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [activeProfileId, setActiveProfileId] = useState<string | null>(null);
  const [messagesByProfile, setMessagesByProfile] = useState<MessagesByProfile>({});
  const [syncCursors, setSyncCursors] = useState<Record<string, number>>({});
  const [outboxByProfile, setOutboxByProfile] = useState<Record<string, OutboxEntry[]>>({});
  const [syncConnected, setSyncConnected] = useState(false);
  const [conversationsByProfile, setConversationsByProfile] = useState<ConversationsByProfile>({});
  const [foldersByProfile, setFoldersByProfile] = useState<FoldersByProfile>({});
  const [screen, setScreen] = useState<Screen>("inbox");
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [activeConversationByProfile, setActiveConversationByProfile] = useState<Record<string, string | null>>({});
  const [activeFolderByProfile, setActiveFolderByProfile] = useState<Record<string, string>>({});
  const [showAuth, setShowAuth] = useState(false);
  const [showProfiles, setShowProfiles] = useState(false);
  const [query, setQuery] = useState("");
  const [searchUserResult, setSearchUserResult] = useState<SearchUser | null>(null);
  const [searchBusy, setSearchBusy] = useState(false);
  const [searchError, setSearchError] = useState("");
  const [messageError, setMessageError] = useState("");
  const [mediaUploadProgress, setMediaUploadProgress] = useState<number | null>(null);
  const [localSettings, setLocalSettings] = useState<MobileSettings>(DEFAULT_SETTINGS);
  const batteryLevel = useBatteryLevel();
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const [editingMessage, setEditingMessage] = useState<Message | null>(null);
  const [forwardMessage, setForwardMessage] = useState<Message | null>(null);
  const [screenDirection, setScreenDirection] = useState<1 | -1>(1);
  const searchRequestId = useRef(0);
  const messagesByProfileRef = useRef(messagesByProfile);
  const syncCursorsRef = useRef(syncCursors);
  const outboxRef = useRef(outboxByProfile);
  const retryingOutbox = useRef(new Set<string>());
  const syncRecoveryProfiles = useRef(new Set<string>());
  const folderWritesRef = useRef<Record<string, Promise<void>>>({});
  const screenMotion = useRef(new Animated.Value(1)).current;
  const previousScreen = useRef<Screen>(screen);
  const activeConversationIdRef = useRef(activeConversationId);
  const screenRef = useRef(screen);
  const swipeResponder = useRef(PanResponder.create({
    onMoveShouldSetPanResponder: (_event, gesture) => {
      if (screenRef.current !== "inbox" && screenRef.current !== "settings") return false;
      return Math.abs(gesture.dx) > 12 && Math.abs(gesture.dx) > Math.abs(gesture.dy) * 1.25;
    },
    onPanResponderRelease: (_event, gesture) => {
      if (screenRef.current === "inbox" && gesture.dx <= -80) setScreen("settings");
      if (screenRef.current === "settings" && gesture.dx >= 80) setScreen("inbox");
    },
  })).current;
  const pendingNotificationRef = useRef<{ profileId?: string; conversationId: string; messageId?: string } | null>(null);
  const handledNotificationRef = useRef<string | null>(null);
  const hasRenderedScreen = useRef(false);
  const { width: viewportWidth } = useWindowDimensions();
  const systemColorScheme = useColorScheme();
  const themeColors = useMemo(() => makeThemeColors(localSettings.theme, localSettings.accent, systemColorScheme), [localSettings.accent, localSettings.theme, systemColorScheme]);
  const energySavingActive = localSettings.energySaving.enabled && batteryLevel !== null && batteryLevel <= localSettings.energySaving.threshold / 100;

  useEffect(() => {
    if (Platform.OS === "web") return;
    Appearance.setColorScheme(localSettings.theme === "system" ? null : localSettings.theme);
  }, [localSettings.theme]);

  useLayoutEffect(() => {
    if (!hasRenderedScreen.current) {
      hasRenderedScreen.current = true;
      previousScreen.current = screen;
      screenMotion.setValue(1);
      return;
    }
    const movingBack = (previousScreen.current === "chat" && screen !== "chat") || ((previousScreen.current === "settings" || previousScreen.current === "profile" || previousScreen.current === "logs") && screen === "inbox") || (previousScreen.current === "settings" && (screen === "profile" || screen === "logs")) || (previousScreen.current === "logs" && (screen === "profile" || screen === "settings"));
    previousScreen.current = screen;
    setScreenDirection(movingBack ? -1 : 1);
    screenMotion.setValue(0);
    Animated.timing(screenMotion, { toValue: 1, duration: energySavingActive && !localSettings.energySaving.smoothTransitions ? 0 : 220, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
  }, [energySavingActive, localSettings.energySaving.smoothTransitions, screen, screenMotion]);

  useEffect(() => { activeConversationIdRef.current = activeConversationId; }, [activeConversationId]);
  useEffect(() => { screenRef.current = screen; }, [screen]);
  useEffect(() => { void configureNotifications(); }, []);

  useEffect(() => {
    if (Platform.OS === "web") return;
    const openNotification = (notification?: { data?: Record<string, unknown> }) => {
      if (!notification) return;
      const data = notification.data ?? {};
      if (typeof data.conversationId !== "string") return;
      const messageId = typeof data.messageId === "string" ? data.messageId : undefined;
      if (messageId && handledNotificationRef.current === messageId) return;
      if (messageId) handledNotificationRef.current = messageId;
      const next = { profileId: typeof data.profileId === "string" ? data.profileId : undefined, conversationId: data.conversationId, messageId };
      if (!hydrated) {
        pendingNotificationRef.current = next;
        return;
      }
      const profileId = next.profileId && profiles.some((profile) => profile.id === next.profileId) ? next.profileId : activeProfileId;
      if (!profileId) return;
      setActiveProfileId(profileId);
      setActiveConversationId(next.conversationId);
      setActiveConversationByProfile((current) => ({ ...current, [profileId]: next.conversationId }));
      setScreen("chat");
    };
    const unsubscribe = notifee.onForegroundEvent(({ type, detail }) => {
      if (type === EventType.PRESS) openNotification(detail.notification);
    });
    void notifee.getInitialNotification().then((initial) => { if (initial) openNotification(initial.notification); });
    return unsubscribe;
  }, [activeProfileId, hydrated, profiles]);

  useEffect(() => {
    if (!hydrated || !pendingNotificationRef.current) return;
    const pending = pendingNotificationRef.current;
    pendingNotificationRef.current = null;
    const profileId = pending.profileId && profiles.some((profile) => profile.id === pending.profileId) ? pending.profileId : activeProfileId;
    if (!profileId) return;
    setActiveProfileId(profileId);
    setActiveConversationId(pending.conversationId);
    setActiveConversationByProfile((current) => ({ ...current, [profileId]: pending.conversationId }));
    setScreen("chat");
  }, [activeProfileId, hydrated, profiles]);

  const activeProfile = profiles.find((profile) => profile.id === activeProfileId);
  const conversations = activeProfileId ? conversationsByProfile[activeProfileId] ?? [] : [];
  const folders = activeProfileId ? foldersByProfile[activeProfileId] ?? [] : [];
  const activeConversation = conversations.find((conversation) => conversation.id === activeConversationId);
  const activeMessages = activeProfileId ? messagesByProfile[activeProfileId] ?? EMPTY_MESSAGES : EMPTY_MESSAGES;
  const messages = activeConversationId ? (activeMessages[activeConversationId] ?? []).filter((message) => !message.editOf) : [];
  const conversationsWithPreviews = useMemo(() => conversations.map((conversation) => {
    const ownMessages = (activeMessages[conversation.id] ?? []).filter((message) => !message.editOf);
    const latest = ownMessages[ownMessages.length - 1];
    return latest ? { ...conversation, lastMessage: messagePreview(latest), time: latest.time } : { ...conversation, lastMessage: "", time: "" };
  }), [activeMessages, conversations]);

  useEffect(() => { messagesByProfileRef.current = messagesByProfile; }, [messagesByProfile]);
  useEffect(() => { syncCursorsRef.current = syncCursors; }, [syncCursors]);

  function setFoldersAndSync(profileId: string, nextFolders: ChatFolder[]) {
    setFoldersByProfile((current) => ({ ...current, [profileId]: nextFolders }));
    const profile = profiles.find((item) => item.id === profileId);
    if (!profile) return;
    const previous = folderWritesRef.current[profileId] ?? Promise.resolve();
    const write = previous.catch(() => undefined).then(async () => {
      const saved = await updateAccountFolders(profile, nextFolders);
      setFoldersByProfile((current) => ({ ...current, [profileId]: saved }));
    }).catch((reason) => {
      if (isUnauthorized(reason)) setMessageError("Сессия сервера истекла. Войдите снова");
      else setMessageError(friendlyError(reason, "Не удалось сохранить папки"));
    });
    folderWritesRef.current[profileId] = write;
  }

  useEffect(() => {
    let mounted = true;
    void (async () => {
      const [storedProfiles, storedMessages, storedCursors, storedConversations, storedFolders, storedNavigation, storedOutbox, storedSettings] = await Promise.all([
        AsyncStorage.getItem(PROFILES_KEY),
        AsyncStorage.getItem(MESSAGES_KEY),
        AsyncStorage.getItem(CURSORS_KEY),
        AsyncStorage.getItem(CONVERSATIONS_KEY),
        AsyncStorage.getItem(FOLDERS_KEY),
        AsyncStorage.getItem(NAVIGATION_KEY),
        AsyncStorage.getItem(OUTBOX_KEY),
        readSettings(),
      ]);
      setLocalSettings(storedSettings);
      let candidates: StoredProfile[] = [];
      let navigation: NavigationState = {};
      let cachedConversations: ConversationsByProfile = {};
      try {
        const parsed: unknown = storedProfiles ? JSON.parse(storedProfiles) : [];
        candidates = Array.isArray(parsed) ? parsed.filter(isStoredProfile).map((profile) => ({ ...profile, server: migrateLocalServerAddress(profile.server) })) : [];
      } catch { candidates = []; }
      const validProfiles = (await Promise.all(candidates.map(async (profile): Promise<Profile | null> => {
        const secureToken = await readSessionToken(profile.id);
        if (secureToken) return { ...profile, token: secureToken };
        if (!profile.token) return null;
        try {
          await writeSessionToken(profile.id, profile.token);
          return { ...profile, token: profile.token };
        } catch {
          return null;
        }
      }))).filter((profile): profile is Profile => profile !== null);
      try {
        const parsed: unknown = storedMessages ? JSON.parse(storedMessages) : {};
        setMessagesByProfile(sanitizeMessagesByProfile(parsed, storedSettings.cachePolicy));
      } catch { setMessagesByProfile({}); }
      try {
        const parsed: unknown = storedCursors ? JSON.parse(storedCursors) : {};
        setSyncCursors(sanitizeSyncCursors(parsed));
      } catch { setSyncCursors({}); }
      try {
        const parsed: unknown = storedConversations ? JSON.parse(storedConversations) : {};
        cachedConversations = parsed && typeof parsed === "object" && !Array.isArray(parsed)
          ? Object.fromEntries(Object.entries(parsed).map(([profileId, items]) => [profileId, Array.isArray(items) ? items.filter(isCachedConversation) : []]))
          : {};
        setConversationsByProfile(cachedConversations);
      } catch { setConversationsByProfile({}); }
      try {
        const parsed: unknown = storedFolders ? JSON.parse(storedFolders) : {};
        setFoldersByProfile(sanitizeFoldersByProfile(parsed));
      } catch { setFoldersByProfile({}); }
      try {
        const parsed: unknown = storedNavigation ? JSON.parse(storedNavigation) : {};
        navigation = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as NavigationState : {};
      } catch { navigation = {}; }
      try {
        const parsed: unknown = storedOutbox ? JSON.parse(storedOutbox) : {};
        setOutboxByProfile(sanitizeOutboxByProfile(parsed));
      } catch { setOutboxByProfile({}); }
      if (!mounted) return;
      setProfiles(validProfiles);
      setShowAuth(validProfiles.length === 0);
      const selectedProfileId = validProfiles.some((profile) => profile.id === navigation.activeProfileId) ? navigation.activeProfileId ?? null : validProfiles[0]?.id ?? null;
      const selectedConversationId = selectedProfileId ? navigation.activeConversationByProfile?.[selectedProfileId] ?? null : null;
      setActiveProfileId(selectedProfileId);
      setActiveConversationId(selectedConversationId);
      setActiveConversationByProfile(navigation.activeConversationByProfile ?? {});
      setActiveFolderByProfile(navigation.activeFolderByProfile ?? {});
      const hasSelectedConversation = Boolean(selectedProfileId && selectedConversationId && (cachedConversations[selectedProfileId] ?? []).some((item) => item.id === selectedConversationId));
      setScreen(navigation.screen === "settings" || navigation.screen === "logs" ? navigation.screen : hasSelectedConversation ? "chat" : "inbox");
      setHydrated(true);
    })().catch(() => { if (mounted) { setHydrated(true); setShowAuth(true); } });
    return () => { mounted = false; };
  }, []);

  useEffect(() => { if (hydrated) persistJson(PROFILES_KEY, profiles.map(profileForStorage)); }, [hydrated, profiles]);
  useEffect(() => { if (hydrated) persistJson(MESSAGES_KEY, limitMessagesByProfile(messagesByProfile, localSettings.cachePolicy)); }, [hydrated, localSettings.cachePolicy, messagesByProfile]);
  useEffect(() => { if (hydrated) persistJson(CURSORS_KEY, syncCursors); }, [hydrated, syncCursors]);
  useEffect(() => { outboxRef.current = outboxByProfile; if (hydrated) persistJson(OUTBOX_KEY, Object.fromEntries(Object.entries(outboxByProfile).map(([profileId, entries]) => [profileId, limitOutboxEntries(entries)]))); }, [hydrated, outboxByProfile]);
  useEffect(() => { if (hydrated) persistJson(CONVERSATIONS_KEY, conversationsByProfile); }, [hydrated, conversationsByProfile]);
  useEffect(() => { if (hydrated) persistJson(FOLDERS_KEY, foldersByProfile); }, [hydrated, foldersByProfile]);
  useEffect(() => {
    if (!hydrated || !activeProfileId) return;
    setActiveConversationByProfile((current) => ({ ...current, [activeProfileId]: activeConversationId }));
  }, [hydrated, activeProfileId, activeConversationId]);
  useEffect(() => {
    if (!hydrated) return;
    persistJson(NAVIGATION_KEY, { activeProfileId, activeConversationByProfile, activeFolderByProfile, screen } satisfies NavigationState);
  }, [hydrated, activeProfileId, activeConversationByProfile, activeFolderByProfile, screen]);

  useEffect(() => {
    if (!activeProfile || showAuth) { setSyncConnected(false); return; }
    let cancelled = false;
    let appActive = AppState.currentState === null || AppState.currentState === "active";
    let cursor = syncCursorsRef.current[activeProfile.id] ?? 0;
    const cachedMessages = messagesByProfileRef.current[activeProfile.id] ?? EMPTY_MESSAGES;
    const hasCachedMessages = Object.values(cachedMessages).some((items) => items.length > 0);
    if (cursor > 0 && !hasCachedMessages && !syncRecoveryProfiles.current.has(activeProfile.id)) {
      cursor = 0;
      syncCursorsRef.current[activeProfile.id] = 0;
      syncRecoveryProfiles.current.add(activeProfile.id);
    }
     let ownBundle: PublicDeviceKey | null = null;
     let ownAccount: PublicAccountKey | null = null;
    let preparing = false;
    let nextPrepareAt = 0;
     const profile = activeProfile;
    const historySyncComplete = new Set<string>();
    const historySyncSent = new Map<string, Set<string>>();
    const senderDeviceCache = new Map<string, Promise<PublicDeviceKey[]>>();
    const decryptAttempts = new Map<string, number>();
    const quarantinedMessageIds = new Set<string>();
    let pushRegistrationStarted = false;
    let syncNotificationsReady = false;
    let syncNotificationsAllowed = false;

    const senderDevicesFor = (address: string) => {
      const cached = senderDeviceCache.get(address);
      if (cached) return cached;
      const request = fetchPublicDeviceKeys(profile, address).catch((reason) => {
        senderDeviceCache.delete(address);
        throw reason;
      });
      senderDeviceCache.set(address, request);
      return request;
     };

    const historyMessageKey = (message: Message) => `${message.id}:${message.text}`;

    async function registerProfilePush(deviceId: string) {
      if (pushRegistrationStarted || (Platform.OS !== "android" && Platform.OS !== "ios")) return;
      pushRegistrationStarted = true;
      try {
        const token = await registerForPushNotifications();
        if (!token || cancelled) {
          if (!cancelled) logEvent("network", "Push token unavailable", "Permission denied or push provider unavailable", "warn");
          return;
        }
        await registerPushToken(profile, token, deviceId, Platform.OS);
        if (!cancelled) logEvent("network", "Push token registered", Platform.OS, "success");
      } catch (reason) {
        if (!cancelled) logEvent("network", "Push token registration failed", reason instanceof Error ? reason.message : "Push registration error", "warn");
      }
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
        void registerProfilePush(prepared.bundle.deviceId);
        nextPrepareAt = 0;
        logEvent("crypto", "Own device key loaded", undefined, "success");
        return ownBundle;
      } catch (reason) {
        nextPrepareAt = Date.now() + 5000;
        logEvent("crypto", "Failed to prepare device keys", reason instanceof Error ? reason.message : "Key error", "error");
        if (isUnauthorized(reason)) { expireProfileSession(profile.id); setMessageError("Сессия сервера истекла. Войдите снова"); }
        return null;
      } finally {
        preparing = false;
      }
    }

     async function backfillHistoryToAccount() {
       const target = ownAccount;
       if (cancelled || !ownBundle || !target) return;
       const history = Object.entries(messagesByProfileRef.current[profile.id] ?? {}).flatMap(([conversationId, items]) => items.filter((message) => message.encryptedMessage && !message.editOf).map((message) => ({ conversationId, message })));
       if (history.length === 0) return;
       const sent = historySyncSent.get(target.keyId) ?? new Set<string>();
       const pendingHistory = history.filter(({ message }) => !sent.has(historyMessageKey(message)));
       if (pendingHistory.length === 0) return;
       const targetKey = `${target.keyId}:${pendingHistory.length}:${pendingHistory[pendingHistory.length - 1]?.message.id ?? ""}`;
       if (historySyncComplete.has(targetKey)) return;
       try {
         for (let index = 0; index < pendingHistory.length; index += 50) {
           const chunk = pendingHistory.slice(index, index + 50);
           const entries = await Promise.all(chunk.map(async ({ conversationId, message }) => ({ conversationId, messageId: message.id, sourceKeyId: message.encryptedMessage?.key_id, encryptedMessage: await encryptMessage(profile, conversationId, message, target) })));
           await syncDeviceHistory(profile, entries);
           chunk.forEach(({ message }) => sent.add(historyMessageKey(message)));
         }
         historySyncSent.set(target.keyId, sent);
         historySyncComplete.add(targetKey);
       } catch (reason) {
         if (isUnauthorized(reason)) expireProfileSession(profile.id);
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
       const history = Object.entries(messagesByProfileRef.current[profile.id] ?? {}).flatMap(([conversationId, items]) => items.filter((message) => message.encryptedMessage && !message.editOf).map((message) => ({ conversationId, message })));
       if (history.length === 0) return;
       for (const target of devices) {
         if (target.keyId === sourceBundle.keyId) continue;
         const sent = historySyncSent.get(target.keyId) ?? new Set<string>();
         const pendingHistory = history.filter(({ message }) => !sent.has(historyMessageKey(message)));
         if (pendingHistory.length === 0) continue;
         const historyVersion = `${pendingHistory.length}:${pendingHistory[pendingHistory.length - 1]?.message.id ?? ""}`;
         const targetKey = `${target.deviceId}:${target.keyId}:${historyVersion}`;
         if (historySyncComplete.has(targetKey)) continue;
         try {
           for (let index = 0; index < pendingHistory.length; index += 50) {
             const chunk = pendingHistory.slice(index, index + 50);
             const entries = await Promise.all(chunk.map(async ({ conversationId, message }) => ({ conversationId, messageId: message.id, sourceKeyId: message.encryptedMessage?.key_id, encryptedMessage: await encryptMessage(profile, conversationId, message, target) })));
             await syncDeviceHistory(profile, entries);
             chunk.forEach(({ message }) => sent.add(historyMessageKey(message)));
           }
           historySyncSent.set(target.keyId, sent);
           historySyncComplete.add(targetKey);
        } catch (reason) {
          if (isUnauthorized(reason)) { expireProfileSession(profile.id); setMessageError("Сессия сервера истекла. Войдите снова"); }
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
      if (cancelled || !appActive) return false;
      logEvent("sync", "Sync package received", `chats ${result.conversations.length}, messages ${result.messages.length}, cursor ${result.nextCursor}`);
      setSyncConnected(true);
      if (result.folders) setFoldersByProfile((current) => ({ ...current, [profile.id]: result.folders! }));
      result.conversations.forEach((conversation) => knownConversationIds.add(conversation.id));
      updateConversations((current) => {
        const currentById = new Map(current.map((conversation) => [conversation.id, conversation]));
        const currentOrder = current.map((conversation) => conversation.id);
        return result.conversations.map((remote) => {
          const mapped = mapRemoteConversation(remote);
          const local = currentById.get(mapped.id);
          return local ? { ...mapped, pinned: local.pinned, muted: local.muted, archived: local.archived, deleted: local.deleted } : mapped;
        }).sort((left, right) => {
          const leftIndex = currentOrder.indexOf(left.id);
          const rightIndex = currentOrder.indexOf(right.id);
          if (leftIndex < 0) return rightIndex < 0 ? 0 : 1;
          if (rightIndex < 0) return -1;
          return leftIndex - rightIndex;
        });
      });
      if (!(await ensureOwnBundle()) || cancelled || !appActive || !ownBundle) return false;
      const ownKeyIds = new Set([ownBundle.keyId, ownAccount?.keyId].filter((value): value is string => Boolean(value)));
      const deviceMessages = result.messages.filter((remote) => ownKeyIds.has(remote.encryptedMessage.key_id));
      let quarantinedCount = 0;
      const retryingFailures: string[] = [];
      const decrypted = (await Promise.all(deviceMessages.map(async (remote) => {
        const messageId = remote.encryptedMessage.message_id;
        if (quarantinedMessageIds.has(messageId)) {
          quarantinedCount += 1;
          return null;
        }
        try {
          const message = await decryptRemoteMessage(profile, remote, await senderDevicesFor(remote.encryptedMessage.sender));
          decryptAttempts.delete(messageId);
          return { conversationId: remote.conversationId, message };
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
      logEvent("crypto", "Sync decryption completed", `success ${decrypted.length}, retries ${retryingFailures.length}, skipped ${quarantinedCount}`, retryingFailures.length || quarantinedCount ? "warn" : "success");
      if (cancelled || !appActive) return false;
      const newIncomingMessages = decrypted.filter(({ message }) => message.author === "them" && !seenMessageIds.has(message.id));
      const acknowledged = [...new Set(decrypted
        .filter(({ message }) => message.author === "them")
        .map(({ message }) => message.id))];
      try {
        await Promise.all(acknowledged.map((messageId) => acknowledgeMessage(profile, messageId)));
      } catch {
        if (!cancelled && appActive) setMessageError("Не удалось подтвердить получение сообщения. Синхронизация повторится.");
        return false;
      }
      if (cancelled || !appActive) return false;
      decrypted.forEach(({ message }) => seenMessageIds.add(message.id));
      setMessagesByProfile((current) => {
        const existing = current[profile.id] ?? EMPTY_MESSAGES;
        return { ...current, [profile.id]: mergeDeliveryReceipts(mergeReadReceipts(mergeRemoteMessages(existing, decrypted, limitMessageList), result.readReceipts ?? []), result.deliveryReceipts ?? []) };
      });
      if (syncNotificationsReady && syncNotificationsAllowed) {
        newIncomingMessages.forEach(({ conversationId, message }) => {
          if (activeConversationIdRef.current === conversationId && screenRef.current === "chat") return;
          const conversation = conversations.find((item) => item.id === conversationId)
            ?? result.conversations.find((item) => item.id === conversationId);
          void notifyIncomingMessage({ profileId: profile.id, conversationId, messageId: message.id, title: conversation?.name ?? "Enter", text: message.text });
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
      if (cancelled || !appActive) return;
      try {
        cursor = Math.max(cursor, syncCursorsRef.current[profile.id] ?? 0);
        await applySyncResult(await syncProfile(profile, cursor));
      } catch (reason) {
        if (cancelled || !appActive) return;
        logEvent("sync", "Sync failed", reason instanceof Error ? reason.message : "Sync error", "error");
        setSyncConnected(false);
        if (isUnauthorized(reason)) { expireProfileSession(profile.id); setMessageError("Сессия сервера истекла. Войдите снова"); }
        else setMessageError(friendlyError(reason, "Нет подключения к серверу"));
      }
      if (appActive) retryRealtime();
    });

    type DirectRealtimeEvent = Extract<RealtimeEvent, { cursor: number }>;
    async function applyRealtimeEvent(event: DirectRealtimeEvent) {
      if (cancelled || !appActive) return false;
      if (event.type === "message") {
        if (!knownConversationIds.has(event.message.conversationId)) {
          const before = cursor;
          await syncOnce();
          return cursor > before;
        }
        if (!(await ensureOwnBundle()) || cancelled || !ownBundle) return false;
        const ownKeyIds = new Set([ownBundle.keyId, ownAccount?.keyId].filter((value): value is string => Boolean(value)));
        if (!ownKeyIds.has(event.message.encryptedMessage.key_id)) return true;
        try {
          const message = await decryptRemoteMessage(profile, event.message, await senderDevicesFor(event.message.encryptedMessage.sender));
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
            return { ...current, [profile.id]: mergeRemoteMessages(existing, [{ conversationId: event.message.conversationId, message }], limitMessageList) };
          });
          if (isNewMessage && event.message.author === "them") {
            updateConversations((current) => current.map((conversation) => conversation.id === event.message.conversationId && conversation.id !== activeConversationId ? { ...conversation, unread: (conversation.unread ?? 0) + 1 } : conversation));
            if (activeConversationIdRef.current !== event.message.conversationId || screenRef.current !== "chat") {
              const conversation = conversations.find((item) => item.id === event.message.conversationId);
              void notifyIncomingMessage({ profileId: profile.id, conversationId: event.message.conversationId, messageId: message.id, title: conversation?.name ?? "Enter", text: message.text });
            }
          }
          setMessageError("");
          return true;
        } catch (reason) {
          logEvent("crypto", "Realtime message decryption failed", reason instanceof Error ? reason.message : "Decryption error", "error");
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
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let fallbackTimer: ReturnType<typeof setTimeout> | null = null;
    let fallbackDelay = 5_000;
    let realtimeReady = false;
    let reconnectDelay = 1000;

    const startFallbackSync = () => {
      if (!appActive || fallbackTimer !== null || realtimeReady) return;
      fallbackTimer = setTimeout(() => {
        fallbackTimer = null;
        if (cancelled || !appActive || realtimeReady) return;
        syncNotificationsAllowed = true;
        void syncOnce().catch(() => undefined).then(() => {
          if (cancelled || !appActive || realtimeReady) return;
          fallbackDelay = Math.min(30_000, fallbackDelay * 2);
          startFallbackSync();
        });
      }, fallbackDelay);
    };
    const stopFallbackSync = () => {
      if (fallbackTimer !== null) {
        clearTimeout(fallbackTimer);
        fallbackTimer = null;
      }
      fallbackDelay = 5_000;
      syncNotificationsAllowed = false;
    };
    const scheduleRealtimeReconnect = () => {
      if (cancelled || !appActive || reconnectTimer !== null) return;
      const delay = reconnectDelay;
      reconnectDelay = Math.min(30_000, reconnectDelay * 2);
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        if (appActive) connectRealtime();
      }, delay);
    };
    const handleRealtimeClose = (details?: RealtimeClose) => {
      if (cancelled || !appActive) return;
      realtimeReady = false;
      const closeDetails = details ? `code ${details.code}, clean ${details.wasClean}${details.reason ? `, reason ${details.reason}` : ""}` : "code unknown";
      logEvent("realtime", "Realtime connection closed", `${closeDetails}; switching to reconnect`, "warn");
      startFallbackSync();
      scheduleRealtimeReconnect();
    };
    const connectRealtime = () => {
      if (cancelled || !appActive || realtime !== null) return;
      let socket: WebSocket | null = null;
      try {
        socket = openRealtime(profile, cursor, (event) => {
          if (cancelled || !appActive || realtime !== socket) return;
          if (event.type === "ready") {
            realtimeReady = true;
            logEvent("realtime", "Realtime connection established", undefined, "success");
            reconnectDelay = 1000;
            stopFallbackSync();
            setSyncConnected(true);
          } else if (event.type === "sync") {
            realtimeSnapshot = realtimeSnapshot.then(() => applySyncResult(event)).then(() => realtimeQueue.retry());
          } else if (event.type === "folders") {
            setFoldersByProfile((current) => ({ ...current, [profile.id]: event.folders }));
          } else if (event.type === "message" || event.type === "readReceipt" || event.type === "deliveryReceipt") {
            realtimeSnapshot = realtimeSnapshot.then(() => { realtimeQueue.enqueue(event); });
          } else if (event.type === "presence") {
            updateConversations((current) => current.map((conversation) => conversation.id === event.conversationId
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

    const syncInForeground = () => void (async () => {
      try { await syncOnce(); }
      catch (reason) { if (!cancelled && appActive) { setSyncConnected(false); if (isUnauthorized(reason)) { expireProfileSession(profile.id); setMessageError("Сессия сервера истекла. Войдите снова"); } else setMessageError(friendlyError(reason, "Нет подключения к серверу")); } }
    })();

    const suspendRealtime = () => {
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      stopFallbackSync();
      realtimeReady = false;
      const socket = realtime;
      realtime = null;
      socket?.close();
      setSyncConnected(false);
    };
    // A future APNs/FCM wake-up can reuse syncInForeground(); no push transport is installed here.
    const lifecycle = createRealtimeLifecycle(AppState.currentState, {
      onActive: () => {
        appActive = true;
        reconnectDelay = 1000;
        syncInForeground();
        connectRealtime();
      },
      onInactive: () => {
        appActive = false;
        suspendRealtime();
      },
    });
    const appState = AppState.addEventListener("change", lifecycle.change);
    lifecycle.start();
    return () => {
      cancelled = true;
      lifecycle.stop();
      appState.remove();
    };
  }, [activeProfileId, activeProfile?.token, showAuth]);

  function updateConversations(update: (current: Conversation[]) => Conversation[]) {
    if (!activeProfileId) return;
    setConversationsByProfile((current) => {
      const existing = current[activeProfileId] ?? [];
      return { ...current, [activeProfileId]: update(existing) };
    });
  }

  useEffect(() => {
    const value = query.trim();
    if (!activeProfile || !value || (value.includes("@") && !/^@[^@]+(?:@[^@]+)?$/.test(value))) { setSearchUserResult(null); setSearchError(""); setSearchBusy(false); return; }
    const requestId = ++searchRequestId.current;
    const timeout = setTimeout(async () => {
      setSearchBusy(true); setSearchError("");
      try {
        const result = await searchUser(activeProfile, value);
        if (requestId === searchRequestId.current) setSearchUserResult(result);
      } catch (reason) { if (requestId === searchRequestId.current) setSearchError(friendlyError(reason, "Пользователь не найден")); }
      finally { if (requestId === searchRequestId.current) setSearchBusy(false); }
    }, 360);
    return () => clearTimeout(timeout);
  }, [activeProfile, query]);

  async function addProfile(profile: Profile, password: string) {
    await prepareProfile(profile, password);
    await writeSessionToken(profile.id, profile.token);
    const nextProfiles = [...profiles.filter((item) => item.id !== profile.id), profile];
    setProfiles(nextProfiles); setActiveProfileId(profile.id); setShowAuth(false); setScreen("inbox"); setActiveConversationId(null);
    setConversationsByProfile((current) => ({ ...current, [profile.id]: current[profile.id] ?? [] }));
    setFoldersByProfile((current) => ({ ...current, [profile.id]: current[profile.id] ?? [] }));
    setActiveConversationByProfile((current) => ({ ...current, [profile.id]: null }));
    setActiveFolderByProfile((current) => ({ ...current, [profile.id]: ALL_FOLDER }));
  }

  function removeProfile(profile: Profile) {
    const next = profiles.filter((item) => item.id !== profile.id);
    void deleteSessionToken(profile.id);
    void deleteDeviceKeys(profile.id).catch(() => undefined);
    setProfiles(next);
    setConversationsByProfile((current) => { const rest = { ...current }; delete rest[profile.id]; return rest; });
    setActiveConversationByProfile((current) => { const rest = { ...current }; delete rest[profile.id]; return rest; });
    setActiveFolderByProfile((current) => { const rest = { ...current }; delete rest[profile.id]; return rest; });
    setFoldersByProfile((current) => { const rest = { ...current }; delete rest[profile.id]; return rest; });
    setMessagesByProfile((current) => { const rest = { ...current }; delete rest[profile.id]; return rest; });
    setSyncCursors((current) => { const rest = { ...current }; delete rest[profile.id]; return rest; });
    delete syncCursorsRef.current[profile.id];
    setOutboxByProfile((current) => { const rest = { ...current }; delete rest[profile.id]; return rest; });
    if (activeProfileId === profile.id) { setActiveProfileId(next[0]?.id ?? null); setActiveConversationId(null); setScreen("inbox"); setShowAuth(next.length === 0); }
  }

  async function clearMessageCache() {
    if (!activeProfileId) return;
    setMessagesByProfile((current) => {
      const next = { ...current };
      delete next[activeProfileId];
      return next;
    });
    setSyncCursors((current) => ({ ...current, [activeProfileId]: 0 }));
    syncCursorsRef.current[activeProfileId] = 0;
  }

  async function clearOutbox() {
    if (!activeProfileId) return;
    setOutboxByProfile((current) => {
      const next = { ...current };
      delete next[activeProfileId];
      return next;
    });
  }

  async function forgetLocalPrivateKeys() {
    if (activeProfile) await deleteDeviceKeys(activeProfile.id);
  }

  async function deleteAccountAndProfile() {
    if (!activeProfile) return;
    await deleteRemoteAccount(activeProfile);
    removeProfile(activeProfile);
  }

  function expireProfileSession(profileId: string) {
    void deleteSessionToken(profileId);
    const next = profiles.filter((profile) => profile.id !== profileId);
    setProfiles(next);
    if (activeProfileId === profileId) {
      setActiveProfileId(next[0]?.id ?? null);
      setActiveConversationId(null);
      setScreen("inbox");
    }
    setShowAuth(true);
  }

  function selectProfile(profile: Profile) {
    const nextConversationId = activeConversationByProfile[profile.id] ?? null;
    const nextConversations = conversationsByProfile[profile.id] ?? [];
    const hasNextConversation = Boolean(nextConversationId && nextConversations.some((item) => item.id === nextConversationId));
    setActiveProfileId(profile.id); setActiveConversationId(hasNextConversation ? nextConversationId : null); setScreen(hasNextConversation ? "chat" : "inbox"); setReplyTo(null); setEditingMessage(null); setForwardMessage(null); setQuery(""); setSearchUserResult(null); setSearchError("");
  }

  function selectFolder(folder: string) {
    setActiveFolderByProfile((current) => ({ ...current, ...(activeProfileId ? { [activeProfileId]: folder } : {}) }));
    const definition = folders.find((item) => item.id === folder);
    if (folder !== ALL_FOLDER && (!definition || !activeConversation || !folderContains(definition, activeConversation))) {
      setActiveConversationId(null);
      setScreen("inbox");
    }
  }

  function createFolder(draft: Pick<ChatFolder, "name" | "template" | "icon">) {
    if (!activeProfileId) return;
    setFoldersAndSync(activeProfileId, [...folders, { id: makeId(), ...draft, chatIds: [] }]);
  }

  function updateFolder(folder: ChatFolder) {
    if (!activeProfileId) return;
    setFoldersAndSync(activeProfileId, folders.map((item) => item.id === folder.id ? folder : item));
  }

  function deleteFolder(folder: ChatFolder) {
    Alert.alert("Удалить папку?", folder.name, [{ text: "Отмена", style: "cancel" }, { text: "Удалить", style: "destructive", onPress: () => {
      if (!activeProfileId) return;
      setFoldersAndSync(activeProfileId, folders.filter((item) => item.id !== folder.id));
      if (activeFolderByProfile[activeProfileId] === folder.id) setActiveFolderByProfile((current) => ({ ...current, [activeProfileId]: ALL_FOLDER }));
    } }]);
  }

  function toggleConversationFolder(conversationId: string, folderId: string, included: boolean) {
    const folder = folders.find((item) => item.id === folderId);
    if (!folder || folder.template !== "custom") return;
    setFoldersAndSync(activeProfileId!, folders.map((item) => item.id === folderId ? { ...item, chatIds: included ? [...new Set([...item.chatIds, conversationId])] : item.chatIds.filter((chatId) => chatId !== conversationId) } : item));
  }

  async function openSearchUser(user: SearchUser) {
    if (!activeProfile || user.deviceCount === 0) { setSearchError("У пользователя нет активного устройства"); return; }
    const existing = conversations.find((conversation) => conversation.handle === user.address || conversation.handle === user.handle);
    if (existing) { setQuery(""); setSearchUserResult(null); openConversation(existing.id); return; }
    try {
      const conversation = mapRemoteConversation(await createConversation(activeProfile, user));
      updateConversations((current) => current.some((item) => item.id === conversation.id) ? current : [...current, conversation]); setQuery(""); setSearchUserResult(null); openConversation(conversation.id);
    } catch (reason) { setSearchError(friendlyError(reason, "Не удалось создать диалог")); }
  }

  function openConversation(conversationId: string) {
    setActiveConversationId(conversationId); setScreen("chat"); updateConversations((current) => current.map((item) => item.id === conversationId ? { ...item, unread: 0 } : item));
    if (activeProfile) void markConversationRead(activeProfile, conversationId).catch(() => undefined);
  }

  function updateMessages(conversationId: string, update: (current: Message[]) => Message[]) {
    if (!activeProfileId) return;
    setMessagesByProfile((current) => { const profileMessages = current[activeProfileId] ?? {}; return { ...current, [activeProfileId]: { ...profileMessages, [conversationId]: limitMessageList(update(profileMessages[conversationId] ?? [])) } }; });
  }

  function updateLocalMessage(conversationId: string, messageId: string, update: (message: Message) => Message) {
    updateMessages(conversationId, (current) => current.map((item) => item.id === messageId ? update(item) : item));
  }

  function queueOutbox(conversationId: string, message: Message) {
    if (!activeProfileId) return;
    setOutboxByProfile((current) => {
      const entries = current[activeProfileId] ?? [];
      if (entries.some((entry) => entry.id === message.id)) return current;
      const next = limitOutboxEntries([...entries, { id: message.id, conversationId, message: { ...message, deliveryStatus: undefined }, attempts: 0, nextAttemptAt: Date.now() }]);
      return { ...current, [activeProfileId]: next };
    });
  }

  function removeOutbox(messageId: string) {
    if (!activeProfileId) return;
    setOutboxByProfile((current) => {
      const entries = (current[activeProfileId] ?? []).filter((entry) => entry.id !== messageId);
      return entries.length === (current[activeProfileId] ?? []).length ? current : { ...current, [activeProfileId]: entries };
    });
  }

  function failOutbox(messageId: string) {
    if (!activeProfileId) return;
    setOutboxByProfile((current) => {
      const entries = (current[activeProfileId] ?? []).flatMap((entry) => {
        if (entry.id !== messageId) return [entry];
        const attempts = entry.attempts + 1;
        return attempts >= MAX_OUTBOX_ATTEMPTS ? [] : [{ ...entry, attempts, nextAttemptAt: Date.now() + retryDelay(attempts) }];
      });
      return { ...current, [activeProfileId]: entries };
    });
  }

  async function sendMessageToConversation(conversationId: string, message: Message, pendingMedia: PendingMedia[] = [], fromOutbox = false) {
    if (!activeProfile || !activeProfileId) return;
    logEvent("send", fromOutbox ? "Retrying message send" : "Preparing message", `attachments ${pendingMedia.length}`);
    const conversation = conversations.find((item) => item.id === conversationId || (conversationId === "favorites" && item.handle === "favorites"));
    if (!conversation || conversation.canWrite === false) return;
    const targetConversationId = conversation.id;
    const isEdit = Boolean(message.editOf);
    setMessageError("");
    const hasPendingMedia = pendingMedia.length > 0 && !fromOutbox;
    if (hasPendingMedia) setMediaUploadProgress(0);
    if (!hasPendingMedia) queueOutbox(targetConversationId, message);
    if (fromOutbox) {
      updateLocalMessage(targetConversationId, message.id, (current) => ({ ...current, deliveryStatus: "pending" }));
    } else if (!isEdit && !hasPendingMedia) {
      const pendingMessage = { ...message, deliveryStatus: "pending" } satisfies Message;
      updateMessages(targetConversationId, (current) => [...current, pendingMessage]);
      updateConversations((current) => current.map((item) => item.id === targetConversationId ? { ...item, lastMessage: messagePreview(message), time: message.time } : item));
    }
    try {
       const { bundle, account } = await prepareProfile(activeProfile);
      const isDirectConversation = Boolean(conversation.handle && conversation.handle !== "favorites");
      const [ownDevices, fetchedRecipientDevices, fetchedRecipientAccount] = await Promise.all([
        allDeviceKeys(activeProfile, bundle),
        isDirectConversation ? fetchPublicDeviceKeys(activeProfile, conversation.handle!) : Promise.resolve<PublicDeviceKey[]>([]),
        isDirectConversation ? fetchPublicAccountKey(activeProfile, conversation.handle!) : Promise.resolve<PublicAccountKey | undefined>(undefined),
      ]);
      const recipientDevices = isDirectConversation ? fetchedRecipientDevices : ownDevices;
      const recipientAccount = isDirectConversation ? fetchedRecipientAccount : account;
       const recipients = [recipientAccount, ...recipientDevices, ...ownDevices].filter((device): device is PublicDeviceKey | PublicAccountKey => Boolean(device)).filter((device, index, devices) => devices.findIndex((item) => item.keyId === device.keyId) === index);
      const mediaRecipient = recipients[0]?.address;
      if (hasPendingMedia && !mediaRecipient) throw new Error("Не найден получатель вложения");
      let uploadedAttachments = message.attachments;
      if (hasPendingMedia) {
        uploadedAttachments = [];
        for (const [index, pending] of pendingMedia.entries()) {
          const encrypted = "source" in pending ? await encryptMedia(pending.source) : pending.encrypted;
          await uploadMedia(activeProfile, targetConversationId, encrypted.attachment.id, mediaRecipient!, encrypted.ciphertext, (progress) => setMediaUploadProgress(Math.round(((index + progress / 100) / pendingMedia.length) * 100)));
          uploadedAttachments.push(encrypted.attachment);
        }
        setMediaUploadProgress(100);
      }
      const messageToSend: Message = uploadedAttachments ? { ...message, attachments: uploadedAttachments } : message;
      if (hasPendingMedia) {
        queueOutbox(targetConversationId, messageToSend);
        if (!isEdit) {
          const pendingMessage = { ...messageToSend, deliveryStatus: "pending" } satisfies Message;
          updateMessages(targetConversationId, (current) => [...current, pendingMessage]);
          updateConversations((current) => current.map((item) => item.id === targetConversationId ? { ...item, lastMessage: messagePreview(messageToSend), time: messageToSend.time } : item));
        }
      }
      const encryptedMessages = await Promise.all(recipients.map((recipient) => encryptMessage(activeProfile, targetConversationId, messageToSend, recipient)));
      logEvent("crypto", "Message encrypted", `recipients ${encryptedMessages.length}`, "success");
       const localEncryptedMessage = encryptedMessages.find((encryptedMessage) => encryptedMessage.key_id === account?.keyId) ?? encryptedMessages[0];
       const localMessage = { ...messageToSend, encryptedMessage: localEncryptedMessage, deliveryStatus: "pending" } satisfies Message;
      updateLocalMessage(targetConversationId, messageToSend.id, (current) => ({ ...current, ...localMessage }));
      const sent = await sendRemoteMessage(activeProfile, targetConversationId, localMessage, encryptedMessages);
      updateLocalMessage(targetConversationId, messageToSend.id, (current) => ({ ...current, ...localMessage, time: messageTime(new Date(sent.message.createdAt)), stackId: sent.message.stackId, deliveryStatus: undefined }));
      removeOutbox(messageToSend.id);
      setMediaUploadProgress(null);
      logEvent("send", "Message sent", undefined, "success");
    } catch (reason) {
      setMediaUploadProgress(null);
      updateLocalMessage(targetConversationId, message.id, (current) => ({ ...current, deliveryStatus: "failed" }));
      failOutbox(message.id);
      if (isUnauthorized(reason)) { logEvent("send", "Session expired during send", undefined, "error"); expireProfileSession(activeProfile.id); setMessageError("Сессия сервера истекла. Войдите снова"); }
      else { logEvent("send", "Message send failed", reason instanceof Error ? reason.message : "error", "error"); setMessageError(friendlyError(reason, hasPendingMedia ? "Не удалось загрузить вложение. Сообщение не отправлено." : "Сообщение сохранено локально. Повторю отправку автоматически.")); }
    }
  }

  async function retryOutboxForProfile(profileId: string) {
    if (activeProfileId !== profileId) return;
    const now = Date.now();
    for (const entry of outboxRef.current[profileId] ?? []) {
      if (entry.nextAttemptAt > now || retryingOutbox.current.has(entry.id)) continue;
      retryingOutbox.current.add(entry.id);
      logEvent("send", "Retrying queued message", `attempt ${entry.attempts + 1}`);
      void sendMessageToConversation(entry.conversationId, entry.message, [], true).finally(() => retryingOutbox.current.delete(entry.id));
    }
  }

  function sendMessage(message: Message, pendingMedia?: PendingMedia[]) { if (activeConversationId) void sendMessageToConversation(activeConversationId, message, pendingMedia); }

  function updateActiveMessage(messageId: string, update: (message: Message) => Message | null) {
    if (!activeConversationId) return;
    updateMessages(activeConversationId, (current) => current.flatMap((message) => { if (message.id !== messageId) return [message]; const next = update(message); return next ? [next] : []; }));
  }

  function applyMessageEdit(message: Message) {
    if (message.author !== "me") return;
    const conversationId = activeConversationId;
    updateActiveMessage(message.id, () => message);
    setEditingMessage(null);
    if (conversationId) void sendMessageToConversation(conversationId, { id: makeId(), author: "me", text: message.text, time: message.time, editOf: message.id });
  }

  function saveMessage(message: Message) {
    const saved = { ...message, id: makeId(), author: "me" as const, time: messageTime(), replyTo: undefined, reaction: undefined, pinned: false, encryptedMessage: undefined };
    void sendMessageToConversation("favorites", saved);
  }

  async function sendForwardedMessage(message: Message, conversationId: string) {
    setForwardMessage(null);
    try {
      const pendingMedia: PendingMedia[] = activeProfile && message.attachments?.length
        ? await Promise.all(message.attachments.map(async (attachment) => {
            const plaintext = decryptMedia(await downloadMedia(activeProfile, attachment.id), attachment);
            return { encrypted: await encryptMediaBytes(plaintext, attachment) };
          }))
        : [];
      void sendMessageToConversation(conversationId, { ...message, id: makeId(), author: "me", time: messageTime(), attachments: undefined, replyTo: undefined, reaction: undefined, pinned: false, edited: undefined, encryptedMessage: undefined }, pendingMedia);
    } catch (reason) {
      setMessageError(friendlyError(reason, "Не удалось подготовить вложение"));
    }
  }

  function conversationAction(conversation: Conversation, action: Action) {
    if (action === "delete") { Alert.alert("Удалить чат?", conversation.name, [{ text: "Отмена", style: "cancel" }, { text: "Удалить", style: "destructive", onPress: () => { updateConversations((current) => current.map((item) => item.id === conversation.id ? { ...item, deleted: true } : item)); if (activeConversationId === conversation.id) { setActiveConversationId(null); setScreen("inbox"); } } }]); return; }
    if (action === "archive") updateConversations((current) => current.map((item) => item.id === conversation.id ? { ...item, archived: true } : item));
    if (action === "pin") updateConversations((current) => current.map((item) => item.id === conversation.id ? { ...item, pinned: !item.pinned } : item));
    if (action === "unread") updateConversations((current) => current.map((item) => item.id === conversation.id ? { ...item, unread: item.unread ? 0 : 1 } : item));
    if (action === "mute") updateConversations((current) => current.map((item) => item.id === conversation.id ? { ...item, muted: !item.muted } : item));
  }

  if (!hydrated) return <CommonDebugProvider enabled={false}><SafeAreaProvider initialMetrics={initialWindowMetrics}><SafeAreaView style={styles.loading}><Image source={require("./assets/enter_logo.png")} style={styles.logoImage} resizeMode="contain" accessibilityLabel="Enter" /></SafeAreaView></SafeAreaProvider></CommonDebugProvider>;
  if (profiles.length === 0 || showAuth) return <CommonDebugProvider enabled={localSettings.debug.showCommonElements}><SafeAreaProvider initialMetrics={initialWindowMetrics}><AuthScreen onAuthenticated={addProfile} onCancel={profiles.length ? () => setShowAuth(false) : undefined} /></SafeAreaProvider></CommonDebugProvider>;

  return <CommonDebugProvider enabled={localSettings.debug.showCommonElements}><SafeAreaProvider initialMetrics={initialWindowMetrics}><SafeAreaView style={[styles.app, { backgroundColor: themeColors.background }]} edges={["top", "bottom", "left", "right"]}><StatusBar barStyle={themeColors.background === "#f5f5f7" ? "dark-content" : "light-content"} /><View {...(screen === "inbox" || screen === "settings" ? swipeResponder.panHandlers : {})} style={{ flex: 1 }}>
    <Animated.View style={{ flex: 1, transform: [{ translateX: screenMotion.interpolate({ inputRange: [0, 1], outputRange: [screenDirection * viewportWidth, 0] }) }] }}>{screen === "profile" && activeProfile ? <ProfileScreen profile={activeProfile} onClose={() => setScreen("inbox")} onOpenProfiles={() => setShowProfiles(true)} onAddProfile={() => setShowAuth(true)} /> : screen === "settings" && activeProfile ? <SettingsScreen profile={activeProfile} themeColors={themeColors} onClose={() => setScreen("inbox")} onOpenLogs={() => setScreen("logs")} onClearMessageCache={clearMessageCache} onClearOutbox={clearOutbox} onForgetLocalPrivateKeys={forgetLocalPrivateKeys} onDeleteAccount={deleteAccountAndProfile} onSettingsChange={setLocalSettings} /> : screen === "chat" && activeConversation && activeProfile ? <ChatScreen profile={activeProfile} conversation={activeConversation} messages={messages} error={messageError} uploadProgress={mediaUploadProgress} messageTextSize={localSettings.messageTextSize} bubbleRadius={localSettings.bubbleRadius} themeColors={themeColors} mediaSettings={localSettings.media} energySavingActive={energySavingActive} replyTo={replyTo} editingMessage={editingMessage} onBack={() => { setScreen("inbox"); setActiveConversationId(null); }} onSend={sendMessage} onReply={(message) => { setEditingMessage(null); setReplyTo(message); }} onEdit={applyMessageEdit} onPin={(message) => updateActiveMessage(message.id, (current) => ({ ...current, pinned: !current.pinned }))} onSave={saveMessage} onDelete={(message) => updateActiveMessage(message.id, () => null)} onReact={(message, reaction) => updateActiveMessage(message.id, (current) => ({ ...current, reaction: current.reaction === reaction ? undefined : reaction }))} onForward={setForwardMessage} onCancelContext={() => { setReplyTo(null); setEditingMessage(null); }} /> : <ConversationList profile={activeProfile} themeColors={themeColors} syncConnected={syncConnected} conversations={conversationsWithPreviews} folders={folders} activeFolder={activeProfileId ? activeFolderByProfile[activeProfileId] ?? ALL_FOLDER : ALL_FOLDER} listLayout={localSettings.chatListLayout} activeId={activeConversationId} query={query} searchUser={searchUserResult} searchBusy={searchBusy} searchError={searchError} onQueryChange={setQuery} onSelect={openConversation} onProfilePress={() => setShowProfiles(true)} onOpenSearchUser={openSearchUser} onAction={conversationAction} onSelectFolder={selectFolder} onCreateFolder={createFolder} onUpdateFolder={updateFolder} onDeleteFolder={deleteFolder} onToggleConversationFolder={toggleConversationFolder} />}</Animated.View>
    {screen !== "chat" && <BottomNav themeColors={themeColors} screen={screen} onInbox={() => setScreen("inbox")} onProfile={() => setScreen("profile")} onSettings={() => setScreen("settings")} />}
    <ProfileSheet visible={showProfiles} profiles={profiles} activeProfile={activeProfile} onClose={() => setShowProfiles(false)} onSelect={selectProfile} onAdd={() => setShowAuth(true)} onRemove={removeProfile} />
    <ForwardSheet visible={Boolean(forwardMessage)} message={forwardMessage} conversations={conversations} currentId={activeConversationId} onClose={() => setForwardMessage(null)} onForward={(id) => forwardMessage && sendForwardedMessage(forwardMessage, id)} />
    {screen === "logs" && <View style={styles.logsOverlay}><LogsScreen onClose={() => setScreen("settings")} /></View>}
  </View></SafeAreaView></SafeAreaProvider></CommonDebugProvider>;
}

function BottomNav({ themeColors = colors, screen, onInbox, onProfile, onSettings }: { themeColors?: typeof colors; screen: Screen; onInbox: () => void; onProfile: () => void; onSettings: () => void }) {
  return <View style={[styles.bottomNav, { backgroundColor: themeColors.surface, borderColor: themeColors.border }]}><NavButton themeColors={themeColors} active={screen === "inbox"} icon="chat" label="Чаты" onPress={onInbox} /><NavButton themeColors={themeColors} active={screen === "profile"} icon="person" label="Профиль" onPress={onProfile} /><NavButton themeColors={themeColors} active={screen === "settings"} icon="settings" label="Настройки" onPress={onSettings} /></View>;
}

function NavButton({ themeColors = colors, active, icon, label, onPress }: { themeColors?: typeof colors; active: boolean; icon: "chat" | "person" | "settings"; label: string; onPress: () => void }) {
  return <Pressable onPress={onPress} style={({ pressed }) => [styles.navButton, active && { backgroundColor: themeColors.accent }, pressed && styles.pressed]}><Icon name={icon} size={20} color={active ? themeColors.foreground : themeColors.muted} /><Text style={[styles.navLabel, active && { color: themeColors.foreground }]}>{label}</Text></Pressable>;
}

const styles = StyleSheet.create({
  app: { flex: 1, backgroundColor: colors.background },
  logsOverlay: { position: "absolute", top: 0, right: 0, bottom: 0, left: 0, zIndex: 20, backgroundColor: colors.background },
  loading: { flex: 1, backgroundColor: colors.background, alignItems: "center", justifyContent: "center" },
  logoImage: { width: 140, height: 28 },
  bottomNav: { minHeight: 68, marginHorizontal: 12, marginBottom: 8, borderRadius: 24, borderWidth: 1, borderColor: colors.border, paddingHorizontal: 8, paddingBottom: 7, paddingTop: 7, flexDirection: "row", gap: 8, backgroundColor: colors.surface, shadowColor: "#000000", shadowOpacity: 0.28, shadowRadius: 14, shadowOffset: { width: 0, height: 6 }, elevation: 8 },
  navButton: { flex: 1, borderRadius: 18, alignItems: "center", justifyContent: "center", gap: 3 },
  navActive: { backgroundColor: colors.accent },
  navLabel: { color: colors.muted, fontFamily: fonts.bodySemibold, fontSize: 11 },
  navLabelActive: { color: colors.foreground },
  pressed: { opacity: 0.72 },
});
