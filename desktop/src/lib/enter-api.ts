import { formatMessageTime } from "./utils";
import { formatEnterAddress, parseEnterAddress, type EncryptedEnvelope } from "./enter-protocol";
import type { DeviceKeyBundle, PublicAccountKey, PublicDeviceKey } from "./e2e";
import type { Conversation, Message, Profile } from "../types";

const REQUEST_TIMEOUT_MS = 10_000;

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
  envelope: EncryptedEnvelope;
};

export type RemoteReadReceipt = {
  messageId: string;
  readAt: number;
};

type SyncResponse = {
  nextCursor: number;
  conversations: RemoteConversation[];
  messages: RemoteMessage[];
  readReceipts: RemoteReadReceipt[];
};

type SendMessageResponse = {
  nextCursor: number;
  message: RemoteMessage;
};

export type DeviceHistoryEntry = {
  conversationId: string;
  messageId: string;
  sourceKeyId?: string;
  envelope: EncryptedEnvelope;
};

type PublicKeyDirectoryResponse = {
  id: string;
  handle: string;
  name: string;
  server: string;
  serverId?: string;
  devices: DeviceKeyBundle[];
  accountKey?: { keyId: string; encryptionPublicKey: string };
};

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
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    window.clearTimeout(timeout);
  }
}

async function readJson<T>(response: Response): Promise<T> {
  if (!response.ok) throw new Error(`Enter API request failed: ${response.status}`);
  return response.json() as Promise<T>;
}

export async function syncProfile(profile: Profile, since: number): Promise<SyncResponse> {
  const response = await request(`${apiUrl(profile, "/api/v1/sync")}?since=${Math.max(0, since)}`, {
    headers: headers(profile),
  });
  const result = await readJson<SyncResponse>(response);
  return { ...result, readReceipts: result.readReceipts ?? [] };
}

export async function markConversationRead(profile: Profile, conversationId: string) {
  const response = await request(apiUrl(profile, `/api/v1/conversations/${encodeURIComponent(conversationId)}/read`), {
    method: "POST",
    headers: headers(profile),
  });
  return readJson<{ readAt: number }>(response);
}

export async function registerDeviceKey(profile: Profile, bundle: DeviceKeyBundle, accountKey?: { keyId: string; encryptionPublicKey: string }) {
  const response = await request(apiUrl(profile, "/enter/v1/keys"), {
    method: "POST",
    headers: headers(profile),
    body: JSON.stringify({ ...bundle, accountKeyId: accountKey?.keyId, accountEncryptionPublicKey: accountKey?.encryptionPublicKey }),
  });
  await readJson<{ accepted: boolean }>(response);
}

export async function fetchPublicDeviceKeys(profile: Profile, rawAddress: string): Promise<PublicDeviceKey[]> {
  const address = parseEnterAddress(rawAddress, profile.server);
  if (!address) throw new Error("Некорректный Enter-адрес");
  const response = await request(`${address.server}/enter/v1/keys/${encodeURIComponent(address.handle)}`);
  const directory = await readJson<PublicKeyDirectoryResponse>(response);
  const recipientAddress = formatEnterAddress({ handle: directory.handle, server: directory.server || address.server });
  return directory.devices.map((device) => ({ ...device, address: recipientAddress }));
}

export async function fetchPublicAccountKey(profile: Profile, rawAddress: string): Promise<PublicAccountKey | undefined> {
  const address = parseEnterAddress(rawAddress, profile.server);
  if (!address) throw new Error("Некорректный Enter-адрес");
  const response = await request(`${address.server}/enter/v1/keys/${encodeURIComponent(address.handle)}`);
  const directory = await readJson<PublicKeyDirectoryResponse>(response);
  if (!directory.accountKey) return undefined;
  return {
    ...directory.accountKey,
    address: formatEnterAddress({ handle: directory.handle, server: directory.server || address.server }),
  };
}

export async function searchUser(profile: Profile, rawQuery: string): Promise<SearchUser> {
  const address = parseEnterAddress(rawQuery, profile.server);
  if (!address) throw new Error("Введите @username или @username@server");
  const response = await request(`${address.server}/enter/v1/keys/${encodeURIComponent(address.handle)}`);
  const directory = await readJson<PublicKeyDirectoryResponse>(response);
  const server = directory.server || address.server;
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
  return readJson<RemoteConversation>(response);
}

export async function sendMessage(profile: Profile, conversationId: string, message: Message, envelopes: EncryptedEnvelope[]): Promise<SendMessageResponse> {
  const response = await request(apiUrl(profile, "/api/v1/messages"), {
    method: "POST",
    headers: headers(profile),
    body: JSON.stringify({
      conversationId,
      clientMessageId: message.id,
      envelopes,
    }),
  });
  return readJson<SendMessageResponse>(response);
}

export async function syncDeviceHistory(profile: Profile, entries: DeviceHistoryEntry[]) {
  if (entries.length === 0) return;
  const response = await request(apiUrl(profile, "/api/v1/device-history"), {
    method: "POST",
    headers: headers(profile),
    body: JSON.stringify({ entries }),
  });
  return readJson<{ accepted: number; nextCursor: number }>(response);
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
    id: remote.envelope.message_id,
    author: remote.author,
    text: "",
    time: formatMessageTime(new Date(remote.createdAt)),
    envelope: remote.envelope,
  };
}
