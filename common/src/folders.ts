import type { ChatFolder, Conversation, FolderIcon, FolderTemplate } from "./types.ts";

export type { ChatFolder, FolderIcon, FolderTemplate } from "./types";

export const FOLDER_TEMPLATES: Array<{ id: FolderTemplate; label: string; description: string }> = [
  { id: "custom", label: "Свободная", description: "Чаты добавляются вручную" },
  { id: "personal", label: "Личные чаты", description: "Все прямые диалоги" },
  { id: "all", label: "Все чаты", description: "Все доступные диалоги" },
];

export const FOLDER_ICONS: Array<{ id: FolderIcon; label: string }> = [
  { id: "folder", label: "Папка" },
  { id: "chat", label: "Сообщения" },
  { id: "person", label: "Личные" },
  { id: "star", label: "Важное" },
  { id: "bookmark", label: "Закладки" },
];

function isFolderTemplate(value: unknown): value is FolderTemplate {
  return value === "custom" || value === "personal" || value === "all";
}

function isFolderIcon(value: unknown): value is FolderIcon {
  return value === "folder" || value === "chat" || value === "person" || value === "star" || value === "bookmark";
}

export function isChatFolder(value: unknown): value is ChatFolder {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  return typeof input.id === "string"
    && input.id.length > 0
    && input.id.length <= 128
    && !/[\u0000-\u001f\u007f]/.test(input.id)
    && typeof input.name === "string"
    && input.name.trim().length > 0
    && input.name.length <= 160
    && !/[\u0000-\u001f\u007f]/.test(input.name)
    && isFolderTemplate(input.template)
    && isFolderIcon(input.icon)
    && Array.isArray(input.chatIds)
    && input.chatIds.length <= 4096
    && input.chatIds.every((id) => typeof id === "string" && id.length > 0 && id.length <= 128 && !/[\u0000-\u001f\u007f]/.test(id));
}

export function normalizeFolder(value: unknown): ChatFolder | null {
  if (!value || typeof value !== "object") return null;
  const input = value as Partial<ChatFolder>;
  if (typeof input.id !== "string" || !input.id || typeof input.name !== "string" || !input.name.trim()) return null;
  return {
    id: input.id,
    name: input.name.trim().slice(0, 40),
    template: isFolderTemplate(input.template) ? input.template : "custom",
    icon: isFolderIcon(input.icon) ? input.icon : "folder",
    chatIds: Array.isArray(input.chatIds) ? [...new Set(input.chatIds.filter((id): id is string => typeof id === "string"))] : [],
  };
}

export function sanitizeFoldersByProfile(value: unknown): Record<string, ChatFolder[]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).map(([profileId, folders]) => [profileId, Array.isArray(folders) ? folders.map(normalizeFolder).filter((folder): folder is ChatFolder => folder !== null) : []]));
}

export function folderContains(folder: ChatFolder, conversation: Conversation) {
  if (folder.template === "all") return true;
  if (folder.template === "personal") return Boolean(conversation.handle && conversation.handle !== "official" && conversation.handle !== "favorites");
  return folder.chatIds.includes(conversation.id);
}
