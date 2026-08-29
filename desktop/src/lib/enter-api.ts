import { formatMessageTime } from "./utils";
import { ENTER_PROTOCOL_VERSION, formatEnterAddress, parseEnterAddress, type EncryptedMessage } from "./enter-protocol";
import { isManagedDeviceResponse, type ManagedDeviceResponse } from "./enter-api-contract";
import { normalizeServerAddress } from "./server-address";
import { logEvent } from "./logs";
import type { DeviceKeyBundle, PublicAccountKey, PublicDeviceKey } from "./e2e";
import { isChatFolder, type ChatFolder } from "./folders";
import type { Conversation, Message, Profile } from "../types";

const REQUEST_TIMEOUT_MS = 10_000;
const MAX_MEDIA_CIPHERTEXT_BYTES = 200 * 1024 * 1024 + 16;
const MAX_ENCRYPTED_MESSAGE_CIPHERTEXT_LENGTH = 2_000_000;
const MAX_SYNC_ITEMS = 1_000;
const MAX_FOLDERS = 100;

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

export type RemoteReadReceipt = {
  messageId: string;
  readAt: number;
};

export type RemoteDeliveryReceipt = {
  messageId: string;
  deliveredAt: number;
};

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

type SendMessageResponse = {
  nextCursor: number;
  message: RemoteMessage;
};

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

export type ManagedDevice = ManagedDeviceResponse;

export { isManagedDeviceResponse } from "./enter-api-contract";

export type ManagedSession = {
  id: string;
  deviceId?: string | null;
  platform: string;
  deviceName?: string | null;
  appVersion?: string | null;
  createdAt: number;
  expiresAt: number;
  lastSeenAt?: number | null;
  current: boolean;
};

export type ClientDeviceMetadata = {
  platform: string;
  deviceName: string;
  appVersion: string;
};

export function clientDeviceMetadata(): ClientDeviceMetadata {
  const userAgent = navigator.userAgent;
  const browser = userAgent.includes("Edg/") ? "Edge" : userAgent.includes("Chrome/") ? "Chrome" : userAgent.includes("Firefox/") ? "Firefox" : userAgent.includes("Safari/") ? "Safari" : "Browser";
  const platform = navigator.platform || "desktop";
  return { platform: "web", deviceName: `${browser} · ${platform}`.slice(0, 128), appVersion: "0.2.2" };
}

type PublicKeyDirectoryResponse = {
  id: string;
  handle: string;
  name: string;
  server: string;
  serverId?: string;
  devices: DeviceKeyBundle[];
  accountKey?: { keyId: string; encryptionPublicKey: string };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isString(value: unknown, maxLength = 4096): value is string {
  return typeof value === "string" && value.length <= maxLength;
}

function isDeviceKeyBundle(value: unknown): value is DeviceKeyBundle {
  if (!isRecord(value)) return false;
  return isString(value.deviceId, 256)
    && isString(value.keyId, 256)
    && isString(value.encryptionPublicKey, 16_384)
    && isString(value.signingPublicKey, 16_384)
    && typeof value.createdAt === "number"
    && Number.isFinite(value.createdAt);
}

function isEncryptedMessage(value: unknown): value is EncryptedMessage {
  if (!isRecord(value) || value.protocol !== ENTER_PROTOCOL_VERSION) return false;
  return ["message_id", "conversation_id", "sender", "recipient", "sender_device", "key_id", "created_at", "nonce", "ephemeral_public_key", "ciphertext", "associated_data", "signature"]
    .every((key) => isString(value[key], key === "ciphertext" ? MAX_ENCRYPTED_MESSAGE_CIPHERTEXT_LENGTH : 4096));
}

function isRemoteConversation(value: unknown): value is RemoteConversation {
  return isRecord(value)
    && isString(value.id, 256)
    && (value.serverId === undefined || isString(value.serverId, 256))
    && isString(value.name, 256)
    && (value.handle === undefined || value.handle === null || isString(value.handle, 512))
    && isString(value.avatar, 2048)
    && (value.subtitle === undefined || value.subtitle === null || isString(value.subtitle, 512))
    && typeof value.canWrite === "boolean"
    && isString(value.lastMessage, 2_000_000)
    && (value.lastMessageAt === undefined || value.lastMessageAt === null || typeof value.lastMessageAt === "number")
    && typeof value.pinned === "boolean"
    && typeof value.online === "boolean"
    && (value.lastSeenAt === undefined || value.lastSeenAt === null || typeof value.lastSeenAt === "number")
    && typeof value.unread === "number"
    && Number.isFinite(value.unread)
    && value.unread >= 0;
}

function isRemoteMessage(value: unknown): value is RemoteMessage {
  return isRecord(value)
    && isString(value.id, 256)
    && isString(value.conversationId, 256)
    && (value.author === "me" || value.author === "them")
    && typeof value.createdAt === "number"
    && Number.isFinite(value.createdAt)
    && isString(value.stackId, 256)
    && isEncryptedMessage(value.encryptedMessage);
}

function isReceipt(value: unknown, field: "readAt" | "deliveredAt") {
  return isRecord(value)
    && isString(value.messageId, 256)
    && typeof value[field] === "number"
    && Number.isFinite(value[field]);
}

function isFolderList(value: unknown): value is ChatFolder[] {
  return Array.isArray(value) && value.length <= MAX_FOLDERS && value.every(isChatFolder);
}

function isSyncResponse(value: unknown): value is SyncResponse {
  return isRecord(value)
    && typeof value.nextCursor === "number"
    && Number.isFinite(value.nextCursor)
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

function isRealtimeEvent(value: unknown): value is RealtimeEvent {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  if (value.type === "ready") return typeof value.version === "number" && Number.isFinite(value.version);
  if (value.type === "sync") return isSyncResponse(value);
  if (value.type === "message") return typeof value.cursor === "number" && value.cursor >= 0 && isRemoteMessage(value.message);
  if (value.type === "readReceipt") return typeof value.cursor === "number" && value.cursor >= 0 && isReceipt(value, "readAt");
  if (value.type === "deliveryReceipt") return typeof value.cursor === "number" && value.cursor >= 0 && isReceipt(value, "deliveredAt");
  if (value.type === "presence") return isString(value.conversationId, 256) && typeof value.online === "boolean" && typeof value.lastSeenAt === "number" && Number.isFinite(value.lastSeenAt);
  if (value.type === "folders") return isFolderList(value.folders);
  if (value.type === "pong") return true;
  return value.type === "error" && isString(value.code, 128);
}

function isAcceptedResponse(value: unknown): value is { accepted: boolean } {
  return isRecord(value) && typeof value.accepted === "boolean";
}

function isAcceptedTrueResponse(value: unknown): value is { accepted: true } {
  return isRecord(value) && value.accepted === true;
}

function isNonNegativeTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]) {
  return Object.keys(value).every((key) => keys.includes(key));
}

function isAccountSettings(value: unknown): value is AccountSettings {
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

function isBlockedAccount(value: unknown): value is BlockedAccount {
  return isRecord(value)
    && hasOnlyKeys(value, ["id", "address", "handle", "name", "server", "createdAt"])
    && isString(value.id, 256)
    && isString(value.address, 2048)
    && isString(value.handle, 256)
    && isString(value.name, 256)
    && isString(value.server, 2048)
    && isNonNegativeTimestamp(value.createdAt);
}

function isBlockedAccountList(value: unknown): value is BlockedAccount[] {
  return Array.isArray(value) && value.length <= 10_000 && value.every(isBlockedAccount);
}

function isManagedSession(value: unknown): value is ManagedSession {
  return isRecord(value)
    && hasOnlyKeys(value, ["id", "deviceId", "platform", "deviceName", "appVersion", "createdAt", "expiresAt", "lastSeenAt", "current"])
    && isString(value.id, 256)
    && (value.deviceId === undefined || value.deviceId === null || isString(value.deviceId, 256))
    && isString(value.platform, 64)
    && (value.deviceName === undefined || value.deviceName === null || isString(value.deviceName, 256))
    && (value.appVersion === undefined || value.appVersion === null || isString(value.appVersion, 128))
    && isNonNegativeTimestamp(value.createdAt)
    && isNonNegativeTimestamp(value.expiresAt)
    && value.expiresAt >= value.createdAt
    && (value.lastSeenAt === undefined || value.lastSeenAt === null || isNonNegativeTimestamp(value.lastSeenAt))
    && typeof value.current === "boolean";
}

function isDevicesResponse(value: unknown): value is ManagedDevice[] {
  return Array.isArray(value) && value.length <= 256 && value.every(isManagedDeviceResponse);
}

function isSessionsResponse(value: unknown): value is ManagedSession[] {
  return Array.isArray(value) && value.length <= 256 && value.every(isManagedSession);
}

function isTimestampResponse(value: unknown, field: "readAt" | "deliveredAt"): value is Record<string, number> {
  return isRecord(value) && typeof value[field] === "number" && Number.isFinite(value[field]);
}

function isDeviceHistoryResponse(value: unknown): value is { accepted: number; nextCursor: number } {
  return isRecord(value)
    && typeof value.accepted === "number"
    && Number.isFinite(value.accepted)
    && value.accepted >= 0
    && typeof value.nextCursor === "number"
    && Number.isFinite(value.nextCursor)
    && value.nextCursor >= 0;
}

function validateDirectory(value: unknown, expected?: { handle: string; server: string }): PublicKeyDirectoryResponse {
  if (!isRecord(value)) throw new Error("Некорректный ответ каталога ключей");
  const handle = typeof value.handle === "string" ? value.handle.trim().replace(/^@+/, "").toLowerCase() : "";
  const server = typeof value.server === "string" && value.server.trim() ? normalizeServerAddress(value.server) : expected?.server ?? null;
  const devices = Array.isArray(value.devices) ? value.devices : null;
  if (!isString(value.id, 256) || !isString(value.name, 256) || !handle || !server || !devices || devices.length > 256 || !devices.every(isDeviceKeyBundle)) {
    throw new Error("Некорректный ответ каталога ключей");
  }
  if (expected && (handle !== expected.handle || server !== expected.server)) {
    throw new Error("Ответ каталога не соответствует запрошенному адресу");
  }
  const accountKey = value.accountKey;
  if (accountKey !== undefined && (!isRecord(accountKey) || typeof accountKey.keyId !== "string" || typeof accountKey.encryptionPublicKey !== "string")) {
    throw new Error("Некорректный ключ аккаунта в каталоге");
  }
  return {
    id: value.id,
    handle,
    name: value.name,
    server,
    serverId: typeof value.serverId === "string" ? value.serverId : undefined,
    devices,
    accountKey: accountKey as PublicKeyDirectoryResponse["accountKey"],
  };
}

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

function apiUrl(profile: Profile, path: string) {
  return `${profile.server.replace(/\/+$/, "")}${path}`;
}

function headers(profile: Profile) {
  return {
    authorization: `Bearer ${profile.token}`,
    "content-type": "application/json",
  };
}

async function request(input: RequestInfo | URL, init?: RequestInit) {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const externalSignal = init?.signal;
  const abort = () => controller.abort(externalSignal?.reason);
  const requestUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  const path = (() => { try { return new URL(requestUrl, window.location.origin).pathname; } catch { return "request"; } })();
  const method = init?.method ?? "GET";
  if (externalSignal?.aborted) abort();
  else externalSignal?.addEventListener("abort", abort, { once: true });
  try {
    const response = await fetch(input, { ...init, signal: controller.signal });
    logEvent("network", `${method} ${path}`, `HTTP ${response.status}`, response.ok ? "info" : "warn");
    return response;
  } catch (reason) {
    logEvent("network", `${method} ${path}`, reason instanceof Error ? reason.message : "Network request failed", "error");
    throw reason;
  } finally {
    window.clearTimeout(timeout);
    externalSignal?.removeEventListener("abort", abort);
  }
}

async function readJson<T>(response: Response, validate?: (value: unknown) => value is T): Promise<T> {
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { error?: unknown } | null;
    const detail = payload && typeof payload.error === "string" ? `: ${payload.error}` : "";
    throw new Error(`Enter API request failed: ${response.status}${detail}`);
  }
  const payload: unknown = await response.json().catch(() => undefined);
  if (validate && !validate(payload)) throw new Error("Enter API вернул некорректный ответ");
  return payload as T;
}

async function fetchDirectory(profile: Profile, rawAddress: string) {
  const address = parseEnterAddress(rawAddress, profile.server);
  if (!address) throw new Error("Некорректный Enter-адрес");
  const response = await request(`${address.server}/enter/v1/keys/${encodeURIComponent(address.handle)}`);
  const directory = validateDirectory(await readJson<unknown>(response), address);
  return { address, directory };
}

export async function syncProfile(profile: Profile, since: number): Promise<SyncResponse> {
  logEvent("sync", "Sync request", `cursor ${Math.max(0, since)}`);
  const response = await request(`${apiUrl(profile, "/api/v1/sync")}?since=${Math.max(0, since)}`, {
    headers: headers(profile),
  });
  const result = await readJson<SyncResponse>(response, isSyncResponse);
  logEvent("sync", "Sync completed", `messages ${result.messages.length}, chats ${result.conversations.length}, cursor ${result.nextCursor}`, "success");
  return result;
}

export async function updateAccountFolders(profile: Profile, folders: ChatFolder[]): Promise<ChatFolder[]> {
  const response = await request(apiUrl(profile, "/api/v1/account/folders"), {
    method: "PUT",
    headers: headers(profile),
    body: JSON.stringify(folders),
  });
  return readJson<ChatFolder[]>(response, isFolderList);
}

export type RealtimeClose = { code: number; reason: string; wasClean: boolean };

export function openRealtime(profile: Profile, since: number, onEvent: (event: RealtimeEvent) => void, onClose: (details: RealtimeClose) => void) {
  const websocket = new WebSocket(`${profile.server.replace(/^http/, "ws").replace(/\/+$/, "")}/api/v1/realtime`);
  websocket.onopen = () => websocket.send(JSON.stringify({ type: "hello", version: 1, token: profile.token, since: Math.max(0, since) }));
  websocket.onmessage = (event) => {
    try {
      const value: unknown = JSON.parse(String(event.data));
      if (isRealtimeEvent(value)) onEvent(value);
    } catch {
      // Ignore malformed frames; the next snapshot repairs state.
    }
  };
  websocket.onclose = (event) => onClose({ code: event.code, reason: event.reason, wasClean: event.wasClean });
  return websocket;
}

export async function getAccountSettings(profile: Profile): Promise<AccountSettings> {
  const response = await request(apiUrl(profile, "/api/v1/account/settings"), { headers: headers(profile) });
  return readJson<AccountSettings>(response, isAccountSettings);
}

export async function updateAccountSettings(profile: Profile, patch: AccountSettingsPatch): Promise<AccountSettings> {
  const response = await request(apiUrl(profile, "/api/v1/account/settings"), {
    method: "PATCH",
    headers: headers(profile),
    body: JSON.stringify(patch),
  });
  return readJson<AccountSettings>(response, isAccountSettings);
}

export async function getBlacklist(profile: Profile): Promise<BlockedAccount[]> {
  const response = await request(apiUrl(profile, "/api/v1/account/blacklist"), { headers: headers(profile) });
  return readJson<BlockedAccount[]>(response, isBlockedAccountList);
}

export async function blockAccount(profile: Profile, address: string): Promise<BlockedAccount> {
  const response = await request(apiUrl(profile, "/api/v1/account/blacklist"), {
    method: "POST",
    headers: headers(profile),
    body: JSON.stringify({ address }),
  });
  return readJson<BlockedAccount>(response, isBlockedAccount);
}

export async function unblockAccount(profile: Profile, id: string) {
  const response = await request(apiUrl(profile, `/api/v1/account/blacklist/${encodeURIComponent(id)}`), {
    method: "DELETE",
    headers: headers(profile),
  });
  await readJson<{ accepted: true }>(response, isAcceptedTrueResponse);
}

export async function deleteAccount(profile: Profile) {
  const response = await request(apiUrl(profile, "/api/v1/account"), {
    method: "DELETE",
    headers: headers(profile),
  });
  await readJson<{ accepted: true }>(response, isAcceptedTrueResponse);
}

export async function changePassword(profile: Profile, currentPassword: string, newPassword: string) {
  const response = await request(apiUrl(profile, "/auth/change-password"), {
    method: "POST",
    headers: headers(profile),
    body: JSON.stringify({ currentPassword, newPassword }),
  });
  await readJson<{ accepted: true }>(response, isAcceptedTrueResponse);
}

export async function getDevices(profile: Profile): Promise<ManagedDevice[]> {
  const response = await request(apiUrl(profile, "/api/v1/devices"), { headers: headers(profile) });
  return readJson<ManagedDevice[]>(response, isDevicesResponse);
}

export async function revokeDevice(profile: Profile, deviceId: string) {
  const response = await request(apiUrl(profile, `/api/v1/devices/${encodeURIComponent(deviceId)}`), {
    method: "DELETE",
    headers: headers(profile),
  });
  await readJson<{ accepted: true }>(response, isAcceptedTrueResponse);
}

export async function getSessions(profile: Profile): Promise<ManagedSession[]> {
  const response = await request(apiUrl(profile, "/api/v1/sessions"), { headers: headers(profile) });
  return readJson<ManagedSession[]>(response, isSessionsResponse);
}

export async function refreshSessionMetadata(profile: Profile) {
  const response = await request(apiUrl(profile, "/api/v1/sessions/current"), {
    method: "PATCH",
    headers: headers(profile),
    body: JSON.stringify(clientDeviceMetadata()),
  });
  await readJson<{ accepted: true }>(response, isAcceptedTrueResponse);
}

export async function revokeSession(profile: Profile, sessionId: string) {
  const response = await request(apiUrl(profile, `/api/v1/sessions/${encodeURIComponent(sessionId)}`), {
    method: "DELETE",
    headers: headers(profile),
  });
  await readJson<{ accepted: true }>(response, isAcceptedTrueResponse);
}

export async function revokeOtherSessions(profile: Profile) {
  const response = await request(apiUrl(profile, "/api/v1/sessions/revoke-others"), {
    method: "POST",
    headers: headers(profile),
  });
  await readJson<{ accepted: true }>(response, isAcceptedTrueResponse);
}

export async function markConversationRead(profile: Profile, conversationId: string) {
  const response = await request(apiUrl(profile, `/api/v1/conversations/${encodeURIComponent(conversationId)}/read`), {
    method: "POST",
    headers: headers(profile),
  });
  return readJson<{ readAt: number }>(response, (value): value is { readAt: number } => isTimestampResponse(value, "readAt"));
}

export async function acknowledgeMessage(profile: Profile, messageId: string) {
  const response = await request(apiUrl(profile, `/api/v1/messages/${encodeURIComponent(messageId)}/delivered`), {
    method: "POST",
    headers: headers(profile),
  });
  return readJson<{ deliveredAt: number }>(response, (value): value is { deliveredAt: number } => isTimestampResponse(value, "deliveredAt"));
}

export async function registerDeviceKey(profile: Profile, bundle: DeviceKeyBundle, accountKey?: { keyId: string; encryptionPublicKey: string }) {
  const response = await request(apiUrl(profile, "/enter/v1/keys"), {
    method: "POST",
    headers: headers(profile),
    body: JSON.stringify({ ...bundle, ...clientDeviceMetadata(), accountKeyId: accountKey?.keyId, accountEncryptionPublicKey: accountKey?.encryptionPublicKey }),
  });
  await readJson<{ accepted: boolean }>(response, isAcceptedResponse);
}

export async function fetchPublicDeviceKeys(profile: Profile, rawAddress: string): Promise<PublicDeviceKey[]> {
  const { address, directory } = await fetchDirectory(profile, rawAddress);
  const recipientAddress = formatEnterAddress(address);
  return directory.devices.map((device) => ({ ...device, address: recipientAddress }));
}

export async function fetchPublicAccountKey(profile: Profile, rawAddress: string): Promise<PublicAccountKey | undefined> {
  const { address, directory } = await fetchDirectory(profile, rawAddress);
  if (!directory.accountKey) return undefined;
  return {
    ...directory.accountKey,
    address: formatEnterAddress(address),
  };
}

export async function searchUser(profile: Profile, rawQuery: string): Promise<SearchUser> {
  const raw = rawQuery.trim();
  const address = raw.startsWith("@") || raw.includes("@") ? parseEnterAddress(raw, profile.server) : null;
  const query = raw.replace(/^@+/, "");
  if (!address && (!query || query.includes("@"))) throw new Error("Введите username или @username@server");
  const response = address
    ? await request(`${address.server}/enter/v1/keys/${encodeURIComponent(address.handle)}`)
    : await request(`${apiUrl(profile, "/enter/v1/keys/search")}?q=${encodeURIComponent(query)}`);
  const directory = validateDirectory(await readJson<unknown>(response), address ?? undefined);
  const server = directory.server;
  return {
    id: directory.id,
    address: formatEnterAddress({ handle: directory.handle, server }),
    handle: directory.handle,
    name: directory.name,
    server,
    serverId: directory.serverId,
    avatar: directory.handle,
    deviceCount: directory.devices.length,
  };
}

export async function createConversation(profile: Profile, user: SearchUser): Promise<RemoteConversation> {
  const response = await request(apiUrl(profile, "/api/v1/conversations"), {
    method: "POST",
    headers: headers(profile),
    body: JSON.stringify({
      peerAddress: user.address,
      name: user.name,
      avatar: user.avatar,
      subtitle: user.address,
    }),
  });
  return readJson<RemoteConversation>(response, isRemoteConversation);
}

export async function sendMessage(profile: Profile, conversationId: string, message: Message, encryptedMessages: EncryptedMessage[]): Promise<SendMessageResponse> {
  logEvent("send", "Sending message", `recipients ${encryptedMessages.length}${message.attachments?.length ? `, attachments ${message.attachments.length}` : ""}`);
  const response = await request(apiUrl(profile, "/api/v1/messages"), {
    method: "POST",
    headers: headers(profile),
    body: JSON.stringify({
      conversationId,
      clientMessageId: message.id,
      encryptedMessages,
    }),
  });
  const result = await readJson<SendMessageResponse>(response, (value): value is SendMessageResponse => isRecord(value)
    && typeof value.nextCursor === "number"
    && Number.isFinite(value.nextCursor)
    && value.nextCursor >= 0
    && isRemoteMessage(value.message));
  logEvent("send", "Message accepted by server", `cursor ${result.nextCursor}`, "success");
  return result;
}

export function uploadMedia(profile: Profile, conversationId: string, mediaId: string, recipient: string, ciphertext: Uint8Array, onProgress?: (progress: number) => void, signal?: AbortSignal) {
  if (ciphertext.byteLength === 0 || ciphertext.byteLength > MAX_MEDIA_CIPHERTEXT_BYTES) {
    return Promise.reject(new Error("Вложение превышает допустимый размер"));
  }
  logEvent("media", "Attachment upload started", `size ${ciphertext.byteLength} bytes`);
  return new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const abort = () => xhr.abort();
    const cleanup = () => signal?.removeEventListener("abort", abort);
    if (signal?.aborted) {
      reject(new DOMException("Загрузка вложения отменена", "AbortError"));
      return;
    }
    signal?.addEventListener("abort", abort, { once: true });
    xhr.open("POST", apiUrl(profile, "/api/v1/media"));
    xhr.timeout = REQUEST_TIMEOUT_MS;
    xhr.setRequestHeader("authorization", `Bearer ${profile.token}`);
    xhr.setRequestHeader("content-type", "application/octet-stream");
    xhr.setRequestHeader("x-enter-media-id", mediaId);
    xhr.setRequestHeader("x-enter-conversation-id", conversationId);
    xhr.setRequestHeader("x-enter-recipient", recipient);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress?.(Math.round((event.loaded / event.total) * 100));
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) { cleanup(); logEvent("media", "Attachment uploaded", `size ${ciphertext.byteLength} bytes`, "success"); resolve(); }
      else {
        let detail = "";
        try {
          const payload = JSON.parse(xhr.responseText) as { error?: unknown };
          if (typeof payload.error === "string") detail = `: ${payload.error}`;
        } catch { /* Keep the HTTP status. */ }
        cleanup();
        const error = new Error(`Enter media request failed: ${xhr.status}${detail}`);
        logEvent("media", "Attachment upload failed", error.message, "error");
        reject(error);
      }
    };
    xhr.onerror = () => { cleanup(); logEvent("media", "Attachment upload failed", "Network error", "error"); reject(new Error("Не удалось загрузить вложение")); };
    xhr.onabort = () => { cleanup(); logEvent("media", "Attachment upload canceled", undefined, "warn"); reject(new DOMException("Загрузка вложения отменена", "AbortError")); };
    xhr.ontimeout = () => { cleanup(); logEvent("media", "Attachment upload timed out", undefined, "error"); reject(new Error("Загрузка вложения превысила тайм-аут")); };
    xhr.send(ciphertext.buffer.slice(ciphertext.byteOffset, ciphertext.byteOffset + ciphertext.byteLength) as ArrayBuffer);
  });
}

export async function downloadMedia(profile: Profile, mediaId: string, signal?: AbortSignal) {
  const response = await request(apiUrl(profile, `/api/v1/media/${encodeURIComponent(mediaId)}`), { headers: { authorization: `Bearer ${profile.token}` }, signal });
  if (!response.ok) throw new Error(`Enter media request failed: ${response.status}`);
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_MEDIA_CIPHERTEXT_BYTES) throw new Error("Вложение превышает допустимый размер");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_MEDIA_CIPHERTEXT_BYTES) throw new Error("Вложение имеет некорректный размер");
  return bytes;
}

export async function syncDeviceHistory(profile: Profile, entries: DeviceHistoryEntry[]) {
  if (entries.length === 0) return;
  const response = await request(apiUrl(profile, "/api/v1/device-history"), {
    method: "POST",
    headers: headers(profile),
    body: JSON.stringify({ entries }),
  });
  return readJson<{ accepted: number; nextCursor: number }>(response, isDeviceHistoryResponse);
}

export function mapRemoteConversation(remote: RemoteConversation): Conversation {
  return {
    id: remote.id,
    serverId: remote.serverId,
    name: remote.name,
    handle: remote.handle ?? undefined,
    avatar: remote.avatar,
    subtitle: remote.subtitle ?? undefined,
    canWrite: remote.canWrite,
    lastMessage: remote.lastMessage,
    time: remote.lastMessageAt ? formatMessageTime(new Date(remote.lastMessageAt)) : "",
    pinned: remote.pinned,
    online: remote.online,
    lastSeenAt: remote.lastSeenAt ?? undefined,
    unread: remote.unread ?? 0,
  };
}

export function mapRemoteMessage(remote: RemoteMessage): Message {
  return {
    id: remote.encryptedMessage.message_id,
    author: remote.author,
    text: "",
    time: formatMessageTime(new Date(remote.createdAt)),
    stackId: remote.stackId,
    encryptedMessage: remote.encryptedMessage,
  };
}
