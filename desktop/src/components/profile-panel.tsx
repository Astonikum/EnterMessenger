import type { Profile } from "../types";
import { Icon } from "./ui/icon";
import { ProfileAvatar } from "./ui/avatar";

type Props = {
  profile?: Profile;
  onClose?: () => void;
  onAddProfile?: () => void;
};

function serverAddress(profile: Profile) {
  return profile.server.replace(/^https?:\/\//, "");
}

function DetailRow({ icon, label, value }: { icon: string; label: string; value: string }) {
  return <div className="profile-detail-row"><span className="profile-detail-icon"><Icon name={icon} className="size-4" /></span><span className="min-w-0 flex-1"><span className="block text-xs text-muted-foreground">{label}</span><span className="mt-1 block truncate text-sm font-medium text-foreground">{value}</span></span></div>;
}

export function ProfilePanel({ profile, onClose = () => undefined, onAddProfile = () => undefined }: Props) {
  if (!profile) return null;

  return <div className="profile-workspace" role="region" aria-labelledby="profile-title">
    <aside className="profile-panel">
      <header className="profile-panel-header"><h2 id="profile-title" className="font-heading text-[1.1875rem] font-semibold tracking-tight">Профиль</h2><button type="button" className="icon-button" title="Закрыть профиль" aria-label="Закрыть профиль" onClick={onClose}><Icon name="close" className="size-4" /></button></header>
      <div className="profile-panel-content">
        <section className="profile-hero"><ProfileAvatar name={profile.name} size={88} /><div className="min-w-0"><h3 className="truncate font-heading text-2xl font-semibold tracking-tight text-foreground">{profile.name}</h3><p className="mt-1 truncate text-sm text-muted-foreground">@{profile.handle.replace(/^@/, "")}</p></div></section>
        <section className="profile-section"><h3>Данные профиля</h3><div className="profile-details"><DetailRow icon="person" label="Имя" value={profile.name} /><DetailRow icon="person" label="Логин" value={`@${profile.handle.replace(/^@/, "")}`} /><DetailRow icon="language" label="Сервер" value={serverAddress(profile)} /></div></section>
        <section className="profile-section"><h3>Управление</h3><button type="button" className="profile-action-row" onClick={onAddProfile}><span className="profile-detail-icon"><Icon name="person_add" className="size-4" /></span><span className="min-w-0 flex-1 text-left"><span className="block text-sm font-medium text-foreground">Добавить профиль</span></span><Icon name="chevron_right" className="size-4 text-muted-foreground" /></button></section>
      </div>
    </aside>
  </div>;
}
