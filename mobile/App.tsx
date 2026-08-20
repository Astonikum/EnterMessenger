import AsyncStorage from "@react-native-async-storage/async-storage";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useFonts } from "expo-font";
import { IBMPlexSans_400Regular } from "@expo-google-fonts/ibm-plex-sans/400Regular";
import { IBMPlexSans_500Medium } from "@expo-google-fonts/ibm-plex-sans/500Medium";
import { IBMPlexSans_600SemiBold } from "@expo-google-fonts/ibm-plex-sans/600SemiBold";
import { IBMPlexSans_700Bold } from "@expo-google-fonts/ibm-plex-sans/700Bold";
import { Montserrat_500Medium } from "@expo-google-fonts/montserrat/500Medium";
import { Montserrat_600SemiBold } from "@expo-google-fonts/montserrat/600SemiBold";
import { Montserrat_700Bold } from "@expo-google-fonts/montserrat/700Bold";
import * as NavigationBar from "expo-navigation-bar";
import { Alert, Animated, AppState, Easing, Image, Platform, Pressable, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { initialWindowMetrics, SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import { AuthScreen } from "./src/components/AuthScreen";
import { ConversationList, type Action } from "./src/components/ConversationList";
import { ChatScreen, ForwardSheet } from "./src/components/ChatScreen";
import { Icon } from "./src/components/Icon";
import { ProfileSheet } from "./src/components/ProfileSheet";
import { SettingsScreen } from "./src/components/SettingsScreen";
import { EMPTY_MESSAGES, makeId, messageTime } from "./src/data";
import { accountKeyBundle, decodeMessagePayload, decryptMessage, deleteDeviceKeys, deviceKeyBundle, encryptMessage, ensureAccountKey, ensureDeviceKeys, readAccountKey, type PublicAccountKey, type PublicDeviceKey } from "./src/rn-e2e";
import { acknowledgeMessage, createConversation, fetchPublicAccountKey, fetchPublicDeviceKeys, mapRemoteConversation, markConversationRead, openRealtime, registerDeviceKey, searchUser, sendMessage as sendRemoteMessage, syncDeviceHistory, syncProfile, type RealtimeEvent, type RemoteDeliveryReceipt, type RemoteMessage, type SyncResponse } from "./src/rn-api";
import { colors, fonts } from "./src/theme";
import { migrateLocalServerAddress } from "./src/rn-address";
import { createRealtimeQueue, createSyncQueue } from "./src/sync-queue";
import { createRealtimeLifecycle } from "./src/realtime-lifecycle";
import type { Conversation, Message, OutboxEntry, Profile, SearchUser } from "./src/types";

const PROFILES_KEY = "enter-profiles";
const MESSAGES_KEY = "enter-mobile-messages";
const CURSORS_KEY = "enter-mobile-sync-cursors";
const CONVERSATIONS_KEY = "enter-mobile-conversations";
const NAVIGATION_KEY = "enter-mobile-navigation";
const OUTBOX_KEY = "enter-mobile-outbox";
const ALL_FOLDER = "all";

type Screen = "inbox" | "chat" | "settings";
type MessagesByProfile = Record<string, Record<string, Message[]>>;
type ConversationsByProfile = Record<string, Conversation[]>;
type NavigationState = {
  activeProfileId?: string | null;
  activeConversationByProfile?: Record<string, string | null>;
  activeFolderByProfile?: Record<string, string>;
  screen?: Screen;
};

function isCachedConversation(value: unknown): value is Conversation {
  if (!value || typeof value !== "object") return false;
  const conversation = value as Partial<Conversation>;
  return typeof conversation.id === "string"
    && typeof conversation.name === "string"
    && typeof conversation.avatar === "string"
    && typeof conversation.lastMessage === "string"
    && typeof conversation.time === "string";
}

function profileAddress(profile: Profile) {
  return `${profile.handle.replace(/^@+/, "")}@${profile.server.replace(/^https?:\/\//, "")}`;
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
  await registerDeviceKey(profile, deviceKeyBundle(device), account ? { keyId: account.keyId, encryptionPublicKey: account.encryptionPublicKey } : undefined);
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
  return { id: remote.envelope.message_id, author: remote.author, text: payload.text, editOf: payload.editOf, time: messageTime(new Date(remote.createdAt)), stackId: remote.stackId, envelope: remote.envelope };
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
    const index = existing.findIndex((item) => item.id === message.id);
    if (index < 0) next[conversationId] = [...existing, message];
    else { const replaced = [...existing]; replaced[index] = { ...replaced[index], ...message, readAt: message.readAt ?? replaced[index].readAt, deliveredAt: message.deliveredAt ?? replaced[index].deliveredAt }; next[conversationId] = replaced; }
    next[conversationId] = resolveMessageEdits(next[conversationId]);
  });
  return next;
}

function mergeReadReceipts(current: Record<string, Message[]>, receipts: Array<{ messageId: string; readAt: number }>) {
  if (receipts.length === 0) return current;
  const reads = new Map(receipts.map((receipt) => [receipt.messageId, receipt.readAt]));
  return Object.fromEntries(Object.entries(current).map(([conversationId, messages]) => [conversationId, messages.map((message) => {
    const readAt = reads.get(message.id);
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

export default function App() {
  const [fontsLoaded] = useFonts({ IBMPlexSans_400Regular, IBMPlexSans_500Medium, IBMPlexSans_600SemiBold, IBMPlexSans_700Bold, Montserrat_500Medium, Montserrat_600SemiBold, Montserrat_700Bold });
  const [hydrated, setHydrated] = useState(false);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [activeProfileId, setActiveProfileId] = useState<string | null>(null);
  const [messagesByProfile, setMessagesByProfile] = useState<MessagesByProfile>({});
  const [syncCursors, setSyncCursors] = useState<Record<string, number>>({});
  const [outboxByProfile, setOutboxByProfile] = useState<Record<string, OutboxEntry[]>>({});
  const [syncConnected, setSyncConnected] = useState(false);
  const [conversationsByProfile, setConversationsByProfile] = useState<ConversationsByProfile>({});
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
  const screenMotion = useRef(new Animated.Value(1)).current;
  const previousScreen = useRef<Screen>(screen);
  const hasRenderedScreen = useRef(false);
  const { width: viewportWidth } = useWindowDimensions();

  useLayoutEffect(() => {
    if (!hasRenderedScreen.current) {
      hasRenderedScreen.current = true;
      previousScreen.current = screen;
      screenMotion.setValue(1);
      return;
    }
    const movingBack = (previousScreen.current === "chat" && screen !== "chat") || (previousScreen.current === "settings" && screen === "inbox");
    previousScreen.current = screen;
    setScreenDirection(movingBack ? -1 : 1);
    screenMotion.setValue(0);
    Animated.timing(screenMotion, { toValue: 1, duration: 220, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
  }, [screen, screenMotion]);

  useEffect(() => {
    if (Platform.OS !== "android") return;
    void NavigationBar.setBackgroundColorAsync(colors.background);
    void NavigationBar.setButtonStyleAsync("light");
  }, []);

  const activeProfile = profiles.find((profile) => profile.id === activeProfileId);
  const conversations = activeProfileId ? conversationsByProfile[activeProfileId] ?? [] : [];
  const activeConversation = conversations.find((conversation) => conversation.id === activeConversationId);
  const activeMessages = activeProfileId ? messagesByProfile[activeProfileId] ?? EMPTY_MESSAGES : EMPTY_MESSAGES;
  const messages = activeConversationId ? (activeMessages[activeConversationId] ?? []).filter((message) => !message.editOf) : [];
  const conversationsWithPreviews = useMemo(() => conversations.map((conversation) => {
    const ownMessages = (activeMessages[conversation.id] ?? []).filter((message) => !message.editOf);
    const latest = ownMessages[ownMessages.length - 1];
    return latest ? { ...conversation, lastMessage: latest.text, time: latest.time } : { ...conversation, lastMessage: "", time: "" };
  }), [activeMessages, conversations]);

  useEffect(() => { messagesByProfileRef.current = messagesByProfile; }, [messagesByProfile]);
  useEffect(() => { syncCursorsRef.current = syncCursors; }, [syncCursors]);

  useEffect(() => {
    Promise.all([AsyncStorage.getItem(PROFILES_KEY), AsyncStorage.getItem(MESSAGES_KEY), AsyncStorage.getItem(CURSORS_KEY), AsyncStorage.getItem(CONVERSATIONS_KEY), AsyncStorage.getItem(NAVIGATION_KEY), AsyncStorage.getItem(OUTBOX_KEY)]).then(([storedProfiles, storedMessages, storedCursors, storedConversations, storedNavigation, storedOutbox]) => {
      let validProfiles: Profile[] = [];
      let navigation: NavigationState = {};
      let cachedConversations: ConversationsByProfile = {};
      try {
        const parsed = storedProfiles ? JSON.parse(storedProfiles) as Profile[] : [];
        validProfiles = Array.isArray(parsed) ? parsed.filter((profile) => typeof profile?.token === "string" && profile.token.length > 0).map((profile) => ({ ...profile, server: migrateLocalServerAddress(profile.server) })) : [];
        setProfiles(validProfiles); setShowAuth(validProfiles.length === 0);
        if (storedProfiles && JSON.stringify(validProfiles) !== storedProfiles) void AsyncStorage.setItem(PROFILES_KEY, JSON.stringify(validProfiles));
      } catch { setShowAuth(true); }
      try {
        const parsed = storedMessages ? JSON.parse(storedMessages) as MessagesByProfile : {};
        setMessagesByProfile(parsed && typeof parsed === "object" ? parsed : {});
      } catch { setMessagesByProfile({}); }
      try {
        const parsed = storedCursors ? JSON.parse(storedCursors) as Record<string, number> : {};
        setSyncCursors(parsed && typeof parsed === "object" ? parsed : {});
      } catch { setSyncCursors({}); }
      try {
        const parsed = storedConversations ? JSON.parse(storedConversations) as ConversationsByProfile : {};
        cachedConversations = parsed && typeof parsed === "object"
          ? Object.fromEntries(Object.entries(parsed).map(([profileId, items]) => [profileId, Array.isArray(items) ? items.filter(isCachedConversation) : []]))
          : {};
        setConversationsByProfile(cachedConversations);
      } catch { setConversationsByProfile({}); }
      try {
        const parsed = storedNavigation ? JSON.parse(storedNavigation) as NavigationState : {};
        navigation = parsed && typeof parsed === "object" ? parsed : {};
      } catch { navigation = {}; }
      try {
        const parsed = storedOutbox ? JSON.parse(storedOutbox) as Record<string, OutboxEntry[]> : {};
        setOutboxByProfile(parsed && typeof parsed === "object" ? parsed : {});
      } catch { setOutboxByProfile({}); }
      const selectedProfileId = validProfiles.some((profile) => profile.id === navigation.activeProfileId) ? navigation.activeProfileId ?? null : validProfiles[0]?.id ?? null;
      const selectedConversationId = selectedProfileId ? navigation.activeConversationByProfile?.[selectedProfileId] ?? null : null;
      setActiveProfileId(selectedProfileId);
      setActiveConversationId(selectedConversationId);
      setActiveConversationByProfile(navigation.activeConversationByProfile ?? {});
      setActiveFolderByProfile(navigation.activeFolderByProfile ?? {});
      const hasSelectedConversation = Boolean(selectedProfileId && selectedConversationId && (cachedConversations[selectedProfileId] ?? []).some((item) => item.id === selectedConversationId));
      setScreen(navigation.screen === "settings" ? "settings" : hasSelectedConversation ? "chat" : "inbox");
      setHydrated(true);
    }).catch(() => { setHydrated(true); setShowAuth(true); });
  }, []);

  useEffect(() => { if (hydrated) void AsyncStorage.setItem(PROFILES_KEY, JSON.stringify(profiles)); }, [hydrated, profiles]);
  useEffect(() => { if (hydrated) void AsyncStorage.setItem(MESSAGES_KEY, JSON.stringify(messagesByProfile)); }, [hydrated, messagesByProfile]);
  useEffect(() => { if (hydrated) void AsyncStorage.setItem(CURSORS_KEY, JSON.stringify(syncCursors)); }, [hydrated, syncCursors]);
  useEffect(() => { outboxRef.current = outboxByProfile; if (hydrated) void AsyncStorage.setItem(OUTBOX_KEY, JSON.stringify(outboxByProfile)); }, [hydrated, outboxByProfile]);
  useEffect(() => { if (hydrated) void AsyncStorage.setItem(CONVERSATIONS_KEY, JSON.stringify(conversationsByProfile)); }, [hydrated, conversationsByProfile]);
  useEffect(() => {
    if (!hydrated || !activeProfileId) return;
    setActiveConversationByProfile((current) => ({ ...current, [activeProfileId]: activeConversationId }));
  }, [hydrated, activeProfileId, activeConversationId]);
  useEffect(() => {
    if (!hydrated) return;
    void AsyncStorage.setItem(NAVIGATION_KEY, JSON.stringify({ activeProfileId, activeConversationByProfile, activeFolderByProfile, screen } satisfies NavigationState));
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

     const senderDevicesFor = (address: string) => {
       const cached = senderDeviceCache.get(address);
       if (cached) return cached;
       const request = fetchPublicDeviceKeys(profile, address);
       senderDeviceCache.set(address, request);
       return request;
     };

     const historyMessageKey = (message: Message) => `${message.id}:${message.text}`;

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
        if (isUnauthorized(reason)) { setMessageError("РЎРµСЃСЃРёСЏ СЃРµСЂРІРµСЂР° РёСЃС‚РµРєР»Р°. Р’РѕР№РґРёС‚Рµ СЃРЅРѕРІР°"); setShowAuth(true); }
        return null;
      } finally {
        preparing = false;
      }
    }

     async function backfillHistoryToAccount() {
       const target = ownAccount;
       if (cancelled || !ownBundle || !target) return;
       const history = Object.entries(messagesByProfileRef.current[profile.id] ?? {}).flatMap(([conversationId, items]) => items.filter((message) => message.envelope && !message.editOf).map((message) => ({ conversationId, message })));
       if (history.length === 0) return;
       const sent = historySyncSent.get(target.keyId) ?? new Set<string>();
       const pendingHistory = history.filter(({ message }) => !sent.has(historyMessageKey(message)));
       if (pendingHistory.length === 0) return;
       const targetKey = `${target.keyId}:${pendingHistory.length}:${pendingHistory[pendingHistory.length - 1]?.message.id ?? ""}`;
       if (historySyncComplete.has(targetKey)) return;
       try {
         for (let index = 0; index < pendingHistory.length; index += 50) {
           const chunk = pendingHistory.slice(index, index + 50);
           const entries = await Promise.all(chunk.map(async ({ conversationId, message }) => ({ conversationId, messageId: message.id, sourceKeyId: message.envelope?.key_id, envelope: await encryptMessage(profile, conversationId, message, target) })));
           await syncDeviceHistory(profile, entries);
           chunk.forEach(({ message }) => sent.add(historyMessageKey(message)));
         }
         historySyncSent.set(target.keyId, sent);
         historySyncComplete.add(targetKey);
       } catch (reason) {
         if (isUnauthorized(reason)) setShowAuth(true);
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
       const history = Object.entries(messagesByProfileRef.current[profile.id] ?? {}).flatMap(([conversationId, items]) => items.filter((message) => message.envelope && !message.editOf).map((message) => ({ conversationId, message })));
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
             const entries = await Promise.all(chunk.map(async ({ conversationId, message }) => ({ conversationId, messageId: message.id, sourceKeyId: message.envelope?.key_id, envelope: await encryptMessage(profile, conversationId, message, target) })));
             await syncDeviceHistory(profile, entries);
             chunk.forEach(({ message }) => sent.add(historyMessageKey(message)));
           }
           historySyncSent.set(target.keyId, sent);
           historySyncComplete.add(targetKey);
        } catch (reason) {
          if (isUnauthorized(reason)) { setMessageError("Сессия сервера истекла. Войдите снова"); setShowAuth(true); }
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
      setSyncConnected(true);
      result.conversations.forEach((conversation) => knownConversationIds.add(conversation.id));
      updateConversations((current) => {
        const currentById = new Map(current.map((conversation) => [conversation.id, conversation]));
        const currentOrder = current.map((conversation) => conversation.id);
        return result.conversations.map((remote) => {
          const mapped = mapRemoteConversation(remote);
          const local = currentById.get(mapped.id);
          return local ? { ...mapped, pinned: local.pinned, muted: local.muted, archived: local.archived, deleted: local.deleted, folder: local.folder } : mapped;
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
      const deviceMessages = result.messages.filter((remote) => ownKeyIds.has(remote.envelope.key_id));
      const decrypted = (await Promise.all(deviceMessages.map(async (remote) => {
        try { return { conversationId: remote.conversationId, message: await decryptRemoteMessage(profile, remote, await senderDevicesFor(remote.envelope.sender)) }; }
        catch { return null; }
      }))).filter((value): value is { conversationId: string; message: Message } => value !== null);
      const decryptFailures = deviceMessages.length - decrypted.length;
      if (cancelled || !appActive) return false;
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
        return { ...current, [profile.id]: mergeDeliveryReceipts(mergeReadReceipts(mergeRemoteMessages(existing, decrypted), result.readReceipts ?? []), result.deliveryReceipts ?? []) };
      });
      if (decryptFailures === 0) advanceCursor(Math.max(cursor, result.nextCursor));
      setMessageError(decryptFailures > 0 ? `Не удалось расшифровать ${decryptFailures} сообщений. Курсор не сдвинут, синхронизация повторится.` : "");
      void backfillHistoryToAccount();
      void backfillHistoryToDevices();
      void retryOutboxForProfile(profile.id);
      return decryptFailures === 0;
    }

    const syncOnce = createSyncQueue(async () => {
      if (cancelled || !appActive) return;
      try {
        cursor = Math.max(cursor, syncCursorsRef.current[profile.id] ?? 0);
        await applySyncResult(await syncProfile(profile, cursor));
      } catch (reason) {
        if (cancelled || !appActive) return;
        setSyncConnected(false);
        if (isUnauthorized(reason)) { setMessageError("Сессия сервера истекла. Войдите снова"); setShowAuth(true); }
        else setMessageError(reason instanceof Error ? `Нет подключения к серверу: ${reason.message}` : "Нет подключения к серверу");
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
            updateConversations((current) => current.map((conversation) => conversation.id === event.message.conversationId && conversation.id !== activeConversationId ? { ...conversation, unread: (conversation.unread ?? 0) + 1 } : conversation));
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
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let fallbackInterval: ReturnType<typeof setInterval> | null = null;
    let reconnectDelay = 1000;

    const startFallbackSync = () => {
      if (!appActive || fallbackInterval !== null) return;
      fallbackInterval = setInterval(() => { if (appActive) void syncOnce(); }, 500);
    };
    const stopFallbackSync = () => {
      if (fallbackInterval !== null) {
        clearInterval(fallbackInterval);
        fallbackInterval = null;
      }
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
    const handleRealtimeClose = () => {
      if (cancelled || !appActive) return;
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
            reconnectDelay = 1000;
            stopFallbackSync();
            setSyncConnected(true);
          } else if (event.type === "sync") {
            realtimeSnapshot = realtimeSnapshot.then(() => applySyncResult(event)).then(() => realtimeQueue.retry());
          } else if (event.type === "message" || event.type === "readReceipt" || event.type === "deliveryReceipt") {
            realtimeSnapshot = realtimeSnapshot.then(() => { realtimeQueue.enqueue(event); });
          } else if (event.type === "presence") {
            updateConversations((current) => current.map((conversation) => conversation.id === event.conversationId
              ? { ...conversation, online: event.online, lastSeenAt: event.lastSeenAt }
              : conversation));
          } else if (event.type === "error") {
            socket?.close();
          }
        }, () => {
          if (realtime !== socket) return;
          realtime = null;
          handleRealtimeClose();
        });
        realtime = socket;
      } catch {
        handleRealtimeClose();
      }
    };

    const syncInForeground = () => void (async () => {
      try { await syncOnce(); }
      catch (reason) { if (!cancelled && appActive) { setSyncConnected(false); if (isUnauthorized(reason)) { setMessageError("Сессия сервера истекла. Войдите снова"); setShowAuth(true); } else setMessageError(reason instanceof Error ? `Нет подключения к серверу: ${reason.message}` : "Нет подключения к серверу"); } }
    })();

    const suspendRealtime = () => {
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      stopFallbackSync();
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
      } catch (reason) { if (requestId === searchRequestId.current) setSearchError(reason instanceof Error ? reason.message : "Пользователь не найден"); }
      finally { if (requestId === searchRequestId.current) setSearchBusy(false); }
    }, 360);
    return () => clearTimeout(timeout);
  }, [activeProfile, query]);

  async function addProfile(profile: Profile, password: string) {
    await prepareProfile(profile, password);
    const nextProfiles = [...profiles.filter((item) => item.id !== profile.id), profile];
    setProfiles(nextProfiles); setActiveProfileId(profile.id); setShowAuth(false); setScreen("inbox"); setActiveConversationId(null);
    setConversationsByProfile((current) => ({ ...current, [profile.id]: current[profile.id] ?? [] }));
    setActiveConversationByProfile((current) => ({ ...current, [profile.id]: null }));
    setActiveFolderByProfile((current) => ({ ...current, [profile.id]: ALL_FOLDER }));
  }

  function removeProfile(profile: Profile) {
    const next = profiles.filter((item) => item.id !== profile.id);
    void deleteDeviceKeys(profile.id).catch(() => undefined);
    setProfiles(next);
    setConversationsByProfile((current) => { const rest = { ...current }; delete rest[profile.id]; return rest; });
    setActiveConversationByProfile((current) => { const rest = { ...current }; delete rest[profile.id]; return rest; });
    setActiveFolderByProfile((current) => { const rest = { ...current }; delete rest[profile.id]; return rest; });
    setMessagesByProfile((current) => { const rest = { ...current }; delete rest[profile.id]; return rest; });
    setSyncCursors((current) => { const rest = { ...current }; delete rest[profile.id]; return rest; });
    delete syncCursorsRef.current[profile.id];
    setOutboxByProfile((current) => { const rest = { ...current }; delete rest[profile.id]; return rest; });
    if (activeProfileId === profile.id) { setActiveProfileId(next[0]?.id ?? null); setActiveConversationId(null); setScreen("inbox"); setShowAuth(next.length === 0); }
  }

  function selectProfile(profile: Profile) {
    const nextConversationId = activeConversationByProfile[profile.id] ?? null;
    const nextConversations = conversationsByProfile[profile.id] ?? [];
    const hasNextConversation = Boolean(nextConversationId && nextConversations.some((item) => item.id === nextConversationId));
    setActiveProfileId(profile.id); setActiveConversationId(hasNextConversation ? nextConversationId : null); setScreen(hasNextConversation ? "chat" : "inbox"); setReplyTo(null); setEditingMessage(null); setForwardMessage(null); setQuery(""); setSearchUserResult(null); setSearchError("");
  }

  function selectFolder(folder: string) {
    setActiveFolderByProfile((current) => ({ ...current, ...(activeProfileId ? { [activeProfileId]: folder } : {}) }));
    if (folder !== ALL_FOLDER && activeConversation?.folder !== folder) {
      setActiveConversationId(null);
      setScreen("inbox");
    }
  }

  async function openSearchUser(user: SearchUser) {
    if (!activeProfile || user.deviceCount === 0) { setSearchError("У пользователя нет активного устройства"); return; }
    const existing = conversations.find((conversation) => conversation.handle === user.address || conversation.handle === user.handle);
    if (existing) { setQuery(""); setSearchUserResult(null); openConversation(existing.id); return; }
    try {
      const conversation = mapRemoteConversation(await createConversation(activeProfile, user));
      updateConversations((current) => current.some((item) => item.id === conversation.id) ? current : [...current, conversation]); setQuery(""); setSearchUserResult(null); openConversation(conversation.id);
    } catch (reason) { setSearchError(reason instanceof Error ? reason.message : "Не удалось создать диалог"); }
  }

  function openConversation(conversationId: string) {
    setActiveConversationId(conversationId); setScreen("chat"); updateConversations((current) => current.map((item) => item.id === conversationId ? { ...item, unread: 0 } : item));
    if (activeProfile) void markConversationRead(activeProfile, conversationId).catch(() => undefined);
  }

  function updateMessages(conversationId: string, update: (current: Message[]) => Message[]) {
    if (!activeProfileId) return;
    setMessagesByProfile((current) => { const profileMessages = current[activeProfileId] ?? {}; return { ...current, [activeProfileId]: { ...profileMessages, [conversationId]: update(profileMessages[conversationId] ?? []) } }; });
  }

  function updateLocalMessage(conversationId: string, messageId: string, update: (message: Message) => Message) {
    updateMessages(conversationId, (current) => current.map((item) => item.id === messageId ? update(item) : item));
  }

  function queueOutbox(conversationId: string, message: Message) {
    if (!activeProfileId) return;
    setOutboxByProfile((current) => {
      const entries = current[activeProfileId] ?? [];
      if (entries.some((entry) => entry.id === message.id)) return current;
      return { ...current, [activeProfileId]: [...entries, { id: message.id, conversationId, message: { ...message, deliveryStatus: undefined }, attempts: 0, nextAttemptAt: Date.now() }] };
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
      const entries = (current[activeProfileId] ?? []).map((entry) => entry.id === messageId ? { ...entry, attempts: entry.attempts + 1, nextAttemptAt: Date.now() + retryDelay(entry.attempts + 1) } : entry);
      return { ...current, [activeProfileId]: entries };
    });
  }

  async function sendMessageToConversation(conversationId: string, message: Message, fromOutbox = false) {
    if (!activeProfile || !activeProfileId) return;
    const conversation = conversations.find((item) => item.id === conversationId || (conversationId === "favorites" && item.handle === "favorites"));
    if (!conversation || conversation.canWrite === false) return;
    const targetConversationId = conversation.id;
    const isEdit = Boolean(message.editOf);
    setMessageError("");
    queueOutbox(targetConversationId, message);
    if (fromOutbox) {
      updateLocalMessage(targetConversationId, message.id, (current) => ({ ...current, deliveryStatus: "pending" }));
    } else if (!isEdit) {
      const pendingMessage = { ...message, deliveryStatus: "pending" } satisfies Message;
      updateMessages(targetConversationId, (current) => [...current, pendingMessage]);
      updateConversations((current) => current.map((item) => item.id === targetConversationId ? { ...item, lastMessage: message.text, time: message.time } : item));
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
      const envelopes = await Promise.all(recipients.map((recipient) => encryptMessage(activeProfile, targetConversationId, message, recipient)));
       const localEnvelope = envelopes.find((envelope) => envelope.key_id === account?.keyId) ?? envelopes[0];
       const localMessage = { ...message, envelope: localEnvelope, deliveryStatus: "pending" } satisfies Message;
      updateLocalMessage(targetConversationId, message.id, (current) => ({ ...current, ...localMessage }));
      const sent = await sendRemoteMessage(activeProfile, targetConversationId, localMessage, envelopes);
      updateLocalMessage(targetConversationId, message.id, (current) => ({ ...current, ...localMessage, time: messageTime(new Date(sent.message.createdAt)), stackId: sent.message.stackId, deliveryStatus: undefined }));
      removeOutbox(message.id);
    } catch (reason) {
      updateLocalMessage(targetConversationId, message.id, (current) => ({ ...current, deliveryStatus: "failed" }));
      failOutbox(message.id);
      if (isUnauthorized(reason)) { setShowAuth(true); setMessageError("Сессия сервера истекла. Войдите снова"); }
      else setMessageError(reason instanceof Error ? `Не удалось отправить: ${reason.message}` : "Сообщение сохранено локально. Повторю отправку автоматически.");
    }
  }

  async function retryOutboxForProfile(profileId: string) {
    if (activeProfileId !== profileId) return;
    const now = Date.now();
    for (const entry of outboxRef.current[profileId] ?? []) {
      if (entry.nextAttemptAt > now || retryingOutbox.current.has(entry.id)) continue;
      retryingOutbox.current.add(entry.id);
      void sendMessageToConversation(entry.conversationId, entry.message, true).finally(() => retryingOutbox.current.delete(entry.id));
    }
  }

  function sendMessage(message: Message) { if (activeConversationId) void sendMessageToConversation(activeConversationId, message); }

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
    const saved = { ...message, id: makeId(), author: "me" as const, time: messageTime(), replyTo: undefined, reaction: undefined, pinned: false, envelope: undefined };
    void sendMessageToConversation("favorites", saved);
  }

  function sendForwardedMessage(message: Message, conversationId: string) {
    setForwardMessage(null);
    void sendMessageToConversation(conversationId, { ...message, id: makeId(), author: "me", time: messageTime(), replyTo: undefined, reaction: undefined, pinned: false, edited: undefined, envelope: undefined });
  }

  function conversationAction(conversation: Conversation, action: Action) {
    if (action === "delete") { Alert.alert("Удалить чат?", conversation.name, [{ text: "Отмена", style: "cancel" }, { text: "Удалить", style: "destructive", onPress: () => { updateConversations((current) => current.map((item) => item.id === conversation.id ? { ...item, deleted: true } : item)); if (activeConversationId === conversation.id) { setActiveConversationId(null); setScreen("inbox"); } } }]); return; }
    if (action === "archive") updateConversations((current) => current.map((item) => item.id === conversation.id ? { ...item, archived: true } : item));
    if (action === "pin") updateConversations((current) => current.map((item) => item.id === conversation.id ? { ...item, pinned: !item.pinned } : item));
    if (action === "unread") updateConversations((current) => current.map((item) => item.id === conversation.id ? { ...item, unread: item.unread ? 0 : 1 } : item));
    if (action === "mute") updateConversations((current) => current.map((item) => item.id === conversation.id ? { ...item, muted: !item.muted } : item));
    if (action === "folder") updateConversations((current) => current.map((item) => item.id === conversation.id ? { ...item, folder: item.folder ? undefined : "Личное" } : item));
  }

  if (!hydrated || !fontsLoaded) return <SafeAreaProvider initialMetrics={initialWindowMetrics}><SafeAreaView style={styles.loading}><Image source={require("./assets/enter_logo.png")} style={styles.logoImage} resizeMode="contain" accessibilityLabel="Enter" /></SafeAreaView></SafeAreaProvider>;
  if (profiles.length === 0 || showAuth) return <SafeAreaProvider initialMetrics={initialWindowMetrics}><AuthScreen onAuthenticated={addProfile} onCancel={profiles.length ? () => setShowAuth(false) : undefined} /></SafeAreaProvider>;

  return <SafeAreaProvider initialMetrics={initialWindowMetrics}><SafeAreaView style={styles.app} edges={["top", "bottom", "left", "right"]}><StatusBar style="light" />
    <Animated.View style={{ flex: 1, transform: [{ translateX: screenMotion.interpolate({ inputRange: [0, 1], outputRange: [screenDirection * viewportWidth, 0] }) }] }}>{screen === "settings" ? <SettingsScreen onClose={() => setScreen("inbox")} /> : screen === "chat" && activeConversation ? <ChatScreen conversation={activeConversation} messages={messages} error={messageError} replyTo={replyTo} editingMessage={editingMessage} onBack={() => { setScreen("inbox"); setActiveConversationId(null); }} onSend={sendMessage} onReply={(message) => { setEditingMessage(null); setReplyTo(message); }} onEdit={applyMessageEdit} onPin={(message) => updateActiveMessage(message.id, (current) => ({ ...current, pinned: !current.pinned }))} onSave={saveMessage} onDelete={(message) => updateActiveMessage(message.id, () => null)} onReact={(message, reaction) => updateActiveMessage(message.id, (current) => ({ ...current, reaction: current.reaction === reaction ? undefined : reaction }))} onForward={setForwardMessage} onCancelContext={() => { setReplyTo(null); setEditingMessage(null); }} /> : <ConversationList profile={activeProfile} syncConnected={syncConnected} conversations={conversationsWithPreviews} activeFolder={activeProfileId ? activeFolderByProfile[activeProfileId] ?? ALL_FOLDER : ALL_FOLDER} activeId={activeConversationId} query={query} searchUser={searchUserResult} searchBusy={searchBusy} searchError={searchError} onQueryChange={setQuery} onSelect={openConversation} onProfilePress={() => setShowProfiles(true)} onOpenSearchUser={openSearchUser} onAction={conversationAction} onSelectFolder={selectFolder} />}</Animated.View>
    {screen !== "chat" && <BottomNav screen={screen} onInbox={() => setScreen("inbox")} onSettings={() => setScreen("settings")} />}
    <ProfileSheet visible={showProfiles} profiles={profiles} activeProfile={activeProfile} onClose={() => setShowProfiles(false)} onSelect={selectProfile} onAdd={() => setShowAuth(true)} onRemove={removeProfile} />
    <ForwardSheet visible={Boolean(forwardMessage)} message={forwardMessage} conversations={conversations} currentId={activeConversationId} onClose={() => setForwardMessage(null)} onForward={(id) => forwardMessage && sendForwardedMessage(forwardMessage, id)} />
  </SafeAreaView></SafeAreaProvider>;
}

function BottomNav({ screen, onInbox, onSettings }: { screen: Screen; onInbox: () => void; onSettings: () => void }) {
  return <View style={styles.bottomNav}><NavButton active={screen === "inbox"} icon="chat" label="Чаты" onPress={onInbox} /><NavButton active={screen === "settings"} icon="settings" label="Настройки" onPress={onSettings} /></View>;
}

function NavButton({ active, icon, label, onPress }: { active: boolean; icon: "chat" | "settings"; label: string; onPress: () => void }) {
  return <Pressable onPress={onPress} style={({ pressed }) => [styles.navButton, active && styles.navActive, pressed && styles.pressed]}><Icon name={icon} size={20} color={active ? colors.foreground : colors.muted} /><Text style={[styles.navLabel, active && styles.navLabelActive]}>{label}</Text></Pressable>;
}

const styles = StyleSheet.create({
  app: { flex: 1, backgroundColor: colors.background },
  loading: { flex: 1, backgroundColor: colors.background, alignItems: "center", justifyContent: "center" },
  logoImage: { width: 140, height: 28 },
  bottomNav: { minHeight: 68, marginHorizontal: 12, marginBottom: 8, borderRadius: 24, borderWidth: 1, borderColor: colors.border, paddingHorizontal: 8, paddingBottom: 7, paddingTop: 7, flexDirection: "row", gap: 8, backgroundColor: colors.surface, shadowColor: "#000000", shadowOpacity: 0.28, shadowRadius: 14, shadowOffset: { width: 0, height: 6 }, elevation: 8 },
  navButton: { flex: 1, borderRadius: 18, alignItems: "center", justifyContent: "center", gap: 3 },
  navActive: { backgroundColor: colors.accent },
  navLabel: { color: colors.muted, fontFamily: fonts.bodySemibold, fontSize: 11 },
  navLabelActive: { color: colors.foreground },
  pressed: { opacity: 0.72 },
});
