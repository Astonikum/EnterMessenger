import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import { formatLastSeen, formatMessageTime } from "../../../common/src/format.ts";

export { formatLastSeen, formatMessageTime } from "../../../common/src/format.ts";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function makeId() {
  return crypto.randomUUID();
}

export async function copyText(value: string) {
  await navigator.clipboard?.writeText(value);
}
