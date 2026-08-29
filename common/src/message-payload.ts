import type { Message, MessageAttachment } from "./types.ts";
import { MAX_MEDIA_BYTES } from "./media.ts";

const EDIT_PAYLOAD_PREFIX = "ENTER_EDIT_V1:";
const MESSAGE_PAYLOAD_PREFIX = "ENTER_MESSAGE_V2:";
const MAX_ATTACHMENTS = 10;

export function encodeMessagePayload(message: Message) {
  if (!message.editOf && !message.attachments?.length) return message.text;
  return `${MESSAGE_PAYLOAD_PREFIX}${JSON.stringify({ text: message.text, editOf: message.editOf, attachments: message.attachments ?? [] })}`;
}

function isAttachment(value: unknown): value is MessageAttachment {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<MessageAttachment>;
  return typeof item.id === "string"
    && item.id.length <= 128
    && (item.kind === "image" || item.kind === "video" || item.kind === "audio" || item.kind === "file")
    && typeof item.name === "string"
    && item.name.length <= 255
    && typeof item.mimeType === "string"
    && item.mimeType.length <= 128
    && typeof item.size === "number"
    && Number.isSafeInteger(item.size)
    && item.size >= 0
    && item.size <= MAX_MEDIA_BYTES
    && typeof item.sha256 === "string"
    && item.sha256.length <= 128
    && typeof item.key === "string"
    && item.key.length <= 128
    && typeof item.nonce === "string"
    && item.nonce.length <= 128;
}

export function decodeMessagePayload(value: string): { text: string; editOf?: string; attachments?: MessageAttachment[] } {
  if (!value.startsWith(EDIT_PAYLOAD_PREFIX) && !value.startsWith(MESSAGE_PAYLOAD_PREFIX)) return { text: value };
  try {
    if (value.startsWith(EDIT_PAYLOAD_PREFIX)) {
      const payload = JSON.parse(value.slice(EDIT_PAYLOAD_PREFIX.length)) as { targetId?: unknown; text?: unknown };
      if (typeof payload.targetId === "string" && typeof payload.text === "string") return { text: payload.text, editOf: payload.targetId };
    } else {
      const payload = JSON.parse(value.slice(MESSAGE_PAYLOAD_PREFIX.length)) as { text?: unknown; editOf?: unknown; attachments?: unknown };
      if (typeof payload.text === "string") {
        const rawAttachments = Array.isArray(payload.attachments) ? payload.attachments : [];
        const attachments = rawAttachments.filter(isAttachment);
        return { text: payload.text, editOf: typeof payload.editOf === "string" ? payload.editOf : undefined, attachments: rawAttachments.length <= MAX_ATTACHMENTS && attachments.length === rawAttachments.length ? attachments : undefined };
      }
    }
  } catch {
    // Keep malformed or legacy payloads as regular message text.
  }
  return { text: value };
}
