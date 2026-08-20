import { useEffect, useState } from "react";
import { Icon } from "./ui/icon";
import { readNotificationSettings, requestDesktopNotificationPermission, writeNotificationSettings, type NotificationSettings } from "../lib/notifications";

type SettingsCategoryId = "security" | "devices" | "notifications" | "storage" | "interface";

type SettingsCategory = {
  id: SettingsCategoryId;
  label: string;
  icon: string;
};

const categories: SettingsCategory[] = [
  { id: "security", label: "Безопасность", icon: "security" },
  { id: "devices", label: "Устройства", icon: "key" },
  { id: "notifications", label: "Уведомления", icon: "notifications" },
  { id: "storage", label: "Хранилище", icon: "database" },
  { id: "interface", label: "Интерфейс", icon: "tune" },
];

function ToggleRow({ label, description, checked, onChange }: { label: string; description: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <label className="settings-option">
      <span className="min-w-0 flex-1"><span className="block text-sm font-medium text-foreground">{label}</span><span className="mt-1 block text-xs leading-relaxed text-muted-foreground">{description}</span></span>
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} className="size-4 shrink-0 accent-primary" />
    </label>
  );
}

function StatusRow({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="settings-status-row">
      <span className="min-w-0 flex-1"><span className="block text-sm font-medium text-foreground">{label}</span><span className="mt-1 block text-xs text-muted-foreground">{detail}</span></span>
      <span className="shrink-0 rounded-full bg-primary/10 px-2.5 py-1 text-[0.6875rem] font-medium text-primary">{value}</span>
    </div>
  );
}

function SettingsContent({ category, notifications, setNotifications, interfaceSettings, setInterfaceSettings }: {
  category: SettingsCategory;
  notifications: { desktop: boolean; sound: boolean; preview: boolean };
  setNotifications: (value: { desktop: boolean; sound: boolean; preview: boolean }) => void;
  interfaceSettings: { animations: boolean; compact: boolean };
  setInterfaceSettings: (value: { animations: boolean; compact: boolean }) => void;
}) {
  if (category.id === "security") {
    return <div className="settings-content-stack"><div className="settings-status-card"><Icon name="security" className="size-5 text-primary" /><div><p className="text-sm font-semibold text-foreground">Сквозное шифрование включено</p><p className="mt-1 text-xs leading-relaxed text-muted-foreground">Ключи и содержимое сообщений используются только на устройствах участников диалога.</p></div></div></div>;
  }

  if (category.id === "devices") {
    return <div className="settings-content-stack"><div className="settings-section"><h4>Текущее устройство</h4><StatusRow label="Это устройство" value="Активно" detail="Сообщения синхронизируются с сервером" /></div><div className="settings-section"><h4>Другие устройства</h4><div className="settings-empty-row"><Icon name="key" className="size-4 text-muted-foreground" /><span className="text-sm text-muted-foreground">Других активных устройств нет</span></div></div></div>;
  }

  if (category.id === "notifications") {
    return <div className="settings-content-stack"><div className="settings-section"><h4>Оповещения</h4><ToggleRow label="Уведомления приложения" description="Показывать новые сообщения в системе" checked={notifications.desktop} onChange={(desktop) => setNotifications({ ...notifications, desktop })} /><ToggleRow label="Звук сообщений" description="Воспроизводить звук для новых сообщений" checked={notifications.sound} onChange={(sound) => setNotifications({ ...notifications, sound })} /><ToggleRow label="Предпросмотр текста" description="Показывать текст сообщения в уведомлении" checked={notifications.preview} onChange={(preview) => setNotifications({ ...notifications, preview })} /></div></div>;
  }

  if (category.id === "storage") {
    return <div className="settings-content-stack"><div className="settings-section"><h4>Данные приложения</h4><StatusRow label="Кэш сообщений" value="Включён" detail="Последние сообщения доступны без ожидания синхронизации" /><StatusRow label="Синхронизация" value="Автоматически" detail="Изменения проверяются при подключении к серверу" /></div></div>;
  }

  return <div className="settings-content-stack"><div className="settings-section"><h4>Внешний вид</h4><ToggleRow label="Микроанимации" description="Плавные переходы между состояниями интерфейса" checked={interfaceSettings.animations} onChange={(animations) => setInterfaceSettings({ ...interfaceSettings, animations })} /><ToggleRow label="Компактный список" description="Уменьшить расстояние между чатами" checked={interfaceSettings.compact} onChange={(compact) => setInterfaceSettings({ ...interfaceSettings, compact })} /></div></div>;
}

// #preview SettingsPanel {}
export function SettingsPanel({ onClose = () => undefined }: { onClose?: () => void }) {
  const [activeCategory, setActiveCategory] = useState<SettingsCategoryId>("security");
  const [notifications, setNotifications] = useState<NotificationSettings>(readNotificationSettings);
  const [interfaceSettings, setInterfaceSettings] = useState({ animations: true, compact: false });
  const category = categories.find((item) => item.id === activeCategory) ?? categories[0];

  useEffect(() => {
    writeNotificationSettings(notifications);
    if (notifications.desktop) void requestDesktopNotificationPermission();
  }, [notifications]);

  function selectCategory(id: SettingsCategoryId) {
    setActiveCategory(id);
  }

  return (
    <div className="app-settings-overlay" role="dialog" aria-modal="true" aria-labelledby="settings-title" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <aside className="app-settings-panel">
        <header className="settings-panel-header">
          <div className="settings-desktop-header"><button type="button" className="settings-close-button icon-button shrink-0" title="Закрыть настройки" aria-label="Закрыть настройки" onClick={onClose}><Icon name="close" className="size-4" /></button></div>
        </header>
        <div className="settings-layout">
          <nav className="settings-categories" aria-label="Категории настроек">
            <div className="space-y-1">{categories.map((item) => <button key={item.id} type="button" className={`settings-row ${activeCategory === item.id ? "settings-row-active" : ""}`} onClick={() => selectCategory(item.id)}><Icon name={item.icon} className="size-4" /><span className="min-w-0"><span className="block truncate">{item.label}</span></span></button>)}</div>
          </nav>
          <section className="settings-content" aria-label={category.label}><div className="mb-6"><h3 id="settings-title" className="font-heading text-2xl font-semibold tracking-tight">{category.label}</h3></div><SettingsContent category={category} notifications={notifications} setNotifications={setNotifications} interfaceSettings={interfaceSettings} setInterfaceSettings={setInterfaceSettings} /></section>
        </div>
      </aside>
    </div>
  );
}
