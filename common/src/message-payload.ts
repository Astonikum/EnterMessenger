import type { Message, MessageAttachment, MessageReactionEvent } from "./types.ts";
import { MAX_MEDIA_BYTES } from "./media.ts";

const EDIT_PAYLOAD_PREFIX = "ENTER_EDIT_V1:";
const MESSAGE_PAYLOAD_PREFIX = "ENTER_MESSAGE_V2:";
const MAX_ATTACHMENTS = 10;
const MAX_REACTION_LENGTH = 32;

export type DecodedMessagePayload = {
  text: string;
  editOf?: string;
  attachments?: MessageAttachment[];
  replyTo?: { id: string; text: string };
  reactionEvent?: MessageReactionEvent;
};

export function encodeMessagePayload(message: Message) {
  if (message.reactionEvent) return `${MESSAGE_PAYLOAD_PREFIX}${JSON.stringify({ type: "reaction", ...message.reactionEvent })}`;
  if (!message.editOf && !message.attachments?.length && !message.replyTo) return message.text;
  return `${MESSAGE_PAYLOAD_PREFIX}${JSON.stringify({ text: message.text, editOf: message.editOf, attachments: message.attachments ?? [], replyTo: message.replyTo })}`;
}

function isIdentifier(value: unknown, maxLength = 256): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength && !/[\u0000-\u001f\u007f]/.test(value);
}

function isReplyTo(value: unknown): value is NonNullable<Message["replyTo"]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const reply = value as Partial<NonNullable<Message["replyTo"]>>;
  return isIdentifier(reply.id) && typeof reply.text === "string" && reply.text.length <= 4000;
}

function isReactionEvent(value: unknown): value is MessageReactionEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const event = value as Partial<MessageReactionEvent>;
  return isIdentifier(event.targetMessageId)
    && (event.reaction === null || (typeof event.reaction === "string" && event.reaction.length <= MAX_REACTION_LENGTH));
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

export function decodeMessagePayload(value: string): DecodedMessagePayload {
  if (!value.startsWith(EDIT_PAYLOAD_PREFIX) && !value.startsWith(MESSAGE_PAYLOAD_PREFIX)) return { text: value };
  try {
    if (value.startsWith(EDIT_PAYLOAD_PREFIX)) {
      const payload = JSON.parse(value.slice(EDIT_PAYLOAD_PREFIX.length)) as { targetId?: unknown; text?: unknown };
      if (typeof payload.targetId === "string" && typeof payload.text === "string") return { text: payload.text, editOf: payload.targetId };
    } else {
      const payload = JSON.parse(value.slice(MESSAGE_PAYLOAD_PREFIX.length)) as { type?: unknown; targetMessageId?: unknown; reaction?: unknown; text?: unknown; editOf?: unknown; attachments?: unknown; replyTo?: unknown };
      if (payload.type === "reaction") {
        const reactionEvent = { targetMessageId: payload.targetMessageId, reaction: payload.reaction };
        if (isReactionEvent(reactionEvent)) return { text: "", reactionEvent };
        return { text: value };
      }
      if (typeof payload.text === "string") {
        const rawAttachments = Array.isArray(payload.attachments) ? payload.attachments : [];
        const attachments = rawAttachments.filter(isAttachment);
        const decoded = {
          text: payload.text,
          editOf: typeof payload.editOf === "string" ? payload.editOf : undefined,
          attachments: rawAttachments.length <= MAX_ATTACHMENTS && attachments.length === rawAttachments.length ? attachments : undefined,
        };
        const replyTo = isReplyTo(payload.replyTo) ? payload.replyTo : undefined;
        return replyTo ? { ...decoded, replyTo } : decoded;
      }
    }
  } catch {
    // Keep malformed or legacy payloads as regular message text.
  }
  return { text: value };
}
