import { formatEnterAddress, parseEnterAddress } from "./enter-protocol";
import { isManagedDeviceResponse, type ManagedDeviceResponse } from "./enter-api-contract";
import { normalizeServerAddress } from "./server-address";
import { logEvent } from "./logs";
import { MAX_MEDIA_BYTES } from "../../../common/src/media.ts";
import type { DeviceKeyBundle, PublicAccountKey, PublicDeviceKey } from "./e2e";
import type { ChatFolder } from "./folders";
import type { Conversation, Message, Profile } from "../types";
import type { AccountSettings, AccountSettingsPatch, BlockedAccount, ClientDeviceMetadata, DeviceHistoryEntry, RemoteConversation, RemoteDeliveryReceipt, RemoteMessage, RemoteReadReceipt, RealtimeEvent, SearchUser, SyncResponse } from "../../../common/src/api-types.ts";
import type { EncryptedMessage } from "../../../common/src/protocol.ts";
import { isAcceptedResponse, isAccountSettings, isBlockedAccount, isBlockedAccountList, isDeviceHistoryResponse, isEncryptedMessage, isFolderList, isRealtimeEvent, isRemoteConversation, isRemoteMessage, isSyncResponse, isTimestampResponse } from "../../../common/src/api-contract.ts";
import { apiUrl as buildApiUrl, authHeaders, readJson } from "../../../common/src/api-helpers.ts";

export type { AccountSettings, AccountSettingsPatch, BlockedAccount, ClientDeviceMetadata, DeviceHistoryEntry, RemoteConversation, RemoteDeliveryReceipt, RemoteMessage, RemoteReadReceipt, RealtimeEvent, SearchUser, SyncResponse } from "../../../common/src/api-types.ts";

const REQUEST_TIMEOUT_MS = 10_000;
const MAX_MEDIA_CIPHERTEXT_BYTES = MAX_MEDIA_BYTES + 16;

type SendMessageResponse = {
  nextCursor: number;
  message: RemoteMessage;
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

export function clientDeviceMetadata(): ClientDeviceMetadata {
  const userAgent = navigator.userAgent;
  const browser = userAgent.includes("Edg/") ? "Edge" : userAgent.includes("Chrome/") ? "Chrome" : userAgent.includes("Firefox/") ? "Firefox" : userAgent.includes("Safari/") ? "Safari" : "Browser";
  const platform = navigator.platform || "desktop";
  return { platform: "web", deviceName: `${browser} · ${platform}`.slice(0, 128), appVersion: "0.2.3" };
}

type PublicKeyDirectoryResponse = {
  id: string;
  handle: string;
  name: string;
  server: string;
  serverId?: string;
  devices: DeviceKeyBundle[];
  accountKey?: { keyId: string; encryptionPublicKey: string } | null;
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

function isAcceptedTrueResponse(value: unknown): value is { accepted: true } {
  return isRecord(value) && value.accepted === true;
}

function isNonNegativeTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]) {
  return Object.keys(value).every((key) => keys.includes(key));
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
  if (accountKey !== undefined && accountKey !== null && (!isRecord(accountKey) || typeof accountKey.keyId !== "string" || typeof accountKey.encryptionPublicKey !== "string")) {
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

function apiUrl(profile: Profile, path: string) {
  return buildApiUrl(profile.server, path);
}

function headers(profile: Profile) {
  return authHeaders(profile.token);
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

export { mapRemoteConversation, mapRemoteMessage } from "../../../common/src/api-mappers.ts";
