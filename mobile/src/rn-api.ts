import type { EncryptedEnvelope } from "./protocol";
import { formatEnterAddress, parseEnterAddress } from "./rn-address";
import { messageTime as formatMessageTime } from "./data";
import type { DeviceKeyBundle, PublicAccountKey, PublicDeviceKey } from "./rn-e2e";
import type { Conversation, Message, Profile, SearchUser } from "./types";

const REQUEST_TIMEOUT_MS = 10_000;

function isLoopbackServer(server: string) {
  try {
    const hostname = new URL(server).hostname.toLowerCase().replace(/^\[|\]$/g, "");
    return hostname === "localhost" || hostname === "::1" || hostname === "0.0.0.0" || hostname.startsWith("127.");
  } catch {
    return false;
  }
}

function resolveDirectoryServer(server: string, fallback: string) {
  return isLoopbackServer(server) ? fallback : server;
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
  envelope: EncryptedEnvelope;
};

export type RemoteReadReceipt = { messageId: string; readAt: number };
export type RemoteDeliveryReceipt = { messageId: string; deliveredAt: number };
export type SyncResponse = { nextCursor: number; conversations: RemoteConversation[]; messages: RemoteMessage[]; readReceipts: RemoteReadReceipt[]; deliveryReceipts: RemoteDeliveryReceipt[] };

export type RealtimeEvent =
  | { type: "ready"; version: number }
  | ({ type: "sync" } & SyncResponse)
  | { type: "message"; cursor: number; message: RemoteMessage }
  | { type: "readReceipt"; cursor: number; messageId: string; readAt: number }
  | { type: "deliveryReceipt"; cursor: number; messageId: string; deliveredAt: number }
  | { type: "presence"; conversationId: string; online: boolean; lastSeenAt: number }
  | { type: "pong" }
  | { type: "error"; code: string };
export type DeviceHistoryEntry = { conversationId: string; messageId: string; sourceKeyId?: string; envelope: EncryptedEnvelope };

type PublicKeyDirectoryResponse = { id: string; handle: string; name: string; server: string; serverId?: string; devices: DeviceKeyBundle[]; accountKey?: { keyId: string; encryptionPublicKey: string } };

function apiUrl(profile: Profile, path: string) {
  return `${profile.server.replace(/\/+$/, "")}${path}`;
}

function headers(profile: Profile) {
  return { authorization: `Bearer ${profile.token}`, "content-type": "application/json" };
}

async function request(input: RequestInfo | URL, init?: RequestInit) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function readJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { error?: unknown } | null;
    const detail = payload && typeof payload.error === "string" ? `: ${payload.error}` : "";
    throw new Error(`Enter API request failed: ${response.status}${detail}`);
  }
  return response.json() as Promise<T>;
}

export async function syncProfile(profile: Profile, since: number) {
  const response = await request(`${apiUrl(profile, "/api/v1/sync")}?since=${Math.max(0, since)}`, { headers: headers(profile) });
  return readJson<SyncResponse>(response);
}

export function openRealtime(profile: Profile, since: number, onEvent: (event: RealtimeEvent) => void, onClose: () => void) {
  const websocket = new WebSocket(`${profile.server.replace(/^http/, "ws").replace(/\/+$/, "")}/api/v1/realtime`);
  websocket.onopen = () => websocket.send(JSON.stringify({ type: "hello", version: 1, token: profile.token, since: Math.max(0, since) }));
  websocket.onmessage = (event) => {
    try {
      const value = JSON.parse(String(event.data)) as { type?: unknown };
      if (typeof value.type === "string") onEvent(value as RealtimeEvent);
    } catch {
      // Ignore malformed frames; the next snapshot repairs state.
    }
  };
  websocket.onclose = onClose;
  return websocket;
}

export async function markConversationRead(profile: Profile, conversationId: string) {
  const response = await request(apiUrl(profile, `/api/v1/conversations/${encodeURIComponent(conversationId)}/read`), { method: "POST", headers: headers(profile) });
  return readJson<{ readAt: number }>(response);
}

export async function acknowledgeMessage(profile: Profile, messageId: string) {
  const response = await request(apiUrl(profile, `/api/v1/messages/${encodeURIComponent(messageId)}/delivered`), { method: "POST", headers: headers(profile) });
  return readJson<{ deliveredAt: number }>(response);
}

export async function registerPushToken(profile: Profile, token: string, deviceId: string, platform: "android" | "ios") {
  const response = await request(apiUrl(profile, "/api/v1/push-tokens"), {
    method: "POST",
    headers: headers(profile),
    body: JSON.stringify({ token, deviceId, platform }),
  });
  await readJson<{ accepted: boolean }>(response);
}

export async function registerDeviceKey(profile: Profile, bundle: DeviceKeyBundle, accountKey?: { keyId: string; encryptionPublicKey: string }) {
  const response = await request(apiUrl(profile, "/enter/v1/keys"), { method: "POST", headers: headers(profile), body: JSON.stringify({ ...bundle, accountKeyId: accountKey?.keyId, accountEncryptionPublicKey: accountKey?.encryptionPublicKey }) });
  await readJson<{ accepted: boolean }>(response);
}

export async function fetchPublicDeviceKeys(profile: Profile, rawAddress: string): Promise<PublicDeviceKey[]> {
  const address = parseEnterAddress(rawAddress, profile.server);
  if (!address) throw new Error("Некорректный Enter-адрес");
  const server = resolveDirectoryServer(address.server, profile.server);
  const response = await request(`${server}/enter/v1/keys/${encodeURIComponent(address.handle)}`);
  const directory = await readJson<PublicKeyDirectoryResponse>(response);
  const recipientAddress = formatEnterAddress({ handle: directory.handle, server: resolveDirectoryServer(directory.server || server, server) });
  return directory.devices.map((device) => ({ ...device, address: recipientAddress }));
}

export async function fetchPublicAccountKey(profile: Profile, rawAddress: string): Promise<PublicAccountKey | undefined> {
  const address = parseEnterAddress(rawAddress, profile.server);
  if (!address) throw new Error("Некорректный Enter-адрес");
  const server = resolveDirectoryServer(address.server, profile.server);
  const response = await request(`${server}/enter/v1/keys/${encodeURIComponent(address.handle)}`);
  const directory = await readJson<PublicKeyDirectoryResponse>(response);
  if (!directory.accountKey) return undefined;
  return { ...directory.accountKey, address: formatEnterAddress({ handle: directory.handle, server: resolveDirectoryServer(directory.server || server, server) }) };
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
  const directory = await readJson<PublicKeyDirectoryResponse>(response);
  const directoryServer = resolveDirectoryServer(directory.server || server, server);
  return { id: directory.id, address: formatEnterAddress({ handle: directory.handle, server: directoryServer }), handle: directory.handle, name: directory.name, server: directoryServer, serverId: directory.serverId, avatar: directory.handle, deviceCount: directory.devices.length };
}

export async function createConversation(profile: Profile, user: SearchUser) {
  const response = await request(apiUrl(profile, "/api/v1/conversations"), { method: "POST", headers: headers(profile), body: JSON.stringify({ peerAddress: user.address, name: user.name, avatar: user.avatar, subtitle: user.address }) });
  return readJson<RemoteConversation>(response);
}

export async function sendMessage(profile: Profile, conversationId: string, message: Message, envelopes: EncryptedEnvelope[]) {
  const response = await request(apiUrl(profile, "/api/v1/messages"), { method: "POST", headers: headers(profile), body: JSON.stringify({ conversationId, clientMessageId: message.id, envelopes }) });
  return readJson<{ nextCursor: number; message: RemoteMessage }>(response);
}

export function uploadMedia(profile: Profile, conversationId: string, mediaId: string, recipient: string, ciphertext: Uint8Array, onProgress?: (progress: number) => void) {
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
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else {
        let detail = "";
        try {
          const payload = JSON.parse(xhr.responseText) as { error?: unknown };
          if (typeof payload.error === "string") detail = `: ${payload.error}`;
        } catch { /* Keep the HTTP status. */ }
        reject(new Error(`Enter media request failed: ${xhr.status}${detail}`));
      }
    };
    xhr.onerror = () => reject(new Error("Не удалось загрузить вложение"));
    xhr.ontimeout = () => reject(new Error("Загрузка вложения превысила тайм-аут"));
    xhr.send(ciphertext.buffer.slice(ciphertext.byteOffset, ciphertext.byteOffset + ciphertext.byteLength) as ArrayBuffer);
  });
}

export async function downloadMedia(profile: Profile, mediaId: string) {
  const response = await request(apiUrl(profile, `/api/v1/media/${encodeURIComponent(mediaId)}`), { headers: { authorization: `Bearer ${profile.token}` } });
  if (!response.ok) throw new Error(`Enter media request failed: ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

export async function syncDeviceHistory(profile: Profile, entries: DeviceHistoryEntry[]) {
  if (entries.length === 0) return;
  const response = await request(apiUrl(profile, "/api/v1/device-history"), { method: "POST", headers: headers(profile), body: JSON.stringify({ entries }) });
  return readJson<{ accepted: number; nextCursor: number }>(response);
}

export function mapRemoteConversation(remote: RemoteConversation): Conversation {
  return { id: remote.id, serverId: remote.serverId, name: remote.name, handle: remote.handle ?? undefined, avatar: remote.avatar, subtitle: remote.subtitle ?? undefined, canWrite: remote.canWrite, lastMessage: remote.lastMessage, time: remote.lastMessageAt ? formatMessageTime(new Date(remote.lastMessageAt)) : "", pinned: remote.pinned, online: remote.online, lastSeenAt: remote.lastSeenAt ?? undefined, unread: remote.unread ?? 0 };
}

export function mapRemoteMessage(remote: RemoteMessage): Message {
  return { id: remote.envelope.message_id, author: remote.author, text: "", time: formatMessageTime(new Date(remote.createdAt)), stackId: remote.stackId, envelope: remote.envelope };
}
