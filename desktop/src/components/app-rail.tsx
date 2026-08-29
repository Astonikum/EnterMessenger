import type { Profile } from "../types";
import type { ChatFolder } from "../lib/folders";
import { cn } from "../lib/utils";
import { ProfileSwitcher } from "./profile-switcher";
import { ContextMenu } from "./ui/context-menu";
import { Icon } from "./ui/icon";

export type AppPanel = "chats" | "profile" | "settings" | "logs";

type AppRailProps = {
  profiles?: Profile[];
  activeProfile?: Profile;
  folders?: ChatFolder[];
  activeFolder?: string;
  activePanel?: AppPanel;
  onSelectProfile?: (profile: Profile) => void;
  onRemoveProfile?: (profile: Profile) => void | Promise<void>;
  onAddProfile?: () => void;
  onSelectFolder?: (folder: string) => void;
  onCreateFolder?: () => void;
  onEditFolder?: (folder: ChatFolder) => void;
  onDeleteFolder?: (folder: ChatFolder) => void;
  onSelectPanel?: (panel: AppPanel) => void;
};

// #preview AppRail {"profiles":[{"id":"local","name":"Алексей","handle":"@alex","server":"http://localhost:50121","color":"#a98bff","token":"preview"}],"activeProfile":{"id":"local","name":"Алексей","handle":"@alex","server":"http://localhost:50121","color":"#a98bff","token":"preview"}}
export function AppRail({ profiles = [], activeProfile, folders = [], activeFolder = "all", activePanel = "chats", onSelectProfile = () => undefined, onRemoveProfile = () => undefined, onAddProfile = () => undefined, onSelectFolder = () => undefined, onCreateFolder = () => undefined, onEditFolder = () => undefined, onDeleteFolder = () => undefined, onSelectPanel = () => undefined }: AppRailProps) {
  return (
    <aside className="app-rail flex flex-col border-r border-border/70 bg-surface/35">
      <div className="flex h-20 items-center justify-center overflow-hidden px-2"><img src="/enter_logo.png" alt="Enter" className="h-4 w-[4.25rem] -rotate-90 object-contain brightness-0 invert" /></div>
      <ProfileSwitcher profiles={profiles} activeProfile={activeProfile} onSelect={onSelectProfile} onRemove={onRemoveProfile} onAdd={onAddProfile} />
      <div className="flex flex-col items-center gap-2 px-3 pt-1">
        <button type="button" className={cn("rail-button", activePanel === "chats" && activeFolder === "all" && "rail-button-active")} title="Все чаты" aria-label="Все чаты" onClick={() => { onSelectFolder("all"); onSelectPanel("chats"); }}><Icon name="chat" className="size-5" /></button>
        {folders.map((folder) => <ContextMenu key={folder.id} items={[{ label: "Настроить папку", icon: <Icon name="settings" className="size-4" />, onSelect: () => onEditFolder(folder) }, { label: "Удалить папку", icon: <Icon name="delete" className="size-4" />, destructive: true, onSelect: () => onDeleteFolder(folder) }]}><button type="button" className={cn("rail-button", activePanel === "chats" && activeFolder === folder.id && "rail-button-active")} title={folder.name} aria-label={folder.name} onClick={() => { onSelectFolder(folder.id); onSelectPanel("chats"); }}><Icon name={folder.icon} className="size-5" /></button></ContextMenu>)}
        <button type="button" className="rail-button" title="Создать папку" aria-label="Создать папку" onClick={onCreateFolder}><Icon name="add" className="size-5" /></button>
      </div>
      <div className="mt-auto flex flex-col items-center gap-2 p-3">
        <button type="button" className={cn("rail-button", activePanel === "profile" && "rail-button-active")} title="Профиль" aria-label="Профиль" aria-pressed={activePanel === "profile"} onClick={() => onSelectPanel("profile")}><Icon name="person" className="size-5" /></button>
        <button type="button" className={cn("rail-button", activePanel === "settings" && "rail-button-active")} title="Настройки" aria-label="Настройки" aria-pressed={activePanel === "settings"} onClick={() => onSelectPanel("settings")}><Icon name="settings" className="size-5" /></button>
        <button type="button" className={cn("rail-button", activePanel === "logs" && "rail-button-active")} title="Логи" aria-label="Логи" aria-pressed={activePanel === "logs"} onClick={() => onSelectPanel("logs")}><Icon name="logs" className="size-5" /></button>
      </div>
    </aside>
  );
}
