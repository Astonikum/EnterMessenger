import type { Profile } from "../types";
import { cn } from "../lib/utils";
import { ProfileSwitcher } from "./profile-switcher";
import { Icon } from "./ui/icon";

type AppRailProps = {
  profiles?: Profile[];
  activeProfile?: Profile;
  folders?: string[];
  activeFolder?: string;
  showSettings?: boolean;
  onSelectProfile?: (profile: Profile) => void;
  onRemoveProfile?: (profile: Profile) => void | Promise<void>;
  onAddProfile?: () => void;
  onBack?: () => void;
  onSelectFolder?: (folder: string) => void;
  onToggleSettings?: () => void;
};

// #preview AppRail {"profiles":[{"id":"local","name":"Алексей","handle":"@alex","server":"http://localhost:50121","color":"#a98bff","token":"preview"}],"activeProfile":{"id":"local","name":"Алексей","handle":"@alex","server":"http://localhost:50121","color":"#a98bff","token":"preview"},"showSettings":false}
export function AppRail({ profiles = [], activeProfile, folders = [], activeFolder = "all", showSettings = false, onSelectProfile = () => undefined, onRemoveProfile = () => undefined, onAddProfile = () => undefined, onBack = () => undefined, onSelectFolder = () => undefined, onToggleSettings = () => undefined }: AppRailProps) {
  return (
    <aside className="app-rail flex flex-col border-r border-border/70 bg-surface/35">
      <div className="flex h-20 items-center justify-center overflow-hidden px-2"><img src="/enter_logo.png" alt="Enter" className="h-4 w-[4.25rem] -rotate-90 object-contain brightness-0 invert" /></div>
      <ProfileSwitcher profiles={profiles} activeProfile={activeProfile} onSelect={onSelectProfile} onRemove={onRemoveProfile} onAdd={onAddProfile} />
      <div className="flex flex-col items-center gap-2 px-3 pt-1">
        <button type="button" className={cn("rail-button", activeFolder === "all" && !showSettings && "rail-button-active")} title="Все чаты" aria-label="Все чаты" onClick={() => { onSelectFolder("all"); onBack(); }}><Icon name="chat" className="size-5" /></button>
        {folders.map((folder) => <button key={folder} type="button" className={cn("rail-button", activeFolder === folder && !showSettings && "rail-button-active")} title={folder} aria-label={folder} onClick={() => { onSelectFolder(folder); onBack(); }}><Icon name="folder" className="size-5" /></button>)}
      </div>
      <div className="mt-auto flex flex-col items-center gap-2 p-3">
        <button type="button" className={cn("rail-button", showSettings && "rail-button-active")} title="Настройки" aria-label="Настройки" onClick={onToggleSettings}><Icon name="settings" className="size-5" /></button>
      </div>
    </aside>
  );
}
