import { randomUUID } from "./crypto-random";
import type { Message } from "./types";

export const EMPTY_MESSAGES: Record<string, Message[]> = {};

export function makeId() {
  return randomUUID();
}

export function messageTime(date = new Date()) {
  return new Intl.DateTimeFormat("ru-RU", { hour: "2-digit", minute: "2-digit" }).format(date);
}
