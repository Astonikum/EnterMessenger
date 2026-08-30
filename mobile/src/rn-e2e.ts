import { gcm } from "@noble/ciphers/aes";
import { p256 } from "@noble/curves/p256";
import { hkdf } from "@noble/hashes/hkdf";
import { pbkdf2Async } from "@noble/hashes/pbkdf2";
import { sha256 } from "@noble/hashes/sha2";
import { bytesToUtf8, concatBytes, hexToBytes, utf8ToBytes, bytesToHex } from "@noble/hashes/utils";
import { fromByteArray, toByteArray } from "base64-js";
import * as Keychain from "react-native-keychain";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { Platform } from "react-native";
import { randomBytes } from "./crypto-random";
import { withTimeout } from "./with-timeout";
import { ENTER_PROTOCOL_VERSION, type EncryptedMessage } from "./protocol";
import { decodeMessagePayload, encodeMessagePayload } from "../../common/src/message-payload.ts";
import type { DeviceKeyBundle, PublicAccountKey, PublicDeviceKey, PublicEncryptionKey } from "../../common/src/e2e-types.ts";
import type { Message, Profile } from "./types";

export { decodeMessagePayload, encodeMessagePayload } from "../../common/src/message-payload.ts";
export type { DeviceKeyBundle, PublicAccountKey, PublicDeviceKey, PublicEncryptionKey } from "../../common/src/e2e-types.ts";

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
  if (Platform.OS === "web") return false;
  try { await withTimeout(Keychain.getGenericPassword({ service: "enter-availability-probe" }), "Время проверки безопасного хранилища истекло"); return true; } catch { return false; }
}

const webKeyStorage = Platform.OS === "web";

async function readPrivateValue(primaryKey: string, fallbackKey: string, unavailableMessage: string, readErrorMessage: string) {
  const secure = await secureStoreAvailable();
  if (!secure && !webKeyStorage) throw new Error(unavailableMessage);
  let raw: string | null;
  try {
    if (secure) {
      const credentials = await withTimeout(Keychain.getGenericPassword({ service: primaryKey }), readErrorMessage);
      raw = credentials ? credentials.password : null;
    } else raw = await AsyncStorage.getItem(fallbackKey);
  } catch { throw new Error(readErrorMessage); }
  if (!raw && secure) {
    const legacy = await AsyncStorage.getItem(fallbackKey);
    if (legacy) {
      await withTimeout(Keychain.setGenericPassword("enter", legacy, { service: primaryKey }), readErrorMessage);
      await AsyncStorage.removeItem(fallbackKey);
      raw = legacy;
    }
  }
  return raw;
}

async function writePrivateValue(primaryKey: string, fallbackKey: string, value: string, unavailableMessage: string, writeErrorMessage: string) {
  const secure = await secureStoreAvailable();
  if (!secure && !webKeyStorage) throw new Error(unavailableMessage);
  try {
    if (secure) {
      await withTimeout(Keychain.setGenericPassword("enter", value, { service: primaryKey }), writeErrorMessage);
      await AsyncStorage.removeItem(fallbackKey).catch(() => undefined);
    } else {
      await AsyncStorage.setItem(fallbackKey, value);
    }
  } catch { throw new Error(writeErrorMessage); }
}

function isStoredDevice(value: unknown): value is StoredDevice {
  if (!value || typeof value !== "object") return false;
  const device = value as Partial<StoredDevice>;
  return typeof device.profileId === "string"
    && typeof device.deviceId === "string"
    && typeof device.keyId === "string"
    && typeof device.encryptionPrivateKey === "string"
    && typeof device.encryptionPublicKey === "string"
    && typeof device.signingPrivateKey === "string"
    && typeof device.signingPublicKey === "string"
    && typeof device.createdAt === "number"
    && Number.isFinite(device.createdAt);
}

function isStoredAccount(value: unknown): value is StoredAccount {
  if (!value || typeof value !== "object") return false;
  const account = value as Partial<StoredAccount>;
  return typeof account.profileId === "string"
    && typeof account.keyId === "string"
    && typeof account.encryptionPrivateKey === "string"
    && typeof account.encryptionPublicKey === "string";
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
  const raw = await readPrivateValue(cacheKey(profileId), fallbackCacheKey(profileId), "Безопасное хранилище недоступно на этом устройстве", "Не удалось прочитать ключи устройства");
  if (!raw) return undefined;
  try {
    const value: unknown = JSON.parse(raw);
    return isStoredDevice(value) ? value : undefined;
  } catch { return undefined; }
}

async function writeDevice(device: StoredDevice) {
  const value = JSON.stringify(device);
  await writePrivateValue(cacheKey(device.profileId), fallbackCacheKey(device.profileId), value, "Безопасное хранилище недоступно на этом устройстве", "Не удалось сохранить ключи устройства");
}

async function readAccount(profileId: string) {
  const raw = await readPrivateValue(accountCacheKey(profileId), fallbackAccountCacheKey(profileId), "Безопасное хранилище недоступно на этом устройстве", "Не удалось прочитать ключи аккаунта");
  if (!raw) return undefined;
  try {
    const value: unknown = JSON.parse(raw);
    return isStoredAccount(value) ? value : undefined;
  } catch { return undefined; }
}

async function writeAccount(account: StoredAccount) {
  const value = JSON.stringify(account);
  await writePrivateValue(accountCacheKey(account.profileId), fallbackAccountCacheKey(account.profileId), value, "Безопасное хранилище недоступно на этом устройстве", "Не удалось сохранить ключ аккаунта");
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

async function accountPrivateBytes(profileId: string, password: string) {
  const seed = await pbkdf2Async(sha256, utf8ToBytes(password), utf8ToBytes(`enter/account-key/v1/${profileId}`), { c: 210_000, dkLen: 32 });
  for (let counter = 0; counter < 256; counter += 1) {
    const candidate = counter === 0 ? seed : sha256(concatBytes(seed, new Uint8Array([counter])));
    if (p256.utils.isValidPrivateKey(candidate)) return candidate;
  }
  throw new Error("Не удалось создать ключ аккаунта");
}

export async function ensureAccountKey(profileId: string, password: string) {
  const existing = await readAccount(profileId);
  if (existing) return existing;
  const privateBytes = await accountPrivateBytes(profileId, password);
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
      try { await Keychain.resetGenericPassword({ service: cacheKey(profileId) }); } catch { /* Continue with fallback cleanup. */ }
      try { await Keychain.resetGenericPassword({ service: accountCacheKey(profileId) }); } catch { /* Continue with fallback cleanup. */ }
    }
    await AsyncStorage.removeItem(fallbackCacheKey(profileId));
    await AsyncStorage.removeItem(fallbackAccountCacheKey(profileId));
  })();
}

/** Explicit destructive cleanup; never call this from startup or migration paths. */
export async function deletePrivateE2EKeys(profileId: string) {
  const secure = await secureStoreAvailable();
  if (!secure && !webKeyStorage) throw new Error("Безопасное хранилище недоступно на этом устройстве");
  if (secure) await Promise.all([
    Keychain.resetGenericPassword({ service: cacheKey(profileId) }),
    Keychain.resetGenericPassword({ service: accountCacheKey(profileId) }),
  ]);
  await AsyncStorage.multiRemove([fallbackCacheKey(profileId), fallbackAccountCacheKey(profileId)]);
}

export function deviceKeyBundle(device: StoredDevice): DeviceKeyBundle {
  return { deviceId: device.deviceId, keyId: device.keyId, encryptionPublicKey: device.encryptionPublicKey, signingPublicKey: device.signingPublicKey, createdAt: device.createdAt };
}

function encryptedMessageData(encryptedMessage: Omit<EncryptedMessage, "signature">) {
  return JSON.stringify({ protocol: encryptedMessage.protocol, message_id: encryptedMessage.message_id, conversation_id: encryptedMessage.conversation_id, sender: encryptedMessage.sender, recipient: encryptedMessage.recipient, sender_device: encryptedMessage.sender_device, key_id: encryptedMessage.key_id, created_at: encryptedMessage.created_at, nonce: encryptedMessage.nonce, ephemeral_public_key: encryptedMessage.ephemeral_public_key, associated_data: encryptedMessage.associated_data, ciphertext: encryptedMessage.ciphertext });
}

function associatedData(encryptedMessage: Pick<EncryptedMessage, "protocol" | "message_id" | "conversation_id" | "sender" | "recipient" | "sender_device" | "key_id" | "created_at" | "nonce" | "ephemeral_public_key">) {
  return bytesToBase64(utf8ToBytes(JSON.stringify(encryptedMessage)));
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
  const clearMessage: Omit<EncryptedMessage, "signature"> = {
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
  clearMessage.associated_data = associatedData(clearMessage);
  const key = deriveMessageKey(ephemeralPrivateKey, publicKeyFromJwk(decodeJwk(recipient.encryptionPublicKey)), nonce, conversationId);
  clearMessage.ciphertext = bytesToBase64(gcm(key, nonce, base64ToBytes(clearMessage.associated_data)).encrypt(utf8ToBytes(encodeMessagePayload(message))));
  const signature = p256.sign(utf8ToBytes(encryptedMessageData(clearMessage)), hexToBytes(device.signingPrivateKey), { lowS: false, prehash: true }).toCompactRawBytes();
  return { ...clearMessage, signature: bytesToBase64(signature) } satisfies EncryptedMessage;
}

export async function decryptMessage(profile: Profile, encryptedMessage: EncryptedMessage, sender: PublicDeviceKey) {
  const device = await ensureDeviceKeys(profile.id);
  const account = await readAccount(profile.id);
  const privateKey = encryptedMessage.key_id === account?.keyId
    ? hexToBytes(account.encryptionPrivateKey)
    : encryptedMessage.key_id === device.keyId
      ? hexToBytes(device.encryptionPrivateKey)
      : undefined;
  if (!privateKey) throw new Error("Ключ получателя не найден");
  const signingKey = publicKeyFromJwk(decodeJwk(sender.signingPublicKey));
  if (!p256.verify(base64ToBytes(encryptedMessage.signature), sha256(utf8ToBytes(encryptedMessageData(encryptedMessage))), signingKey, { lowS: false, prehash: false })) throw new Error("Подпись сообщения недействительна");
  const nonce = base64ToBytes(encryptedMessage.nonce);
  const key = deriveMessageKey(privateKey, publicKeyFromJwk(decodeJwk(encryptedMessage.ephemeral_public_key)), nonce, encryptedMessage.conversation_id);
  return bytesToUtf8(gcm(key, nonce, base64ToBytes(encryptedMessage.associated_data)).decrypt(base64ToBytes(encryptedMessage.ciphertext)));
}

export type { StoredDevice };
