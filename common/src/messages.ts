import type { Message } from "./types.ts";
import { isAudioAttachment } from "./media.ts";

export function messagePreview(message: Pick<Message, "text" | "attachments">) {
  if (message.text.trim()) return message.text;
  const attachments = message.attachments ?? [];
  if (attachments.some(({ kind }) => kind === "image")) return "[Фото]";
  if (attachments.some(({ kind }) => kind === "video")) return "[Видео]";
  if (attachments.some(isAudioAttachment)) return "[Аудио]";
  return attachments.length > 0 ? "[Файлы]" : "";
}
