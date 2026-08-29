import { Platform } from "react-native";
import { ENTER_PROTOCOL_VERSION, type EncryptedMessage } from "./protocol";
import { formatEnterAddress, parseEnterAddress } from "./rn-address";
import { messageTime as formatMessageTime } from "./data";
import type { DeviceKeyBundle, PublicAccountKey, PublicDeviceKey } from "./rn-e2e";
import type { Conversation, Message, Profile, SearchUser } from "./types";
import { isChatFolder, type ChatFolder } from "./folders";
import { MAX_MEDIA_BYTES } from "./media";
import { logEvent } from "./logs";

const REQUEST_TIMEOUT_MS = 10_000;
const MAX_MEDIA_CIPHERTEXT_BYTES = MAX_MEDIA_BYTES + 16;
const MAX_ENCRYPTED_MESSAGE_CIPHERTEXT_LENGTH = 2_000_000;
const MAX_SYNC_ITEMS = 1_000;
const MAX_FOLDERS = 100;

function isLoopbackServer(server: string) {
  try {
    const hostname = new URL(server).hostname.toLowerCase().replace(/^\[|\]$/g, "");
    return hostname === "localhost" || hostname === "::1" || hostname === "0.0.0.0" || hostname.startsWith("127.");
  } catch {
    return false;
  }
}

const allowLoopbackDirectoryRewrite = typeof globalThis !== "undefined"
  && Boolean((globalThis as typeof globalThis & { __DEV__?: unknown }).__DEV__);

export function resolveDirectoryServer(server: string, fallback: string, allowRewrite = allowLoopbackDirectoryRewrite) {
  return allowRewrite && isLoopbackServer(server) ? fallback : server;
}

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

export type RemoteReadReceipt = { messageId: string; readAt: number };
export type RemoteDeliveryReceipt = { messageId: string; deliveredAt: number };
export type SyncResponse = { nextCursor: number; conversations: RemoteConversation[]; folders?: ChatFolder[]; messages: RemoteMessage[]; readReceipts: RemoteReadReceipt[]; deliveryReceipts: RemoteDeliveryReceipt[] };

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
export type DeviceHistoryEntry = { conversationId: string; messageId: string; sourceKeyId?: string; encryptedMessage: EncryptedMessage };

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

export type ChangePasswordPayload = {
  currentPassword: string;
  newPassword: string;
};

export type AccountDevice = {
  deviceId: string;
  platform: string;
  name: string | null;
  appVersion: string | null;
  createdAt: number;
  lastSeenAt: number | null;
  revokedAt: number | null;
};

export type AccountSession = {
  id: string;
  deviceId: string | null;
  platform: string;
  deviceName: string | null;
  appVersion: string | null;
  createdAt: number;
  expiresAt: number;
  lastSeenAt: number | null;
  current: boolean;
};

export type ClientDeviceMetadata = {
  platform: string;
  deviceName: string;
  appVersion: string;
};

export function clientDeviceMetadata(): ClientDeviceMetadata {
  const version = Platform.Version === undefined ? "" : ` ${String(Platform.Version)}`;
  const platform = Platform.OS === "ios"
    ? `iOS${version}`
    : Platform.OS === "android"
      ? `Android${version}`
      : `${Platform.OS}${version}`;
  const deviceName = Platform.OS === "ios" ? "iOS device" : Platform.OS === "android" ? "Android device" : "Mobile device";
  return { platform: platform.slice(0, 32), deviceName, appVersion: "0.2.1" };
}

type PublicKeyDirectoryResponse = { id: string; handle: string; name: string; server: string; serverId?: string; devices: DeviceKeyBundle[]; accountKey?: { keyId: string; encryptionPublicKey: string } | null };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isString(value: unknown, maxLength = 4096): value is string {
  return typeof value === "string" && value.length <= maxLength;
}

function isIdentifier(value: unknown, maxLength = 128): value is string {
  return isString(value, maxLength) && value.length > 0 && !/[\u0000-\u001f\u007f]/.test(value);
}

function isUnixMillis(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isEncryptedMessage(value: unknown): value is EncryptedMessage {
  if (!isRecord(value) || value.protocol !== ENTER_PROTOCOL_VERSION) return false;
  return ["message_id", "conversation_id", "sender", "recipient", "sender_device", "key_id", "created_at", "nonce", "ephemeral_public_key", "ciphertext", "associated_data", "signature"]
    .every((key) => isString(value[key], key === "ciphertext" ? MAX_ENCRYPTED_MESSAGE_CIPHERTEXT_LENGTH : 4096));
}

function isDeviceBundle(value: unknown): value is DeviceKeyBundle {
  return isRecord(value)
    && isString(value.deviceId, 256)
    && isString(value.keyId, 256)
    && isString(value.encryptionPublicKey, 16_384)
    && isString(value.signingPublicKey, 16_384)
    && isNumber(value.createdAt);
}

function isDirectoryResponse(value: unknown): value is PublicKeyDirectoryResponse {
  if (!isRecord(value) || !isString(value.id, 256) || !isString(value.handle, 128) || !isString(value.name, 256) || !isString(value.server, 2048) || !Array.isArray(value.devices) || value.devices.length > 256 || !value.devices.every(isDeviceBundle)) return false;
  return (value.serverId === undefined || isString(value.serverId, 256))
    && (value.accountKey === undefined || value.accountKey === null || (isRecord(value.accountKey) && isString(value.accountKey.keyId, 256) && isString(value.accountKey.encryptionPublicKey, 16_384)));
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
    && (value.lastMessageAt === undefined || value.lastMessageAt === null || isNumber(value.lastMessageAt))
    && typeof value.pinned === "boolean"
    && typeof value.online === "boolean"
    && (value.lastSeenAt === undefined || value.lastSeenAt === null || isNumber(value.lastSeenAt))
    && isNumber(value.unread)
    && value.unread >= 0;
}

function isRemoteMessage(value: unknown): value is RemoteMessage {
  return isRecord(value)
    && isString(value.id, 256)
    && isString(value.conversationId, 256)
    && (value.author === "me" || value.author === "them")
    && isNumber(value.createdAt)
    && isString(value.stackId, 256)
    && isEncryptedMessage(value.encryptedMessage);
}

function isReceipt(value: unknown, field: "readAt" | "deliveredAt"): boolean {
  return isRecord(value) && isString(value.messageId, 256) && isNumber(value[field]);
}

function isFolderList(value: unknown): value is ChatFolder[] {
  return Array.isArray(value) && value.length <= MAX_FOLDERS && value.every(isChatFolder);
}

function isSyncResponse(value: unknown): value is SyncResponse {
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

function isAcceptedResponse(value: unknown): value is { accepted: boolean } {
  return isRecord(value) && typeof value.accepted === "boolean";
}

function isNullableString(value: unknown, maxLength = 4096): value is string | null {
  return value === null || isString(value, maxLength);
}

function isAccountSettings(value: unknown): value is AccountSettings {
  return isRecord(value)
    && isIdentifier(value.id)
    && isString(value.name, 160)
    && isIdentifier(value.handle)
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
    && isString(value.id, 256)
    && isString(value.address, 2048)
    && isString(value.handle, 256)
    && isString(value.name, 256)
    && isString(value.server, 2048)
    && isUnixMillis(value.createdAt);
}

function isBlockedAccountList(value: unknown): value is BlockedAccount[] {
  return Array.isArray(value) && value.length <= 10_000 && value.every(isBlockedAccount);
}

function isAccountDevice(value: unknown): value is AccountDevice {
  return isRecord(value)
    && isIdentifier(value.deviceId)
    && isString(value.platform, 64)
    && isNullableString(value.name, 256)
    && isNullableString(value.appVersion, 128)
    && isUnixMillis(value.createdAt)
    && (value.lastSeenAt === null || isUnixMillis(value.lastSeenAt))
    && (value.revokedAt === null || isUnixMillis(value.revokedAt));
}

function isAccountSession(value: unknown): value is AccountSession {
  return isRecord(value)
    && isIdentifier(value.id)
    && (value.deviceId === null || isIdentifier(value.deviceId))
    && isString(value.platform, 64)
    && (value.deviceName === null || isString(value.deviceName, 256))
    && (value.appVersion === null || isString(value.appVersion, 128))
    && isUnixMillis(value.createdAt)
    && isUnixMillis(value.expiresAt)
    && (value.lastSeenAt === null || isUnixMillis(value.lastSeenAt))
    && typeof value.current === "boolean";
}

function isAccountDeviceList(value: unknown): value is AccountDevice[] {
  return Array.isArray(value) && value.length <= MAX_SYNC_ITEMS && value.every(isAccountDevice);
}

function isAccountSessionList(value: unknown): value is AccountSession[] {
  return Array.isArray(value) && value.length <= MAX_SYNC_ITEMS && value.every(isAccountSession);
}

function isRevokedSessionsResponse(value: unknown): value is { revoked: number } {
  return isRecord(value) && isNonNegativeInteger(value.revoked);
}

function resourceId(id: string, label: string) {
  if (!isIdentifier(id)) throw new Error(`Некорректный идентификатор ${label}`);
  return encodeURIComponent(id);
}

function isTimestampResponse(value: unknown, field: "readAt" | "deliveredAt"): value is Record<string, number> {
  return isRecord(value) && isNumber(value[field]);
}

function directoryAddress(directory: PublicKeyDirectoryResponse, expectedHandle: string, server: string) {
  const actualHandle = directory.handle.replace(/^@+/, "").toLowerCase();
  if (!actualHandle || actualHandle !== expectedHandle.replace(/^@+/, "").toLowerCase()) {
    throw new Error("Enter API вернул ключи другого пользователя");
  }
  return formatEnterAddress({ handle: actualHandle, server });
}

function apiUrl(profile: Profile, path: string) {
  return `${profile.server.replace(/\/+$/, "")}${path}`;
}

function headers(profile: Profile) {
  return { authorization: `Bearer ${profile.token}`, "content-type": "application/json" };
}

async function request(input: RequestInfo | URL, init?: RequestInit) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const requestUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  const path = (() => { try { return new URL(requestUrl).pathname; } catch { return "request"; } })();
  const method = init?.method ?? "GET";
  try {
    const response = await fetch(requestUrl, { ...init, signal: controller.signal });
    logEvent("network", `${method} ${path}`, `HTTP ${response.status}`, response.ok ? "info" : "warn");
    return response;
  } catch (reason) {
    logEvent("network", `${method} ${path}`, reason instanceof Error ? reason.message : "Network request failed", "error");
    throw reason;
  } finally {
    clearTimeout(timeout);
  }
}

async function readJson<T>(response: Response, validate: (value: unknown) => value is T): Promise<T> {
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { error?: unknown } | null;
    const detail = payload && typeof payload.error === "string" ? `: ${payload.error}` : "";
    throw new Error(`Enter API request failed: ${response.status}${detail}`);
  }
  const payload: unknown = await response.json().catch(() => undefined);
  if (!validate(payload)) throw new Error("Enter API вернул некорректный ответ");
  return payload;
}

export async function fetchAccountSettings(profile: Profile) {
  const response = await request(apiUrl(profile, "/api/v1/account/settings"), { headers: headers(profile) });
  return readJson<AccountSettings>(response, isAccountSettings);
}

export async function updateAccountSettings(profile: Profile, patch: AccountSettingsPatch) {
  const response = await request(apiUrl(profile, "/api/v1/account/settings"), {
    method: "PATCH",
    headers: headers(profile),
    body: JSON.stringify(patch),
  });
  return readJson<AccountSettings>(response, isAccountSettings);
}

export async function fetchBlacklist(profile: Profile) {
  const response = await request(apiUrl(profile, "/api/v1/account/blacklist"), { headers: headers(profile) });
  return readJson<BlockedAccount[]>(response, isBlockedAccountList);
}

export async function blockAccount(profile: Profile, address: string) {
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
  return readJson<{ accepted: boolean }>(response, isAcceptedResponse);
}

export async function deleteAccount(profile: Profile) {
  const response = await request(apiUrl(profile, "/api/v1/account"), { method: "DELETE", headers: headers(profile) });
  return readJson<{ accepted: boolean }>(response, isAcceptedResponse);
}

export async function changePassword(profile: Profile, payload: ChangePasswordPayload) {
  const response = await request(apiUrl(profile, "/auth/change-password"), {
    method: "POST",
    headers: headers(profile),
    body: JSON.stringify(payload),
  });
  return readJson<{ accepted: boolean }>(response, isAcceptedResponse);
}

export async function fetchDevices(profile: Profile) {
  const response = await request(apiUrl(profile, "/api/v1/devices"), { headers: headers(profile) });
  return readJson<AccountDevice[]>(response, isAccountDeviceList);
}

export async function deleteDevice(profile: Profile, deviceId: string) {
  const response = await request(apiUrl(profile, `/api/v1/devices/${resourceId(deviceId, "устройства")}`), {
    method: "DELETE",
    headers: headers(profile),
  });
  return readJson<{ accepted: boolean }>(response, isAcceptedResponse);
}

export async function fetchSessions(profile: Profile) {
  const response = await request(apiUrl(profile, "/api/v1/sessions"), { headers: headers(profile) });
  return readJson<AccountSession[]>(response, isAccountSessionList);
}

export async function refreshSessionMetadata(profile: Profile) {
  const metadata = clientDeviceMetadata();
  const response = await request(apiUrl(profile, "/api/v1/sessions/current"), {
    method: "PATCH",
    headers: headers(profile),
    body: JSON.stringify(metadata),
  });
  await readJson<{ accepted: boolean }>(response, isAcceptedResponse);
}

export async function deleteSession(profile: Profile, sessionId: string) {
  const response = await request(apiUrl(profile, `/api/v1/sessions/${resourceId(sessionId, "сессии")}`), {
    method: "DELETE",
    headers: headers(profile),
  });
  return readJson<{ accepted: boolean }>(response, isAcceptedResponse);
}

export async function revokeOtherSessions(profile: Profile) {
  const response = await request(apiUrl(profile, "/api/v1/sessions/revoke-others"), {
    method: "POST",
    headers: headers(profile),
  });
  return readJson<{ revoked: number }>(response, isRevokedSessionsResponse);
}

export async function syncProfile(profile: Profile, since: number) {
  logEvent("sync", "Sync request", `cursor ${Math.max(0, since)}`);
  const response = await request(`${apiUrl(profile, "/api/v1/sync")}?since=${Math.max(0, since)}`, { headers: headers(profile) });
  const result = await readJson<SyncResponse>(response, isSyncResponse);
  logEvent("sync", "Sync completed", `messages ${result.messages.length}, chats ${result.conversations.length}, cursor ${result.nextCursor}`, "success");
  return result;
}

export async function updateAccountFolders(profile: Profile, folders: ChatFolder[]) {
  const response = await request(apiUrl(profile, "/api/v1/account/folders"), { method: "PUT", headers: headers(profile), body: JSON.stringify(folders) });
  return readJson<ChatFolder[]>(response, isFolderList);
}

export type RealtimeClose = { code: number; reason: string; wasClean: boolean };

export function openRealtime(profile: Profile, since: number, onEvent: (event: RealtimeEvent) => void, onClose: (details: RealtimeClose) => void) {
  const websocket = new WebSocket(`${profile.server.replace(/^http/, "ws").replace(/\/+$/, "")}/api/v1/realtime`);
  websocket.onopen = () => websocket.send(JSON.stringify({ type: "hello", version: 1, token: profile.token, since: Math.max(0, since) }));
  websocket.onmessage = (event) => {
    try {
      const value = JSON.parse(String(event.data)) as { type?: unknown };
      if (isRealtimeEvent(value)) onEvent(value);
    } catch {
      // Ignore malformed frames; the next snapshot repairs state.
    }
  };
  websocket.onclose = (event) => onClose({ code: event.code ?? 1000, reason: event.reason ?? "", wasClean: "wasClean" in event ? Boolean(event.wasClean) : false });
  return websocket;
}

export async function markConversationRead(profile: Profile, conversationId: string) {
  const response = await request(apiUrl(profile, `/api/v1/conversations/${encodeURIComponent(conversationId)}/read`), { method: "POST", headers: headers(profile) });
  return readJson<{ readAt: number }>(response, (value): value is { readAt: number } => isTimestampResponse(value, "readAt"));
}

export async function acknowledgeMessage(profile: Profile, messageId: string) {
  const response = await request(apiUrl(profile, `/api/v1/messages/${encodeURIComponent(messageId)}/delivered`), { method: "POST", headers: headers(profile) });
  return readJson<{ deliveredAt: number }>(response, (value): value is { deliveredAt: number } => isTimestampResponse(value, "deliveredAt"));
}

export async function registerPushToken(profile: Profile, token: string, deviceId: string, platform: "android" | "ios") {
  const response = await request(apiUrl(profile, "/api/v1/push-tokens"), {
    method: "POST",
    headers: headers(profile),
    body: JSON.stringify({ token, deviceId, platform }),
  });
  await readJson<{ accepted: boolean }>(response, isAcceptedResponse);
}

export async function registerDeviceKey(profile: Profile, bundle: DeviceKeyBundle, accountKey?: { keyId: string; encryptionPublicKey: string }) {
  const response = await request(apiUrl(profile, "/enter/v1/keys"), { method: "POST", headers: headers(profile), body: JSON.stringify({ ...bundle, ...clientDeviceMetadata(), accountKeyId: accountKey?.keyId, accountEncryptionPublicKey: accountKey?.encryptionPublicKey }) });
  await readJson<{ accepted: boolean }>(response, isAcceptedResponse);
}

export async function fetchPublicDeviceKeys(profile: Profile, rawAddress: string): Promise<PublicDeviceKey[]> {
  const address = parseEnterAddress(rawAddress, profile.server);
  if (!address) throw new Error("Некорректный Enter-адрес");
  const server = resolveDirectoryServer(address.server, profile.server);
  const response = await request(`${server}/enter/v1/keys/${encodeURIComponent(address.handle)}`);
  const directory = await readJson<PublicKeyDirectoryResponse>(response, isDirectoryResponse);
  const recipientAddress = directoryAddress(directory, address.handle, server);
  return directory.devices.map((device) => ({ ...device, address: recipientAddress }));
}

export async function fetchPublicAccountKey(profile: Profile, rawAddress: string): Promise<PublicAccountKey | undefined> {
  const address = parseEnterAddress(rawAddress, profile.server);
  if (!address) throw new Error("Некорректный Enter-адрес");
  const server = resolveDirectoryServer(address.server, profile.server);
  const response = await request(`${server}/enter/v1/keys/${encodeURIComponent(address.handle)}`);
  const directory = await readJson<PublicKeyDirectoryResponse>(response, isDirectoryResponse);
  if (!directory.accountKey) return undefined;
  return { ...directory.accountKey, address: directoryAddress(directory, address.handle, server) };
}

export async function searchUser(profile: Profile, rawQuery: string): Promise<SearchUser> {
  const raw = rawQuery.trim();
  const address = raw.startsWith("@") || raw.includes("@") ? parseEnterAddress(raw, profile.server) : null;
  const query = raw.replace(/^@+/, "");
  if (!address && (!query || query.includes("@"))) throw new Error("Введите username или @username@server");
  const server = address ? resolveDirectoryServer(address.server, profile.server) : profile.server;
  const response = address
    ? await request(`${server}/enter/v1/keys/${encodeURIComponent(address.handle)}`)
    : await request(`${server}/enter/v1/keys/search?q=${encodeURIComponent(query)}`);
  const directory = await readJson<PublicKeyDirectoryResponse>(response, isDirectoryResponse);
  const expectedHandle = address?.handle ?? directory.handle;
  const resultAddress = directoryAddress(directory, expectedHandle, server);
  return { id: directory.id, address: resultAddress, handle: directory.handle, name: directory.name, server, serverId: directory.serverId, avatar: directory.handle, deviceCount: directory.devices.length };
}

export async function createConversation(profile: Profile, user: SearchUser) {
  const response = await request(apiUrl(profile, "/api/v1/conversations"), { method: "POST", headers: headers(profile), body: JSON.stringify({ peerAddress: user.address, name: user.name, avatar: user.avatar, subtitle: user.address }) });
  return readJson<RemoteConversation>(response, isRemoteConversation);
}

export async function sendMessage(profile: Profile, conversationId: string, message: Message, encryptedMessages: EncryptedMessage[]) {
  logEvent("send", "Sending message", `recipients ${encryptedMessages.length}${message.attachments?.length ? `, attachments ${message.attachments.length}` : ""}`);
  const response = await request(apiUrl(profile, "/api/v1/messages"), { method: "POST", headers: headers(profile), body: JSON.stringify({ conversationId, clientMessageId: message.id, encryptedMessages }) });
  const result = await readJson<{ nextCursor: number; message: RemoteMessage }>(response, (value): value is { nextCursor: number; message: RemoteMessage } => isRecord(value) && isNumber(value.nextCursor) && value.nextCursor >= 0 && isRemoteMessage(value.message));
  logEvent("send", "Message accepted by server", `cursor ${result.nextCursor}`, "success");
  return result;
}

export function uploadMedia(profile: Profile, conversationId: string, mediaId: string, recipient: string, ciphertext: Uint8Array, onProgress?: (progress: number) => void) {
  if (ciphertext.byteLength === 0 || ciphertext.byteLength > MAX_MEDIA_CIPHERTEXT_BYTES) {
    return Promise.reject(new Error("Вложение превышает допустимый размер"));
  }
  logEvent("media", "Attachment upload started", `size ${ciphertext.byteLength} bytes`);
  return new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
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
      if (xhr.status >= 200 && xhr.status < 300) {
        let payload: unknown;
        try { payload = JSON.parse(xhr.responseText); } catch { payload = undefined; }
        if (isAcceptedResponse(payload) && payload.accepted) { logEvent("media", "Attachment uploaded", `size ${ciphertext.byteLength} bytes`, "success"); resolve(); }
        else { logEvent("media", "Attachment upload failed", "Invalid server response", "error"); reject(new Error("Enter API вернул некорректный ответ для вложения")); }
      }
      else {
        let detail = "";
        try {
          const payload = JSON.parse(xhr.responseText) as { error?: unknown };
          if (typeof payload.error === "string") detail = `: ${payload.error}`;
        } catch { /* Keep the HTTP status. */ }
        const error = new Error(`Enter media request failed: ${xhr.status}${detail}`);
        logEvent("media", "Attachment upload failed", error.message, "error");
        reject(error);
      }
    };
    xhr.onerror = () => { logEvent("media", "Attachment upload failed", "Network error", "error"); reject(new Error("Не удалось загрузить вложение")); };
    xhr.onabort = () => { logEvent("media", "Attachment upload canceled", undefined, "warn"); reject(new Error("Загрузка вложения отменена")); };
    xhr.ontimeout = () => { logEvent("media", "Attachment upload timed out", undefined, "error"); reject(new Error("Загрузка вложения превысила тайм-аут")); };
    xhr.send(ciphertext.buffer.slice(ciphertext.byteOffset, ciphertext.byteOffset + ciphertext.byteLength) as ArrayBuffer);
  });
}

export async function downloadMedia(profile: Profile, mediaId: string) {
  const response = await request(apiUrl(profile, `/api/v1/media/${encodeURIComponent(mediaId)}`), { headers: { authorization: `Bearer ${profile.token}` } });
  if (!response.ok) throw new Error(`Enter media request failed: ${response.status}`);
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_MEDIA_CIPHERTEXT_BYTES) throw new Error("Вложение превышает допустимый размер");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_MEDIA_CIPHERTEXT_BYTES) throw new Error("Вложение имеет некорректный размер");
  return bytes;
}

export async function syncDeviceHistory(profile: Profile, entries: DeviceHistoryEntry[]) {
  if (entries.length === 0) return;
  const response = await request(apiUrl(profile, "/api/v1/device-history"), { method: "POST", headers: headers(profile), body: JSON.stringify({ entries }) });
  return readJson<{ accepted: number; nextCursor: number }>(response, (value): value is { accepted: number; nextCursor: number } => isRecord(value) && isNumber(value.accepted) && value.accepted >= 0 && isNumber(value.nextCursor) && value.nextCursor >= 0);
}

export function mapRemoteConversation(remote: RemoteConversation): Conversation {
  return { id: remote.id, serverId: remote.serverId, name: remote.name, handle: remote.handle ?? undefined, avatar: remote.avatar, subtitle: remote.subtitle ?? undefined, canWrite: remote.canWrite, lastMessage: remote.lastMessage, time: remote.lastMessageAt ? formatMessageTime(new Date(remote.lastMessageAt)) : "", pinned: remote.pinned, online: remote.online, lastSeenAt: remote.lastSeenAt ?? undefined, unread: remote.unread ?? 0 };
}

export function mapRemoteMessage(remote: RemoteMessage): Message {
  return { id: remote.encryptedMessage.message_id, author: remote.author, text: "", time: formatMessageTime(new Date(remote.createdAt)), stackId: remote.stackId, encryptedMessage: remote.encryptedMessage };
}
