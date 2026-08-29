import { normalizeFolder } from "../../../common/src/folders.ts";
import type { ChatFolder } from "../../../common/src/types.ts";

export {
  FOLDER_ICONS,
  FOLDER_TEMPLATES,
  folderContains,
  isChatFolder,
  normalizeFolder,
  sanitizeFoldersByProfile,
} from "../../../common/src/folders.ts";
export type { ChatFolder, FolderIcon, FolderTemplate } from "../../../common/src/folders.ts";

export function readFolders(profileId: string) {
  try {
    const raw = localStorage.getItem(`enter-folders:${profileId}`);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.map(normalizeFolder).filter((folder): folder is ChatFolder => folder !== null) : [];
  } catch {
    return [];
  }
}

export function writeFolders(profileId: string, folders: ChatFolder[]) {
  try {
    localStorage.setItem(`enter-folders:${profileId}`, JSON.stringify(folders));
  } catch {
    // Folder settings stay in memory when storage is unavailable.
  }
}
