import { gcm } from "@noble/ciphers/aes";
import { p256 } from "@noble/curves/p256";
import { hkdf } from "@noble/hashes/hkdf";
import { pbkdf2 } from "@noble/hashes/pbkdf2";
import { sha256 } from "@noble/hashes/sha2";
import { bytesToUtf8, concatBytes, hexToBytes, utf8ToBytes, bytesToHex } from "@noble/hashes/utils";
import { fromByteArray, toByteArray } from "base64-js";
import { getRandomBytesAsync } from "expo-crypto";
import * as SecureStore from "expo-secure-store";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { ENTER_PROTOCOL_VERSION, type EncryptedEnvelope } from "./protocol";
import type { Message, MessageAttachment, Profile } from "./types";

const DEVICE_KEY_PREFIX = "enter-native-device-";
const FALLBACK_DEVICE_KEY_PREFIX = "enter-fallback-device-";
const ACCOUNT_KEY_PREFIX = "enter-native-account-";
const FALLBACK_ACCOUNT_KEY_PREFIX = "enter-fallback-account-";
const pendingDevices = new Map<string, Promise<StoredDevice>>();

type StoredDevice = {
  profileId: string;
  deviceId: string;
  keyId: string;
  encryptionPrivateKey: string;
  encryptionPublicKey: string;
  signingPrivateKey: string;
  signingPublicKey: string;
  createdAt: number;
};

type StoredAccount = {
  profileId: string;
  keyId: string;
  encryptionPrivateKey: string;
  encryptionPublicKey: string;
};

export type DeviceKeyBundle = {
  deviceId: string;
  keyId: string;
  encryptionPublicKey: string;
  signingPublicKey: string;
  createdAt: number;
};

export type PublicDeviceKey = DeviceKeyBundle & { address: string };
export type PublicAccountKey = { keyId: string; encryptionPublicKey: string; address: string };
export type PublicEncryptionKey = Pick<PublicDeviceKey, "keyId" | "encryptionPublicKey" | "address">;

const EDIT_PAYLOAD_PREFIX = "ENTER_EDIT_V1:";
const MESSAGE_PAYLOAD_PREFIX = "ENTER_MESSAGE_V2:";

export function encodeMessagePayload(message: Message) {
  if (!message.editOf && !message.attachments?.length) return message.text;
  return `${MESSAGE_PAYLOAD_PREFIX}${JSON.stringify({ text: message.text, editOf: message.editOf, attachments: message.attachments ?? [] })}`;
}

function isAttachment(value: unknown): value is MessageAttachment {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<MessageAttachment>;
  return typeof item.id === "string" && typeof item.kind === "string" && typeof item.name === "string" && typeof item.mimeType === "string" && typeof item.size === "number" && typeof item.sha256 === "string" && typeof item.key === "string" && typeof item.nonce === "string";
}

export function decodeMessagePayload(value: string): { text: string; editOf?: string; attachments?: MessageAttachment[] } {
  if (!value.startsWith(EDIT_PAYLOAD_PREFIX) && !value.startsWith(MESSAGE_PAYLOAD_PREFIX)) return { text: value };
  try {
    if (value.startsWith(EDIT_PAYLOAD_PREFIX)) {
      const payload = JSON.parse(value.slice(EDIT_PAYLOAD_PREFIX.length)) as { targetId?: unknown; text?: unknown };
      if (typeof payload.targetId === "string" && typeof payload.text === "string") return { text: payload.text, editOf: payload.targetId };
    } else {
      const payload = JSON.parse(value.slice(MESSAGE_PAYLOAD_PREFIX.length)) as { text?: unknown; editOf?: unknown; attachments?: unknown };
      if (typeof payload.text === "string") return { text: payload.text, editOf: typeof payload.editOf === "string" ? payload.editOf : undefined, attachments: Array.isArray(payload.attachments) ? payload.attachments.filter(isAttachment) : undefined };
    }
  } catch {
    // Keep malformed or legacy payloads as regular message text.
  }
  return { text: value };
}

function cacheKey(profileId: string) {
  return `${DEVICE_KEY_PREFIX}${safeProfileKey(profileId)}`;
}

function fallbackCacheKey(profileId: string) {
  return `${FALLBACK_DEVICE_KEY_PREFIX}${safeProfileKey(profileId)}`;
}

function accountCacheKey(profileId: string) {
  return `${ACCOUNT_KEY_PREFIX}${safeProfileKey(profileId)}`;
}

function fallbackAccountCacheKey(profileId: string) {
  return `${FALLBACK_ACCOUNT_KEY_PREFIX}${safeProfileKey(profileId)}`;
}

function safeProfileKey(profileId: string) {
  return profileId.replace(/[^a-zA-Z0-9._-]/g, "_");
}

async function secureStoreAvailable() {
  try { return await SecureStore.isAvailableAsync(); } catch { return false; }
}

function encodeJwk(jwk: JsonWebKey) {
  return fromByteArray(utf8ToBytes(JSON.stringify(jwk)));
}

function decodeJwk(encoded: string) {
  return JSON.parse(bytesToUtf8(toByteArray(encoded))) as JsonWebKey;
}

function publicJwk(publicKey: Uint8Array): JsonWebKey {
  if (publicKey.length !== 65 || publicKey[0] !== 4) throw new Error("Некорректный P-256 ключ");
  return { kty: "EC", crv: "P-256", x: fromByteArray(publicKey.slice(1, 33)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_"), y: fromByteArray(publicKey.slice(33)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_"), ext: true };
}

function publicKeyFromJwk(jwk: JsonWebKey) {
  if (!jwk.x || !jwk.y) throw new Error("Публичный ключ повреждён");
  return concatBytes(new Uint8Array([4]), base64UrlToBytes(jwk.x), base64UrlToBytes(jwk.y));
}

function base64UrlToBytes(value: string) {
  return toByteArray(value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "="));
}

function bytesToBase64(value: Uint8Array) {
  return fromByteArray(value);
}

function base64ToBytes(value: string) {
  return toByteArray(value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "="));
}

async function randomBytes(length: number) {
  return getRandomBytesAsync(length);
}

async function randomPrivateKey() {
  let key = await randomBytes(32);
  while (!p256.utils.isValidPrivateKey(key)) key = await randomBytes(32);
  return key;
}

function idFromBytes(bytes: Uint8Array) {
  const hex = bytesToHex(bytes);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${((Number.parseInt(hex.slice(16, 18), 16) & 0x3f) | 0x80).toString(16)}${hex.slice(18, 20)}-${hex.slice(20, 32)}`;
}

async function readDevice(profileId: string) {
  let raw: string | null = null;
  if (await secureStoreAvailable()) {
    try { raw = await SecureStore.getItemAsync(cacheKey(profileId)); } catch { raw = null; }
  }
  if (!raw) raw = await AsyncStorage.getItem(fallbackCacheKey(profileId));
  if (!raw) return undefined;
  try { return JSON.parse(raw) as StoredDevice; } catch { return undefined; }
}

async function writeDevice(device: StoredDevice) {
  const value = JSON.stringify(device);
  if (await secureStoreAvailable()) {
    try { await SecureStore.setItemAsync(cacheKey(device.profileId), value); return; } catch { /* Fall back for an outdated native runtime. */ }
  }
  await AsyncStorage.setItem(fallbackCacheKey(device.profileId), value);
}

async function readAccount(profileId: string) {
  let raw: string | null = null;
  if (await secureStoreAvailable()) {
    try { raw = await SecureStore.getItemAsync(accountCacheKey(profileId)); } catch { raw = null; }
  }
  if (!raw) raw = await AsyncStorage.getItem(fallbackAccountCacheKey(profileId));
  if (!raw) return undefined;
  try { return JSON.parse(raw) as StoredAccount; } catch { return undefined; }
}

async function writeAccount(account: StoredAccount) {
  const value = JSON.stringify(account);
  if (await secureStoreAvailable()) {
    try { await SecureStore.setItemAsync(accountCacheKey(account.profileId), value); return; } catch { /* Fall back for an outdated native runtime. */ }
  }
  await AsyncStorage.setItem(fallbackAccountCacheKey(account.profileId), value);
}

async function generateDevice(profileId: string): Promise<StoredDevice> {
  const encryptionPrivateKey = await randomPrivateKey();
  const signingPrivateKey = await randomPrivateKey();
  return {
    profileId,
    deviceId: idFromBytes(await randomBytes(16)),
    keyId: idFromBytes(await randomBytes(16)),
    encryptionPrivateKey: bytesToHex(encryptionPrivateKey),
    encryptionPublicKey: encodeJwk(publicJwk(p256.getPublicKey(encryptionPrivateKey, false))),
    signingPrivateKey: bytesToHex(signingPrivateKey),
    signingPublicKey: encodeJwk(publicJwk(p256.getPublicKey(signingPrivateKey, false))),
    createdAt: Date.now(),
  };
}

export async function ensureDeviceKeys(profileId: string) {
  const pending = pendingDevices.get(profileId);
  if (pending) return pending;
  const request = (async () => {
    const existing = await readDevice(profileId);
    if (existing) return existing;
    const created = await generateDevice(profileId);
    await writeDevice(created);
    return created;
  })();
  pendingDevices.set(profileId, request);
  try { return await request; } finally { pendingDevices.delete(profileId); }
}

function accountPrivateBytes(profileId: string, password: string) {
  const seed = pbkdf2(sha256, utf8ToBytes(password), utf8ToBytes(`enter/account-key/v1/${profileId}`), { c: 210_000, dkLen: 32 });
  for (let counter = 0; counter < 256; counter += 1) {
    const candidate = counter === 0 ? seed : sha256(concatBytes(seed, new Uint8Array([counter])));
    if (p256.utils.isValidPrivateKey(candidate)) return candidate;
  }
  throw new Error("Не удалось создать ключ аккаунта");
}

export async function ensureAccountKey(profileId: string, password: string) {
  const existing = await readAccount(profileId);
  if (existing) return existing;
  const privateBytes = accountPrivateBytes(profileId, password);
  const account: StoredAccount = {
    profileId,
    keyId: `account:${profileId}`,
    encryptionPrivateKey: bytesToHex(privateBytes),
    encryptionPublicKey: encodeJwk(publicJwk(p256.getPublicKey(privateBytes, false))),
  };
  await writeAccount(account);
  return account;
}

export function readAccountKey(profileId: string) {
  return readAccount(profileId);
}

export function accountKeyBundle(account: StoredAccount, address: string): PublicAccountKey {
  return { keyId: account.keyId, encryptionPublicKey: account.encryptionPublicKey, address };
}

export function deleteDeviceKeys(profileId: string) {
  return (async () => {
    if (await secureStoreAvailable()) {
      try { await SecureStore.deleteItemAsync(cacheKey(profileId)); } catch { /* Continue with fallback cleanup. */ }
      try { await SecureStore.deleteItemAsync(accountCacheKey(profileId)); } catch { /* Continue with fallback cleanup. */ }
    }
    await AsyncStorage.removeItem(fallbackCacheKey(profileId));
    await AsyncStorage.removeItem(fallbackAccountCacheKey(profileId));
  })();
}

export function deviceKeyBundle(device: StoredDevice): DeviceKeyBundle {
  return { deviceId: device.deviceId, keyId: device.keyId, encryptionPublicKey: device.encryptionPublicKey, signingPublicKey: device.signingPublicKey, createdAt: device.createdAt };
}

function envelopeData(envelope: Omit<EncryptedEnvelope, "signature">) {
  return JSON.stringify({ protocol: envelope.protocol, message_id: envelope.message_id, conversation_id: envelope.conversation_id, sender: envelope.sender, recipient: envelope.recipient, sender_device: envelope.sender_device, key_id: envelope.key_id, created_at: envelope.created_at, nonce: envelope.nonce, ephemeral_public_key: envelope.ephemeral_public_key, associated_data: envelope.associated_data, ciphertext: envelope.ciphertext });
}

function associatedData(envelope: Pick<EncryptedEnvelope, "protocol" | "message_id" | "conversation_id" | "sender" | "recipient" | "sender_device" | "key_id" | "created_at" | "nonce" | "ephemeral_public_key">) {
  return bytesToBase64(utf8ToBytes(JSON.stringify(envelope)));
}

function deriveMessageKey(privateKey: Uint8Array, publicKey: Uint8Array, nonce: Uint8Array, conversationId: string) {
  const sharedPoint = p256.getSharedSecret(privateKey, publicKey, true);
  const sharedX = sharedPoint.slice(1);
  return hkdf(sha256, sharedX, nonce, utf8ToBytes(`enter/e2e/v1/${conversationId}`), 32);
}

export async function encryptMessage(profile: Profile, conversationId: string, message: Message, recipient: PublicEncryptionKey) {
  const device = await ensureDeviceKeys(profile.id);
  const ephemeralPrivateKey = await randomPrivateKey();
  const ephemeralPublicKey = publicJwk(p256.getPublicKey(ephemeralPrivateKey, false));
  const nonce = await randomBytes(12);
  const sender = `${profile.handle}@${profile.server.replace(/^https?:\/\//, "")}`;
  const clearEnvelope: Omit<EncryptedEnvelope, "signature"> = {
    protocol: ENTER_PROTOCOL_VERSION,
    message_id: message.id,
    conversation_id: conversationId,
    sender,
    recipient: recipient.address,
    sender_device: device.deviceId,
    key_id: recipient.keyId,
    created_at: new Date().toISOString(),
    nonce: bytesToBase64(nonce),
    ephemeral_public_key: encodeJwk(ephemeralPublicKey),
    associated_data: "",
    ciphertext: "",
  };
  clearEnvelope.associated_data = associatedData(clearEnvelope);
  const key = deriveMessageKey(ephemeralPrivateKey, publicKeyFromJwk(decodeJwk(recipient.encryptionPublicKey)), nonce, conversationId);
  clearEnvelope.ciphertext = bytesToBase64(gcm(key, nonce, base64ToBytes(clearEnvelope.associated_data)).encrypt(utf8ToBytes(encodeMessagePayload(message))));
  const signature = p256.sign(utf8ToBytes(envelopeData(clearEnvelope)), hexToBytes(device.signingPrivateKey), { lowS: false, prehash: true }).toCompactRawBytes();
  return { ...clearEnvelope, signature: bytesToBase64(signature) } satisfies EncryptedEnvelope;
}

export async function decryptMessage(profile: Profile, envelope: EncryptedEnvelope, sender: PublicDeviceKey) {
  const device = await ensureDeviceKeys(profile.id);
  const account = await readAccount(profile.id);
  const privateKey = envelope.key_id === account?.keyId
    ? hexToBytes(account.encryptionPrivateKey)
    : envelope.key_id === device.keyId
      ? hexToBytes(device.encryptionPrivateKey)
      : undefined;
  if (!privateKey) throw new Error("Ключ получателя не найден");
  const signingKey = publicKeyFromJwk(decodeJwk(sender.signingPublicKey));
  if (!p256.verify(base64ToBytes(envelope.signature), sha256(utf8ToBytes(envelopeData(envelope))), signingKey, { lowS: false, prehash: false })) throw new Error("Подпись сообщения недействительна");
  const nonce = base64ToBytes(envelope.nonce);
  const key = deriveMessageKey(privateKey, publicKeyFromJwk(decodeJwk(envelope.ephemeral_public_key)), nonce, envelope.conversation_id);
  return bytesToUtf8(gcm(key, nonce, base64ToBytes(envelope.associated_data)).decrypt(base64ToBytes(envelope.ciphertext)));
}

export type { StoredDevice };
