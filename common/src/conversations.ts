import type { ChatFolder, Conversation } from "./types.ts";
import { folderContains } from "./folders.ts";

export const AVATAR_COLORS = ["#ff3b30", "#ffd60a", "#30d158", "#0a84ff", "#bf5af2", "#ff375f", "#ff9f0a", "#ffffff"];

export function compactText(value: string, maxLength: number) {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > maxLength ? `${compact.slice(0, maxLength).trimEnd()}…` : compact;
}

export function normalizeAvatarName(value: string) {
  return value.replace(/^@/, "");
}

export function filterConversations(conversations: Conversation[], folders: ChatFolder[], activeFolder = "all", query = "") {
  const normalizedQuery = query.toLowerCase();
  return conversations
    .filter((conversation) => !conversation.archived
      && !conversation.deleted
      && (activeFolder === "all" || folders.some((folder) => folder.id === activeFolder && folderContains(folder, conversation)))
      && `${conversation.name} ${conversation.handle ?? ""} ${conversation.lastMessage}`.toLowerCase().includes(normalizedQuery))
    .sort((left, right) => Number(Boolean(right.pinned)) - Number(Boolean(left.pinned)));
}

export function conversationAvatarKind(conversation: Pick<Conversation, "handle" | "avatar">) {
  if (conversation.handle === "favorites" || conversation.avatar === "favorites") return "favorites" as const;
  if (conversation.handle === "official" || conversation.avatar === "enter-official") return "official" as const;
  return "generated" as const;
}
