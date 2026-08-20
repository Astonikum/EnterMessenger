import type { MessageAttachment } from "../types";

export const MAX_MEDIA_BYTES = 200 * 1024 * 1024;

export type EncryptedMedia = {
  attachment: MessageAttachment;
  ciphertext: Uint8Array;
};

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function kindForMime(mimeType: string): MessageAttachment["kind"] {
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("video/")) return "video";
  if (mimeType.startsWith("audio/")) return "audio";
  return "file";
}

function equalBytes(left: Uint8Array, right: Uint8Array) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export async function encryptMedia(file: File): Promise<EncryptedMedia> {
  if (file.size > MAX_MEDIA_BYTES) throw new Error("Файл слишком большой. Максимум — 200 МБ.");
  const plaintext = new Uint8Array(await file.arrayBuffer());
  const keyBytes = crypto.getRandomValues(new Uint8Array(32));
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const key = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["encrypt", "decrypt"]);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, plaintext));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", plaintext));
  return {
    attachment: {
      id: crypto.randomUUID(),
      kind: kindForMime(file.type || "application/octet-stream"),
      name: file.name || "Вложение",
      mimeType: file.type || "application/octet-stream",
      size: plaintext.byteLength,
      sha256: bytesToBase64(digest),
      key: bytesToBase64(keyBytes),
      nonce: bytesToBase64(nonce),
    },
    ciphertext,
  };
}

export async function decryptMedia(ciphertext: Uint8Array, attachment: MessageAttachment) {
  const binary = atob(attachment.key);
  const keyBytes = Uint8Array.from(binary, (value) => value.charCodeAt(0));
  const nonceBinary = atob(attachment.nonce);
  const nonce = Uint8Array.from(nonceBinary, (value) => value.charCodeAt(0));
  const key = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["decrypt"]);
  const plaintext = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, key, ciphertext));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", plaintext));
  const expected = Uint8Array.from(atob(attachment.sha256), (value) => value.charCodeAt(0));
  if (!equalBytes(digest, expected)) throw new Error("Проверка целостности вложения не пройдена");
  return plaintext;
}
