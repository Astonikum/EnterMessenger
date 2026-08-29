import type { MessageAttachment } from "./types.ts";

export const MAX_MEDIA_BYTES = 200 * 1024 * 1024;

export function kindForMime(mimeType: string) {
  if (mimeType.startsWith("image/")) return "image" as const;
  if (mimeType.startsWith("video/")) return "video" as const;
  if (mimeType.startsWith("audio/")) return "audio" as const;
  return "file" as const;
}

const audioMimeTypes: Record<string, string> = {
  aac: "audio/aac",
  amr: "audio/amr",
  flac: "audio/flac",
  m4a: "audio/mp4",
  mp3: "audio/mpeg",
  oga: "audio/ogg",
  ogg: "audio/ogg",
  opus: "audio/opus",
  wav: "audio/wav",
  weba: "audio/webm",
};

export function audioMimeTypeForName(name: string) {
  return audioMimeTypes[name.toLowerCase().split(".").pop() ?? ""];
}

export function isAudioAttachment(attachment: Pick<MessageAttachment, "kind" | "mimeType" | "name">) {
  return attachment.kind === "audio" || (attachment.kind === "file" && (attachment.mimeType.toLowerCase().startsWith("audio/") || Boolean(audioMimeTypeForName(attachment.name))));
}
