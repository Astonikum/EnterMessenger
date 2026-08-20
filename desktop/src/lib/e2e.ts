import { p256 } from "@noble/curves/p256";
import { pbkdf2 } from "@noble/hashes/pbkdf2";
import { sha256 } from "@noble/hashes/sha2";
import { concatBytes, utf8ToBytes } from "@noble/hashes/utils";
import { ENTER_PROTOCOL_VERSION, type EncryptedEnvelope } from "./enter-protocol";
import type { Message, MessageAttachment, Profile } from "../types";

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

async function generateDevice(profileId: string): Promise<StoredDevice> {
  const encryption = await crypto.subtle.generateKey(KEY_AGREEMENT, true, ["deriveBits"]);
  const signing = await crypto.subtle.generateKey(SIGNATURE, true, ["sign", "verify"]);
  return {
    profileId,
    deviceId: crypto.randomUUID(),
    keyId: crypto.randomUUID(),
    encryptionPrivateKey: encryption.privateKey,
    encryptionPublicKey: await exportPublicKey(encryption.publicKey),
    signingPrivateKey: signing.privateKey,
    signingPublicKey: await exportPublicKey(signing.publicKey),
    createdAt: Date.now(),
  };
}

export async function ensureDeviceKeys(profileId: string) {
  const existing = await readStoredDevice(profileId);
  if (existing) return existing;
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
  if (existing) return existing;
  const jwks = accountJwks(accountPrivateBytes(profileId, password));
  const account: StoredAccount = {
    profileId,
    keyId: `account:${profileId}`,
    encryptionPrivateKey: await crypto.subtle.importKey("jwk", jwks.privateKey, KEY_AGREEMENT, true, ["deriveBits"]),
    encryptionPublicKey: jwks.publicKey,
  };
  await writeStoredAccount(account);
  return account;
}

export function readAccountKey(profileId: string) {
  return readStoredAccount(profileId);
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

function envelopeData(envelope: Omit<EncryptedEnvelope, "signature">) {
  return JSON.stringify({
    protocol: envelope.protocol,
    message_id: envelope.message_id,
    conversation_id: envelope.conversation_id,
    sender: envelope.sender,
    recipient: envelope.recipient,
    sender_device: envelope.sender_device,
    key_id: envelope.key_id,
    created_at: envelope.created_at,
    nonce: envelope.nonce,
    ephemeral_public_key: envelope.ephemeral_public_key,
    associated_data: envelope.associated_data,
    ciphertext: envelope.ciphertext,
  });
}

function associatedData(envelope: Pick<EncryptedEnvelope, "protocol" | "message_id" | "conversation_id" | "sender" | "recipient" | "sender_device" | "key_id" | "created_at" | "nonce" | "ephemeral_public_key">) {
  return bytesToBase64(encodeText(JSON.stringify(envelope)));
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
  const clearEnvelope: Omit<EncryptedEnvelope, "signature"> = {
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
  clearEnvelope.associated_data = associatedData(clearEnvelope);
  const key = await deriveMessageKey(ephemeral.privateKey, await importEncryptionPublicKey(recipient.encryptionPublicKey), nonce, conversationId);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce, additionalData: base64ToBytes(clearEnvelope.associated_data) },
    key,
    encodeText(encodeMessagePayload(message)),
  );
  clearEnvelope.ciphertext = bytesToBase64(new Uint8Array(ciphertext));
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    device.signingPrivateKey,
    encodeText(envelopeData(clearEnvelope)),
  );
  return { ...clearEnvelope, signature: bytesToBase64(new Uint8Array(signature)) } satisfies EncryptedEnvelope;
}

export async function decryptMessage(profile: Profile, envelope: EncryptedEnvelope, sender: PublicDeviceKey) {
  const device = await ensureDeviceKeys(profile.id);
  const account = await readStoredAccount(profile.id);
  const privateKey = envelope.key_id === account?.keyId
    ? account.encryptionPrivateKey
    : envelope.key_id === device.keyId
      ? device.encryptionPrivateKey
      : undefined;
  if (!privateKey) throw new Error("Ключ получателя не найден");
  const signingKey = await importSigningPublicKey(sender.signingPublicKey);
  const validSignature = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    signingKey,
    base64ToBytes(envelope.signature),
    encodeText(envelopeData(envelope)),
  );
  if (!validSignature) throw new Error("Подпись сообщения недействительна");

  const nonce = base64ToBytes(envelope.nonce);
  const ephemeralPublicKey = await importEncryptionPublicKey(envelope.ephemeral_public_key);
  const key = await deriveMessageKey(privateKey, ephemeralPublicKey, nonce, envelope.conversation_id);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: nonce, additionalData: base64ToBytes(envelope.associated_data) },
    key,
    base64ToBytes(envelope.ciphertext),
  );
  return new TextDecoder().decode(plaintext);
}

export type { StoredDevice };
