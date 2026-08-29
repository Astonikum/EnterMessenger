import type { MessageAttachment } from "../types";
import { audioMimeTypeForName, isAudioAttachment, kindForMime, MAX_MEDIA_BYTES } from "../../../common/src/media.ts";

export { isAudioAttachment, MAX_MEDIA_BYTES } from "../../../common/src/media.ts";

export type EncryptedMedia = {
  attachment: MessageAttachment;
  ciphertext: Uint8Array;
};

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function mimeTypeForFile(file: File) {
  const mimeType = file.type.toLowerCase();
  if (mimeType.startsWith("audio/")) return mimeType;
  return audioMimeTypeForName(file.name) || mimeType || "application/octet-stream";
}

function equalBytes(left: Uint8Array, right: Uint8Array) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export async function encryptMedia(file: File): Promise<EncryptedMedia> {
  if (file.size > MAX_MEDIA_BYTES) throw new Error("Файл слишком большой. Максимум — 200 МБ.");
  const plaintext = new Uint8Array(await file.arrayBuffer());
  const mimeType = mimeTypeForFile(file);
  return encryptMediaBytes(plaintext, { name: file.name, mimeType });
}

export async function encryptMediaBytes(
  plaintext: Uint8Array,
  metadata: { name: string; mimeType?: string } & Partial<Pick<MessageAttachment, "kind" | "width" | "height" | "durationMs">>,
): Promise<EncryptedMedia> {
  if (plaintext.byteLength > MAX_MEDIA_BYTES) throw new Error("Файл слишком большой. Максимум — 200 МБ.");
  const mimeType = metadata.mimeType ?? "application/octet-stream";
  const keyBytes = crypto.getRandomValues(new Uint8Array(32));
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const key = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["encrypt", "decrypt"]);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, plaintext));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", plaintext));
  return {
    attachment: {
      id: crypto.randomUUID(),
      kind: metadata.kind ?? kindForMime(mimeType),
      name: metadata.name || "Вложение",
      mimeType,
      size: plaintext.byteLength,
      sha256: bytesToBase64(digest),
      key: bytesToBase64(keyBytes),
      nonce: bytesToBase64(nonce),
      width: metadata.width,
      height: metadata.height,
      durationMs: metadata.durationMs,
    },
    ciphertext,
  };
}

export async function decryptMedia(ciphertext: Uint8Array, attachment: MessageAttachment) {
  if (ciphertext.byteLength < 16 || ciphertext.byteLength > MAX_MEDIA_BYTES + 16) throw new Error("Вложение имеет некорректный размер");
  const binary = atob(attachment.key);
  const keyBytes = Uint8Array.from(binary, (value) => value.charCodeAt(0));
  const nonceBinary = atob(attachment.nonce);
  const nonce = Uint8Array.from(nonceBinary, (value) => value.charCodeAt(0));
  if (keyBytes.byteLength !== 32 || nonce.byteLength !== 12) throw new Error("Ключ вложения повреждён");
  const key = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["decrypt"]);
  const plaintext = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, key, ciphertext));
  if (plaintext.byteLength > MAX_MEDIA_BYTES || plaintext.byteLength !== attachment.size) throw new Error("Размер вложения не совпадает");
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", plaintext));
  const expected = Uint8Array.from(atob(attachment.sha256), (value) => value.charCodeAt(0));
  if (expected.byteLength !== 32) throw new Error("Хэш вложения повреждён");
  if (!equalBytes(digest, expected)) throw new Error("Проверка целостности вложения не пройдена");
  return plaintext;
}
