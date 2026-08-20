import { useEffect, useRef } from "react";
import type { Profile } from "../types";
import { cn } from "../lib/utils";
import { ProfileAvatar } from "./ui/avatar";
import { ContextMenu } from "./ui/context-menu";
import { Icon } from "./ui/icon";

type ProfileSwitcherProps = {
  profiles: Profile[];
  activeProfile?: Profile;
  onSelect?: (profile: Profile) => void;
  onRemove?: (profile: Profile) => void | Promise<void>;
  onAdd?: () => void;
  className?: string;
};

// #preview ProfileSwitcher {"profiles":[{"id":"local","name":"Алексей","handle":"@alex","server":"http://localhost:50121","color":"#a98bff","token":"preview"}],"activeProfile":{"id":"local","name":"Алексей","handle":"@alex","server":"http://localhost:50121","color":"#a98bff","token":"preview"}}
export function ProfileSwitcher({ profiles, activeProfile, onSelect = () => undefined, onRemove = () => undefined, onAdd = () => undefined, className }: ProfileSwitcherProps) {
  const detailsRef = useRef<HTMLDetailsElement>(null);

  useEffect(() => {
    const closeOnOutsideClick = (event: PointerEvent) => {
      const details = detailsRef.current;
      if (details?.open && event.target instanceof Node && !details.contains(event.target)) details.open = false;
    };
    document.addEventListener("pointerdown", closeOnOutsideClick);
    return () => document.removeEventListener("pointerdown", closeOnOutsideClick);
  }, []);

  return (
    <div className={cn("relative px-2 py-3", className)}>
      <details ref={detailsRef} className="group">
        <summary aria-label={activeProfile?.name ?? "Профили"} className="flex cursor-pointer list-none justify-center rounded-xl p-1.5 hover:bg-accent">
          {activeProfile ? <ProfileAvatar name={activeProfile.name} size={34} /> : <span className="grid size-[2.125rem] place-items-center rounded-full border border-dashed border-border"><Icon name="add" className="size-4 text-muted-foreground" /></span>}
        </summary>
        <div className="profile-switcher-menu absolute left-[3.625rem] top-3 z-20 w-64 rounded-2xl border border-border bg-surface p-1.5 shadow-2xl shadow-black/30">
          {profiles.map((profile) => (
            <ContextMenu
              key={profile.id}
              items={[{ label: "Удалить профиль", icon: <Icon name="delete" className="size-4" />, destructive: true, onSelect: () => onRemove(profile) }]}
            >
              <button type="button" onClick={() => onSelect(profile)} className="flex w-full items-center gap-3 rounded-xl p-2 text-left hover:bg-accent">
                <ProfileAvatar name={profile.name} size={30} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{profile.name}</span>
                  <span className="block truncate text-xs text-muted-foreground">{profile.handle.replace(/^@/, "")}@{profile.server.replace(/^https?:\/\//, "")}</span>
                </span>
                {profile.id === activeProfile?.id && <Icon name="check" className="size-4 text-primary" />}
              </button>
            </ContextMenu>
          ))}
          <div className="my-1 border-t border-border" />
          <button onClick={onAdd} className="flex w-full items-center gap-3 rounded-xl p-2 text-left text-sm text-muted-foreground hover:bg-accent hover:text-foreground">
            <span className="grid size-[1.875rem] place-items-center rounded-full border border-dashed border-border"><Icon name="add" className="size-4" /></span>
            Добавить сервер
          </button>
        </div>
      </details>
    </div>
  );
}
