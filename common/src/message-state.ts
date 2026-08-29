import type { RemoteDeliveryReceipt, RemoteReadReceipt } from "./api-types.ts";
import type { Message } from "./types.ts";

export function retryDelay(attempts: number) {
  return Math.min(60_000, 1000 * 2 ** Math.min(attempts, 6));
}

export function isUnauthorized(reason: unknown) {
  return reason instanceof Error && /\b401\b/.test(reason.message);
}

export function resolveMessageEdits(messages: Message[]) {
  const baseMessages = messages.filter((message) => !message.editOf);
  const editEvents = messages.filter((message) => Boolean(message.editOf));
  editEvents.forEach((edit) => {
    const targetIndex = baseMessages.findIndex((message) => message.id === edit.editOf);
    if (targetIndex >= 0) baseMessages[targetIndex] = { ...baseMessages[targetIndex], text: edit.text, edited: true };
  });
  return [...baseMessages, ...editEvents];
}

export function mergeRemoteMessages(current: Record<string, Message[]>, incoming: Array<{ conversationId: string; message: Message }>, limit?: (messages: Message[]) => Message[]) {
  const next = { ...current };
  incoming.forEach(({ conversationId, message }) => {
    const existing = next[conversationId] ?? [];
    const index = existing.findIndex((item) => item.id === message.id);
    if (index < 0) next[conversationId] = [...existing, message];
    else {
      const replaced = [...existing];
      replaced[index] = { ...replaced[index], ...message, readAt: message.readAt ?? replaced[index].readAt, deliveredAt: message.deliveredAt ?? replaced[index].deliveredAt };
      next[conversationId] = replaced;
    }
    const resolved = resolveMessageEdits(next[conversationId]);
    next[conversationId] = limit ? limit(resolved) : resolved;
  });
  return next;
}

export function mergeReadReceipts(current: Record<string, Message[]>, receipts: RemoteReadReceipt[]) {
  if (receipts.length === 0) return current;
  const readAtByMessage = new Map(receipts.map((receipt) => [receipt.messageId, receipt.readAt]));
  return Object.fromEntries(Object.entries(current).map(([conversationId, messages]) => [conversationId, messages.map((message) => {
    const readAt = readAtByMessage.get(message.id);
    return readAt && (!message.readAt || readAt > message.readAt) ? { ...message, readAt } : message;
  })]));
}

export function mergeDeliveryReceipts(current: Record<string, Message[]>, receipts: RemoteDeliveryReceipt[]) {
  if (receipts.length === 0) return current;
  const deliveredAtByMessage = new Map(receipts.map((receipt) => [receipt.messageId, receipt.deliveredAt]));
  return Object.fromEntries(Object.entries(current).map(([conversationId, messages]) => [conversationId, messages.map((message) => {
    const deliveredAt = deliveredAtByMessage.get(message.id);
    return deliveredAt && (!message.deliveredAt || deliveredAt > message.deliveredAt) ? { ...message, deliveredAt } : message;
  })]));
}
