import { randomUUID } from "./crypto-random";
import type { Message } from "./types";
import { formatMessageTime } from "../../common/src/format.ts";

export { formatMessageTime } from "../../common/src/format.ts";

export const EMPTY_MESSAGES: Record<string, Message[]> = {};

export function makeId() {
  return randomUUID();
}

export function messageTime(date = new Date()) {
  return formatMessageTime(date);
}
