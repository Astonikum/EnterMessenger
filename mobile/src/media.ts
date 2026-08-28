import { gcm } from "@noble/ciphers/aes";
import { sha256 } from "@noble/hashes/sha2";
import { fromByteArray, toByteArray } from "base64-js";
import { getRandomBytesAsync } from "expo-crypto";
import type { MessageAttachment } from "./types";

export const MAX_MEDIA_BYTES = 200 * 1024 * 1024;

export type MobileMediaSource = { uri: string; name: string; mimeType: string; size?: number };
export type EncryptedMedia = { attachment: MessageAttachment; ciphertext: Uint8Array };

function kindForMime(mimeType: string): MessageAttachment["kind"] {
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("video/")) return "video";
  if (mimeType.startsWith("audio/")) return "audio";
  return "file";
}

export async function encryptMedia(source: MobileMediaSource): Promise<EncryptedMedia> {
  if (source.size !== undefined && (!Number.isFinite(source.size) || source.size < 0 || source.size > MAX_MEDIA_BYTES)) {
    throw new Error("Файл слишком большой или имеет некорректный размер");
  }
  const response = await fetch(source.uri);
  if (!response.ok) throw new Error("Не удалось прочитать вложение");
  const plaintext = new Uint8Array(await response.arrayBuffer());
  if (plaintext.byteLength > MAX_MEDIA_BYTES) throw new Error("Файл слишком большой. Максимум — 200 МБ.");
  const key = await getRandomBytesAsync(32);
  const nonce = await getRandomBytesAsync(12);
  const ciphertext = gcm(key, nonce).encrypt(plaintext);
  return {
    attachment: {
      id: `${Date.now().toString(36)}-${Array.from(await getRandomBytesAsync(8), (value) => value.toString(16).padStart(2, "0")).join("")}`,
      kind: kindForMime(source.mimeType || "application/octet-stream"),
      name: source.name || "Вложение",
      mimeType: source.mimeType || "application/octet-stream",
      size: plaintext.byteLength,
      sha256: fromByteArray(sha256(plaintext)),
      key: fromByteArray(key),
      nonce: fromByteArray(nonce),
    },
    ciphertext,
  };
}

export function decryptMedia(ciphertext: Uint8Array, attachment: MessageAttachment) {
  if (ciphertext.byteLength < 16 || ciphertext.byteLength > MAX_MEDIA_BYTES + 16) throw new Error("Вложение имеет некорректный размер");
  const key = toByteArray(attachment.key);
  const nonce = toByteArray(attachment.nonce);
  if (key.byteLength !== 32 || nonce.byteLength !== 12) throw new Error("Ключ вложения повреждён");
  const plaintext = gcm(key, nonce).decrypt(ciphertext);
  if (plaintext.byteLength > MAX_MEDIA_BYTES || plaintext.byteLength !== attachment.size) throw new Error("Размер вложения не совпадает");
  const digest = fromByteArray(sha256(plaintext));
  if (digest !== attachment.sha256) throw new Error("Проверка целостности вложения не пройдена");
  return plaintext;
}
