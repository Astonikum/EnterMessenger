import { p256 } from "@noble/curves/p256";
import { pbkdf2 } from "@noble/hashes/pbkdf2";
import { sha256 } from "@noble/hashes/sha2";
import { concatBytes, utf8ToBytes } from "@noble/hashes/utils";
import { ENTER_PROTOCOL_VERSION, type EncryptedMessage } from "./enter-protocol";
import { decodeMessagePayload, encodeMessagePayload } from "../../../common/src/message-payload.ts";
import type { DeviceKeyBundle, PublicAccountKey, PublicDeviceKey, PublicEncryptionKey } from "../../../common/src/e2e-types.ts";
import type { Message, Profile } from "../types";

export { decodeMessagePayload, encodeMessagePayload } from "../../../common/src/message-payload.ts";
export type { DeviceKeyBundle, PublicAccountKey, PublicDeviceKey, PublicEncryptionKey } from "../../../common/src/e2e-types.ts";

const DATABASE_NAME = "enter-e2e";
const DATABASE_VERSION = 2;
const DEVICE_STORE = "devices";
const ACCOUNT_STORE = "accounts";
const KEY_AGREEMENT: EcKeyGenParams = { name: "ECDH", namedCurve: "P-256" };
const SIGNATURE: EcKeyGenParams = { name: "ECDSA", namedCurve: "P-256" };

type StoredDevice = {
  profileId: string;
  deviceId: string;
  keyId: string;
  encryptionPrivateKey: CryptoKey;
  encryptionPublicKey: JsonWebKey;
  signingPrivateKey: CryptoKey;
  signingPublicKey: JsonWebKey;
  createdAt: number;
};

type StoredAccount = {
  profileId: string;
  keyId: string;
  encryptionPrivateKey: CryptoKey;
  encryptionPublicKey: JsonWebKey;
};

function openDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(DEVICE_STORE)) request.result.createObjectStore(DEVICE_STORE, { keyPath: "profileId" });
      if (!request.result.objectStoreNames.contains(ACCOUNT_STORE)) request.result.createObjectStore(ACCOUNT_STORE, { keyPath: "profileId" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Не удалось открыть хранилище ключей"));
  });
}

function readStoredDevice(profileId: string) {
  return openDatabase().then((database) => new Promise<StoredDevice | undefined>((resolve, reject) => {
    const request = database.transaction(DEVICE_STORE, "readonly").objectStore(DEVICE_STORE).get(profileId);
    request.onsuccess = () => resolve(request.result as StoredDevice | undefined);
    request.onerror = () => reject(request.error ?? new Error("Не удалось прочитать ключи устройства"));
    request.transaction?.addEventListener("complete", () => database.close());
  }));
}

function writeStoredDevice(device: StoredDevice) {
  return openDatabase().then((database) => new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(DEVICE_STORE, "readwrite");
    transaction.objectStore(DEVICE_STORE).put(device);
    transaction.oncomplete = () => { database.close(); resolve(); };
    transaction.onerror = () => { database.close(); reject(transaction.error ?? new Error("Не удалось сохранить ключи устройства")); };
  }));
}

function readStoredAccount(profileId: string) {
  return openDatabase().then((database) => new Promise<StoredAccount | undefined>((resolve, reject) => {
    const request = database.transaction(ACCOUNT_STORE, "readonly").objectStore(ACCOUNT_STORE).get(profileId);
    request.onsuccess = () => resolve(request.result as StoredAccount | undefined);
    request.onerror = () => reject(request.error ?? new Error("Не удалось прочитать ключ аккаунта"));
    request.transaction?.addEventListener("complete", () => database.close());
  }));
}

function writeStoredAccount(account: StoredAccount) {
  return openDatabase().then((database) => new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(ACCOUNT_STORE, "readwrite");
    transaction.objectStore(ACCOUNT_STORE).put(account);
    transaction.oncomplete = () => { database.close(); resolve(); };
    transaction.onerror = () => { database.close(); reject(transaction.error ?? new Error("Не удалось сохранить ключ аккаунта")); };
  }));
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function bytesToBase64Url(bytes: Uint8Array) {
  return bytesToBase64(bytes).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function encodeText(value: string) {
  return new TextEncoder().encode(value);
}

function encodeJwk(value: JsonWebKey) {
  return bytesToBase64(encodeText(JSON.stringify(value)));
}

function decodeJwk(value: string) {
  return JSON.parse(new TextDecoder().decode(base64ToBytes(value))) as JsonWebKey;
}

async function exportPublicKey(key: CryptoKey) {
  return crypto.subtle.exportKey("jwk", key);
}

async function makePrivateKeyNonExtractable(key: CryptoKey, algorithm: EcKeyImportParams, usages: KeyUsage[]) {
  if (!key.extractable) return key;
  const jwk = await crypto.subtle.exportKey("jwk", key);
  return crypto.subtle.importKey("jwk", jwk, algorithm, false, usages);
}

async function hardenStoredDevice(device: StoredDevice) {
  const encryptionPrivateKey = await makePrivateKeyNonExtractable(device.encryptionPrivateKey, KEY_AGREEMENT, ["deriveBits"]);
  const signingPrivateKey = await makePrivateKeyNonExtractable(device.signingPrivateKey, SIGNATURE, ["sign"]);
  return encryptionPrivateKey === device.encryptionPrivateKey && signingPrivateKey === device.signingPrivateKey
    ? device
    : { ...device, encryptionPrivateKey, signingPrivateKey };
}

async function generateDevice(profileId: string): Promise<StoredDevice> {
  const encryption = await crypto.subtle.generateKey(KEY_AGREEMENT, true, ["deriveBits"]);
  const signing = await crypto.subtle.generateKey(SIGNATURE, true, ["sign", "verify"]);
  return {
    profileId,
    deviceId: crypto.randomUUID(),
    keyId: crypto.randomUUID(),
    encryptionPrivateKey: await makePrivateKeyNonExtractable(encryption.privateKey, KEY_AGREEMENT, ["deriveBits"]),
    encryptionPublicKey: await exportPublicKey(encryption.publicKey),
    signingPrivateKey: await makePrivateKeyNonExtractable(signing.privateKey, SIGNATURE, ["sign"]),
    signingPublicKey: await exportPublicKey(signing.publicKey),
    createdAt: Date.now(),
  };
}

export async function ensureDeviceKeys(profileId: string) {
  const existing = await readStoredDevice(profileId);
  if (existing) {
    const hardened = await hardenStoredDevice(existing);
    if (hardened !== existing) await writeStoredDevice(hardened);
    return hardened;
  }
  const created = await generateDevice(profileId);
  await writeStoredDevice(created);
  return created;
}

function accountPrivateBytes(profileId: string, password: string) {
  const seed = pbkdf2(sha256, utf8ToBytes(password), utf8ToBytes(`enter/account-key/v1/${profileId}`), { c: 210_000, dkLen: 32 });
  for (let counter = 0; counter < 256; counter += 1) {
    const candidate = counter === 0 ? seed : sha256(concatBytes(seed, new Uint8Array([counter])));
    if (p256.utils.isValidPrivateKey(candidate)) return candidate;
  }
  throw new Error("Не удалось создать ключ аккаунта");
}

function accountJwks(privateBytes: Uint8Array) {
  const publicBytes = p256.getPublicKey(privateBytes, false);
  const x = bytesToBase64Url(publicBytes.slice(1, 33));
  const y = bytesToBase64Url(publicBytes.slice(33));
  const d = bytesToBase64Url(privateBytes);
  const publicKey = { kty: "EC", crv: "P-256", x, y, ext: true } satisfies JsonWebKey;
  return { publicKey, privateKey: { ...publicKey, d } satisfies JsonWebKey };
}

export async function ensureAccountKey(profileId: string, password: string) {
  const existing = await readStoredAccount(profileId);
  if (existing) {
    const hardened = await makePrivateKeyNonExtractable(existing.encryptionPrivateKey, KEY_AGREEMENT, ["deriveBits"]);
    if (hardened !== existing.encryptionPrivateKey) {
      const migrated = { ...existing, encryptionPrivateKey: hardened };
      await writeStoredAccount(migrated);
      return migrated;
    }
    return existing;
  }
  const jwks = accountJwks(accountPrivateBytes(profileId, password));
  const account: StoredAccount = {
    profileId,
    keyId: `account:${profileId}`,
    encryptionPrivateKey: await crypto.subtle.importKey("jwk", jwks.privateKey, KEY_AGREEMENT, false, ["deriveBits"]),
    encryptionPublicKey: jwks.publicKey,
  };
  await writeStoredAccount(account);
  return account;
}

export async function readAccountKey(profileId: string) {
  const existing = await readStoredAccount(profileId);
  if (!existing) return undefined;
  const hardened = await makePrivateKeyNonExtractable(existing.encryptionPrivateKey, KEY_AGREEMENT, ["deriveBits"]);
  if (hardened === existing.encryptionPrivateKey) return existing;
  const migrated = { ...existing, encryptionPrivateKey: hardened };
  await writeStoredAccount(migrated);
  return migrated;
}

export function accountKeyBundle(account: StoredAccount, address: string): PublicAccountKey {
  return { keyId: account.keyId, encryptionPublicKey: encodeJwk(account.encryptionPublicKey), address };
}

export function deleteDeviceKeys(profileId: string) {
  return openDatabase().then((database) => new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(DEVICE_STORE, "readwrite");
    transaction.objectStore(DEVICE_STORE).delete(profileId);
    transaction.objectStore(ACCOUNT_STORE).delete(profileId);
    transaction.oncomplete = () => { database.close(); resolve(); };
    transaction.onerror = () => { database.close(); reject(transaction.error ?? new Error("Не удалось удалить ключи устройства")); };
  }));
}

export function deviceKeyBundle(device: StoredDevice): DeviceKeyBundle {
  return {
    deviceId: device.deviceId,
    keyId: device.keyId,
    encryptionPublicKey: encodeJwk(device.encryptionPublicKey),
    signingPublicKey: encodeJwk(device.signingPublicKey),
    createdAt: device.createdAt,
  };
}

function encryptedMessageData(encryptedMessage: Omit<EncryptedMessage, "signature">) {
  return JSON.stringify({
    protocol: encryptedMessage.protocol,
    message_id: encryptedMessage.message_id,
    conversation_id: encryptedMessage.conversation_id,
    sender: encryptedMessage.sender,
    recipient: encryptedMessage.recipient,
    sender_device: encryptedMessage.sender_device,
    key_id: encryptedMessage.key_id,
    created_at: encryptedMessage.created_at,
    nonce: encryptedMessage.nonce,
    ephemeral_public_key: encryptedMessage.ephemeral_public_key,
    associated_data: encryptedMessage.associated_data,
    ciphertext: encryptedMessage.ciphertext,
  });
}

function associatedData(encryptedMessage: Pick<EncryptedMessage, "protocol" | "message_id" | "conversation_id" | "sender" | "recipient" | "sender_device" | "key_id" | "created_at" | "nonce" | "ephemeral_public_key">) {
  return bytesToBase64(encodeText(JSON.stringify(encryptedMessage)));
}

async function importEncryptionPublicKey(encoded: string) {
  return crypto.subtle.importKey("jwk", decodeJwk(encoded), KEY_AGREEMENT, false, []);
}

async function importSigningPublicKey(encoded: string) {
  return crypto.subtle.importKey("jwk", decodeJwk(encoded), SIGNATURE, false, ["verify"]);
}

async function deriveMessageKey(privateKey: CryptoKey, publicKey: CryptoKey, nonce: Uint8Array, conversationId: string) {
  const shared = await crypto.subtle.deriveBits({ name: "ECDH", public: publicKey }, privateKey, 256);
  const material = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: nonce, info: encodeText(`enter/e2e/v1/${conversationId}`) },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function encryptMessage(profile: Profile, conversationId: string, message: Message, recipient: PublicEncryptionKey) {
  const device = await ensureDeviceKeys(profile.id);
  const ephemeral = await crypto.subtle.generateKey(KEY_AGREEMENT, true, ["deriveBits"]);
  const ephemeralPublicKey = await exportPublicKey(ephemeral.publicKey);
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const sender = `${profile.handle}@${profile.server.replace(/^https?:\/\//, "")}`;
  const recipientAddress = recipient.address;
  const clearMessage: Omit<EncryptedMessage, "signature"> = {
    protocol: ENTER_PROTOCOL_VERSION,
    message_id: message.id,
    conversation_id: conversationId,
    sender,
    recipient: recipientAddress,
    sender_device: device.deviceId,
    key_id: recipient.keyId,
    created_at: new Date().toISOString(),
    nonce: bytesToBase64(nonce),
    ephemeral_public_key: encodeJwk(ephemeralPublicKey),
    associated_data: "",
    ciphertext: "",
  };
  clearMessage.associated_data = associatedData(clearMessage);
  const key = await deriveMessageKey(ephemeral.privateKey, await importEncryptionPublicKey(recipient.encryptionPublicKey), nonce, conversationId);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce, additionalData: base64ToBytes(clearMessage.associated_data) },
    key,
    encodeText(encodeMessagePayload(message)),
  );
  clearMessage.ciphertext = bytesToBase64(new Uint8Array(ciphertext));
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    device.signingPrivateKey,
    encodeText(encryptedMessageData(clearMessage)),
  );
  return { ...clearMessage, signature: bytesToBase64(new Uint8Array(signature)) } satisfies EncryptedMessage;
}

export async function decryptMessage(profile: Profile, encryptedMessage: EncryptedMessage, sender: PublicDeviceKey) {
  const device = await ensureDeviceKeys(profile.id);
  const account = await readStoredAccount(profile.id);
  const privateKey = encryptedMessage.key_id === account?.keyId
    ? account.encryptionPrivateKey
    : encryptedMessage.key_id === device.keyId
      ? device.encryptionPrivateKey
      : undefined;
  if (!privateKey) throw new Error("Ключ получателя не найден");
  const signingKey = await importSigningPublicKey(sender.signingPublicKey);
  const validSignature = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    signingKey,
    base64ToBytes(encryptedMessage.signature),
    encodeText(encryptedMessageData(encryptedMessage)),
  );
  if (!validSignature) throw new Error("Подпись сообщения недействительна");

  const nonce = base64ToBytes(encryptedMessage.nonce);
  const ephemeralPublicKey = await importEncryptionPublicKey(encryptedMessage.ephemeral_public_key);
  const key = await deriveMessageKey(privateKey, ephemeralPublicKey, nonce, encryptedMessage.conversation_id);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: nonce, additionalData: base64ToBytes(encryptedMessage.associated_data) },
    key,
    base64ToBytes(encryptedMessage.ciphertext),
  );
  return new TextDecoder().decode(plaintext);
}

export type { StoredDevice };
