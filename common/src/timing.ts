export function timingNow() {
  return typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now();
}

export function timingElapsed(start: number, end = timingNow()) {
  return Math.max(0, Math.round(end - start));
}

type MessageStateSource = "send" | "realtime";
type MessageStateMark = { at: number; source: MessageStateSource };
const messageStateMarks = new Map<string, MessageStateMark>();

export function markMessageStateApplied(messageId: string, at = timingNow(), source: MessageStateSource = "realtime") {
  messageStateMarks.set(messageId, { at, source });
}

export function consumeMessageStateApplied(messageId: string) {
  const mark = messageStateMarks.get(messageId);
  if (mark !== undefined) messageStateMarks.delete(messageId);
  return mark;
}
