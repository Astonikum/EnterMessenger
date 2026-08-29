import { gcm } from "@noble/ciphers/aes";
import { sha256 } from "@noble/hashes/sha2";
import { fromByteArray, toByteArray } from "base64-js";
import { randomBytes } from "./crypto-random";
import type { MessageAttachment } from "./types";
import { kindForMime, MAX_MEDIA_BYTES } from "../../common/src/media.ts";

export { isAudioAttachment, MAX_MEDIA_BYTES } from "../../common/src/media.ts";

export type MobileMediaSource = { uri: string; name: string; mimeType: string; size?: number };
export type EncryptedMedia = { attachment: MessageAttachment; ciphertext: Uint8Array };

export async function encryptMedia(source: MobileMediaSource): Promise<EncryptedMedia> {
  if (source.size !== undefined && (!Number.isFinite(source.size) || source.size < 0 || source.size > MAX_MEDIA_BYTES)) {
    throw new Error("Файл слишком большой или имеет некорректный размер");
  }
  const response = await fetch(source.uri);
  if (!response.ok) throw new Error("Не удалось прочитать вложение");
  const plaintext = new Uint8Array(await response.arrayBuffer());
  return encryptMediaBytes(plaintext, source);
}

export async function encryptMediaBytes(
  plaintext: Uint8Array,
  metadata: Pick<MobileMediaSource, "name" | "mimeType"> & Partial<Pick<MessageAttachment, "kind" | "width" | "height" | "durationMs">>,
): Promise<EncryptedMedia> {
  if (plaintext.byteLength > MAX_MEDIA_BYTES) throw new Error("Файл слишком большой. Максимум — 200 МБ.");
  const key = randomBytes(32);
  const nonce = randomBytes(12);
  const ciphertext = gcm(key, nonce).encrypt(plaintext);
  return {
    attachment: {
      id: `${Date.now().toString(36)}-${Array.from(randomBytes(8), (value) => value.toString(16).padStart(2, "0")).join("")}`,
      kind: metadata.kind ?? kindForMime(metadata.mimeType || "application/octet-stream"),
      name: metadata.name || "Вложение",
      mimeType: metadata.mimeType || "application/octet-stream",
      size: plaintext.byteLength,
      sha256: fromByteArray(sha256(plaintext)),
      key: fromByteArray(key),
      nonce: fromByteArray(nonce),
      width: metadata.width,
      height: metadata.height,
      durationMs: metadata.durationMs,
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
