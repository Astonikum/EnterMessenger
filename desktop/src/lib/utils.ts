import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function makeId() {
  return crypto.randomUUID();
}

export function formatMessageTime(date = new Date()) {
  return new Intl.DateTimeFormat("ru-RU", { hour: "2-digit", minute: "2-digit" }).format(date);
}

export function formatLastSeen(timestamp?: number) {
  if (!timestamp) return "был(а) давно";
  const date = new Date(timestamp);
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (sameDay) return `был(а) сегодня в ${formatMessageTime(date)}`;
  if (date.toDateString() === yesterday.toDateString()) return `был(а) вчера в ${formatMessageTime(date)}`;
  return `был(а) ${new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long" }).format(date)} в ${formatMessageTime(date)}`;
}

export async function copyText(value: string) {
  await navigator.clipboard?.writeText(value);
}
