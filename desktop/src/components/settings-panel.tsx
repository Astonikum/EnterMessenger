import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { changePassword as changeRemotePassword, getAccountSettings, getDevices, getSessions, revokeDevice, revokeOtherSessions, revokeSession, updateAccountSettings, type AccountSettings, type ManagedDevice, type ManagedSession } from "../lib/enter-api";
import type { AccentPreference, CachePolicy, DensityPreference, FontScale, LocalClientSettings, ThemePreference } from "../lib/local-settings";
import { Button } from "./ui/button";
import { Icon } from "./ui/icon";
import { Input } from "./ui/input";
import type { Profile } from "../types";

type SettingsSection = "account" | "security" | "notifications" | "appearance" | "privacy" | "storage" | "about";
type PendingAction = { kind: "device" | "session" | "other-sessions" | "outbox" | "profile"; targetId: string; label: string };
type Feedback = { kind: "success" | "error"; text: string } | null;

type SettingsPanelProps = {
  profile: Profile;
  localSettings: LocalClientSettings;
  messageCount: number;
  outboxCount: number;
  onLocalSettingsChange: (settings: LocalClientSettings) => void;
  onClearMessageCache: () => void;
  onClearOutbox: () => void;
  onRemoveProfile: (profile: Profile) => void | Promise<void>;
  onClose: () => void;
};

const sections: Array<{ id: SettingsSection; label: string; icon: string }> = [
  { id: "account", label: "Аккаунт", icon: "person" },
  { id: "security", label: "Безопасность и устройства", icon: "security" },
  { id: "notifications", label: "Уведомления", icon: "notifications" },
  { id: "appearance", label: "Внешний вид", icon: "tune" },
  { id: "privacy", label: "Приватность", icon: "security" },
  { id: "storage", label: "Данные и хранилище", icon: "database" },
  { id: "about", label: "О приложении", icon: "info" },
];

function formatDate(value: number | null | undefined, locale: string) {
  if (value === null || value === undefined) return "—";
  return new Intl.DateTimeFormat(locale === "en" ? "en" : "ru", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function formatBytes(value: number | undefined) {
  if (value === undefined || !Number.isFinite(value)) return "—";
  if (value < 1024) return `${Math.round(value)} Б`;
  const units = ["КБ", "МБ", "ГБ"];
  let amount = value;
  let unit = units[0];
  for (const nextUnit of units) {
    amount /= 1024;
    unit = nextUnit;
    if (amount < 1024 || nextUnit === units[units.length - 1]) break;
  }
  return `${amount.toFixed(amount >= 10 ? 0 : 1)} ${unit}`;
}

function FieldLabel({ children, htmlFor }: { children: string; htmlFor: string }) {
  return <label htmlFor={htmlFor} className="field-label">{children}</label>;
}

function ToggleRow({ id, label, description, checked, onChange }: { id: string; label: string; description: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <label htmlFor={id} className="settings-toggle-row">
      <span className="min-w-0 flex-1"><span className="block text-sm font-medium">{label}</span><span className="mt-1 block text-xs text-muted-foreground">{description}</span></span>
      <input id={id} type="checkbox" className="settings-toggle" checked={checked} onChange={(event) => onChange(event.target.checked)} />
    </label>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return <div className="settings-detail-row"><span className="text-xs text-muted-foreground">{label}</span><span className="min-w-0 truncate text-sm font-medium">{value}</span></div>;
}

function SettingsPanel({ profile, localSettings, messageCount, outboxCount, onLocalSettingsChange, onClearMessageCache, onClearOutbox, onRemoveProfile, onClose }: SettingsPanelProps) {
  const [section, setSection] = useState<SettingsSection>("account");
  const [account, setAccount] = useState<AccountSettings | null>(null);
  const [devices, setDevices] = useState<ManagedDevice[]>([]);
  const [sessions, setSessions] = useState<ManagedSession[]>([]);
  const [remoteLoading, setRemoteLoading] = useState(true);
  const [remoteError, setRemoteError] = useState("");
  const [name, setName] = useState(profile.name);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [passwordConfirmation, setPasswordConfirmation] = useState("");
  const [actionBusy, setActionBusy] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);
  const [storageEstimate, setStorageEstimate] = useState<StorageEstimate | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  const loadRemote = useCallback(async () => {
    setRemoteLoading(true);
    setRemoteError("");
    try {
      const [nextAccount, nextDevices, nextSessions] = await Promise.all([getAccountSettings(profile), getDevices(profile), getSessions(profile)]);
      setAccount(nextAccount);
      setName(nextAccount.name);
      setDevices(nextDevices);
      setSessions(nextSessions);
    } catch (reason) {
      setRemoteError(reason instanceof Error ? reason.message : "Не удалось загрузить настройки сервера");
    } finally {
      setRemoteLoading(false);
    }
  }, [profile]);

  const refreshStorage = useCallback(() => {
    if (!navigator.storage?.estimate) return;
    void navigator.storage.estimate().then(setStorageEstimate).catch(() => undefined);
  }, []);

  useEffect(() => { void loadRemote(); refreshStorage(); }, [loadRemote, refreshStorage]);

  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null;
    const dialog = dialogRef.current;
    const focusable = () => [...(dialog?.querySelectorAll<HTMLElement>("button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex=\"-1\"])") ?? [])];
    focusable()[0]?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); onClose(); return; }
      if (event.key !== "Tab") return;
      const elements = focusable();
      if (elements.length === 0) return;
      const first = elements[0];
      const last = elements[elements.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => { document.removeEventListener("keydown", handleKeyDown); previousFocus?.focus(); };
  }, [onClose]);

  function showSuccess(text: string) {
    setFeedback({ kind: "success", text });
  }

  function showError(reason: unknown, fallback: string) {
    setFeedback({ kind: "error", text: reason instanceof Error ? reason.message : fallback });
  }

  function updateLocal<K extends keyof LocalClientSettings>(key: K, value: LocalClientSettings[K]) {
    onLocalSettingsChange({ ...localSettings, [key]: value });
    showSuccess("Сохранено на этом устройстве");
  }

  async function saveAccount(event: FormEvent) {
    event.preventDefault();
    if (!name.trim()) { showError(null, "Имя не может быть пустым"); return; }
    setActionBusy("account");
    setFeedback(null);
    try {
      const next = await updateAccountSettings(profile, { name: name.trim() });
      setAccount((current) => current ? { ...current, ...next } : next);
      setName(next.name);
      showSuccess("Данные аккаунта сохранены");
    } catch (reason) {
      showError(reason, "Не удалось сохранить данные аккаунта");
    } finally {
      setActionBusy(null);
    }
  }

  async function savePrivacy() {
    if (!account) return;
    setActionBusy("privacy");
    setFeedback(null);
    try {
      const next = await updateAccountSettings(profile, {
        showOnline: account.showOnline,
        showLastSeen: account.showLastSeen,
        readReceipts: account.readReceipts,
        typingIndicators: account.typingIndicators,
      });
      setAccount(next);
      showSuccess("Настройки приватности сохранены");
    } catch (reason) {
      showError(reason, "Не удалось сохранить приватность");
    } finally {
      setActionBusy(null);
    }
  }

  async function submitPassword(event: FormEvent) {
    event.preventDefault();
    if (!currentPassword || !newPassword) { showError(null, "Заполните текущий и новый пароль"); return; }
    if (newPassword !== passwordConfirmation) { showError(null, "Новые пароли не совпадают"); return; }
    setActionBusy("password");
    setFeedback(null);
    try {
      await changeRemotePassword(profile, currentPassword, newPassword);
      setCurrentPassword("");
      setNewPassword("");
      setPasswordConfirmation("");
      showSuccess("Пароль изменён");
    } catch (reason) {
      showError(reason, "Не удалось изменить пароль");
    } finally {
      setActionBusy(null);
    }
  }

  function requestAction(action: PendingAction) {
    setPendingAction(action);
    setFeedback(null);
  }

  async function executePendingAction() {
    if (!pendingAction) return;
    const action = pendingAction;
    setActionBusy(action.kind);
    setFeedback(null);
    try {
      if (action.kind === "device") {
        await revokeDevice(profile, action.targetId);
        setDevices((current) => current.filter((device) => device.deviceId !== action.targetId));
        showSuccess("Устройство отозвано");
      } else if (action.kind === "session") {
        await revokeSession(profile, action.targetId);
        setSessions((current) => current.filter((session) => session.id !== action.targetId));
        showSuccess("Сессия отозвана");
      } else if (action.kind === "other-sessions") {
        await revokeOtherSessions(profile);
        setSessions((current) => current.filter((session) => session.current));
        showSuccess("Остальные сессии отозваны");
      } else if (action.kind === "outbox") {
        onClearOutbox();
        showSuccess("Очередь исходящих очищена");
        refreshStorage();
      } else {
        await onRemoveProfile(profile);
        setPendingAction(null);
        onClose();
        return;
      }
      setPendingAction(null);
    } catch (reason) {
      showError(reason, "Операция не выполнена");
    } finally {
      setActionBusy(null);
    }
  }

  function clearCache() {
    onClearMessageCache();
    showSuccess("Кэш сообщений очищен. Ключи E2E сохранены");
    refreshStorage();
  }

  function updatePrivacy(key: "showOnline" | "showLastSeen" | "readReceipts" | "typingIndicators", value: boolean) {
    setAccount((current) => current ? { ...current, [key]: value } : current);
  }

  function renderRemoteError() {
    return <div className="settings-error" role="alert"><Icon name="error" className="size-4 shrink-0" /><span className="min-w-0 flex-1">{remoteError}</span><Button variant="outline" size="sm" onClick={() => void loadRemote()}>Повторить</Button></div>;
  }

  function renderAccount() {
    return <section aria-labelledby="settings-account-title" className="settings-section-content">
      <div className="settings-section-heading"><div><p className="settings-eyebrow">Профиль</p><h2 id="settings-account-title">Аккаунт</h2><p>Основные данные аккаунта на домашнем сервере.</p></div></div>
      {remoteLoading ? <p className="settings-muted">Загрузка настроек сервера…</p> : remoteError ? renderRemoteError() : <>
        <form className="settings-card space-y-4" onSubmit={saveAccount}>
          <div><FieldLabel htmlFor="settings-name">Имя</FieldLabel><Input id="settings-name" value={name} onChange={(event) => setName(event.target.value)} autoComplete="name" maxLength={160} /></div>
          <div className="settings-detail-grid"><DetailRow label="Логин" value={`@${account?.handle ?? profile.handle.replace(/^@/, "")}`} /><DetailRow label="ID аккаунта" value={account?.id ?? profile.id} /><DetailRow label="Сервер" value={profile.server.replace(/^https?:\/\//, "")} /></div>
          <div className="flex justify-end"><Button type="submit" disabled={actionBusy === "account"}>{actionBusy === "account" ? "Сохранение…" : "Сохранить"}</Button></div>
        </form>
        <div className="settings-card"><h3>Текущий профиль</h3><p className="mt-1 text-sm text-muted-foreground">Локальная запись профиля связывает этот аккаунт с сервером и токеном входа.</p><DetailRow label="Устройство" value={profile.deviceId ?? "Не определено"} /></div>
      </>}
    </section>;
  }

  function renderSecurity() {
    return <section aria-labelledby="settings-security-title" className="settings-section-content">
      <div className="settings-section-heading"><div><p className="settings-eyebrow">Доступ</p><h2 id="settings-security-title">Безопасность и устройства</h2><p>Пароль, активные устройства и серверные сессии.</p></div><Button variant="outline" size="sm" onClick={() => void loadRemote()} disabled={remoteLoading}><Icon name="rotate_left" className="size-4" />Обновить</Button></div>
      <form className="settings-card space-y-4" onSubmit={submitPassword}><div><h3>Изменить пароль</h3><p className="mt-1 text-sm text-muted-foreground">Новый пароль применяется сервером. E2E-ключи остаются локальными.</p></div><div className="settings-form-grid"><div><FieldLabel htmlFor="settings-current-password">Текущий пароль</FieldLabel><Input id="settings-current-password" type="password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} autoComplete="current-password" /></div><div><FieldLabel htmlFor="settings-new-password">Новый пароль</FieldLabel><Input id="settings-new-password" type="password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} autoComplete="new-password" /></div><div><FieldLabel htmlFor="settings-confirm-password">Повторите новый пароль</FieldLabel><Input id="settings-confirm-password" type="password" value={passwordConfirmation} onChange={(event) => setPasswordConfirmation(event.target.value)} autoComplete="new-password" /></div></div><div className="flex justify-end"><Button type="submit" disabled={actionBusy === "password"}>{actionBusy === "password" ? "Изменение…" : "Изменить пароль"}</Button></div></form>
      {remoteLoading ? <p className="settings-muted">Загрузка устройств и сессий…</p> : remoteError ? renderRemoteError() : <>
        <div className="settings-card"><div className="mb-3 flex items-start justify-between gap-3"><div><h3>Устройства</h3><p className="mt-1 text-sm text-muted-foreground">Отзыв устройства завершает его серверные сессии. Текущее устройство отозвать здесь нельзя.</p></div></div><div className="settings-list">{devices.length === 0 ? <p className="settings-muted">Устройства не зарегистрированы.</p> : devices.map((device) => { const current = device.deviceId === profile.deviceId; return <div key={device.deviceId} className="settings-list-row"><span className="settings-list-icon"><Icon name="database" className="size-4" /></span><span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{device.name || device.platform || "Устройство"}{current && <span className="ml-2 rounded-full bg-primary/10 px-2 py-0.5 text-xs text-primary">Это устройство</span>}</span><span className="mt-1 block truncate text-xs text-muted-foreground">{device.deviceId} · последнее подключение {formatDate(device.lastSeenAt, localSettings.locale)}</span></span><Button variant="outline" size="sm" disabled={current || Boolean(device.revokedAt) || actionBusy === "device"} onClick={() => requestAction({ kind: "device", targetId: device.deviceId, label: `устройство «${device.name || device.deviceId}»` })}>{device.revokedAt ? "Отозвано" : "Отозвать"}</Button></div>; })}</div></div>
        <div className="settings-card"><div className="mb-3 flex items-start justify-between gap-3"><div><h3>Сессии</h3><p className="mt-1 text-sm text-muted-foreground">Текущая сессия защищена от случайного отзыва.</p></div><Button variant="outline" size="sm" disabled={sessions.filter((session) => !session.current).length === 0 || actionBusy === "other-sessions"} onClick={() => requestAction({ kind: "other-sessions", targetId: "all-other-sessions", label: "все остальные сессии" })}>Отозвать остальные</Button></div><div className="settings-list">{sessions.length === 0 ? <p className="settings-muted">Сессии не найдены.</p> : sessions.map((session) => <div key={session.id} className="settings-list-row"><span className="settings-list-icon"><Icon name="security" className="size-4" /></span><span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{session.deviceName || session.platform || "Сессия"}{session.current && <span className="ml-2 rounded-full bg-primary/10 px-2 py-0.5 text-xs text-primary">Текущая</span>}</span><span className="mt-1 block truncate text-xs text-muted-foreground">Создана {formatDate(session.createdAt, localSettings.locale)} · до {formatDate(session.expiresAt, localSettings.locale)}</span></span><Button variant="outline" size="sm" disabled={session.current || actionBusy === "session"} onClick={() => requestAction({ kind: "session", targetId: session.id, label: `сессию «${session.deviceName || session.id}»` })}>Отозвать</Button></div>)}</div></div>
      </>}
    </section>;
  }

  function renderNotifications() {
    return <section aria-labelledby="settings-notifications-title" className="settings-section-content"><div className="settings-section-heading"><div><p className="settings-eyebrow">Локально</p><h2 id="settings-notifications-title">Уведомления</h2><p>Эти параметры сохраняются только на этом устройстве.</p></div></div><div className="settings-card settings-list"><ToggleRow id="settings-desktop-notifications" label="Показывать уведомления" description="Разрешить системные уведомления о новых сообщениях." checked={localSettings.notifications.desktop} onChange={(checked) => updateLocal("notifications", { ...localSettings.notifications, desktop: checked })} /><ToggleRow id="settings-notification-sound" label="Звук уведомлений" description="Сохраняет предпочтение для звуковых уведомлений." checked={localSettings.notifications.sound} onChange={(checked) => updateLocal("notifications", { ...localSettings.notifications, sound: checked })} /><ToggleRow id="settings-notification-preview" label="Показывать текст сообщения" description="Использовать превью текста в уведомлении." checked={localSettings.notifications.preview} onChange={(checked) => updateLocal("notifications", { ...localSettings.notifications, preview: checked })} /></div></section>;
  }

  function renderAppearance() {
    return <section aria-labelledby="settings-appearance-title" className="settings-section-content"><div className="settings-section-heading"><div><p className="settings-eyebrow">Локально</p><h2 id="settings-appearance-title">Внешний вид</h2><p>Настройки интерфейса не отправляются на сервер.</p></div></div><div className="settings-card settings-form-grid"><div><FieldLabel htmlFor="settings-theme">Тема</FieldLabel><select id="settings-theme" className="settings-select" value={localSettings.theme} onChange={(event) => updateLocal("theme", event.target.value as ThemePreference)}><option value="system">Системная</option><option value="light">Светлая</option><option value="dark">Тёмная</option></select></div><div><FieldLabel htmlFor="settings-font-scale">Размер текста</FieldLabel><select id="settings-font-scale" className="settings-select" value={localSettings.fontScale} onChange={(event) => updateLocal("fontScale", Number(event.target.value) as FontScale)}><option value="0.9">Маленький</option><option value="1">Обычный</option><option value="1.1">Крупный</option></select></div><div><FieldLabel htmlFor="settings-density">Плотность</FieldLabel><select id="settings-density" className="settings-select" value={localSettings.density} onChange={(event) => updateLocal("density", event.target.value as DensityPreference)}><option value="comfortable">Комфортная</option><option value="compact">Компактная</option></select></div><div><FieldLabel htmlFor="settings-accent">Акцентный цвет</FieldLabel><select id="settings-accent" className="settings-select" value={localSettings.accent} onChange={(event) => updateLocal("accent", event.target.value as AccentPreference)}><option value="violet">Фиолетовый</option><option value="blue">Синий</option><option value="green">Зелёный</option><option value="rose">Розовый</option></select></div><div><FieldLabel htmlFor="settings-locale">Язык дат и интерфейса</FieldLabel><select id="settings-locale" className="settings-select" value={localSettings.locale} onChange={(event) => updateLocal("locale", event.target.value as "ru" | "en")}><option value="ru">Русский</option><option value="en">English</option></select></div><div><FieldLabel htmlFor="settings-cache-policy">Политика кэша</FieldLabel><select id="settings-cache-policy" className="settings-select" value={localSettings.cachePolicy} onChange={(event) => updateLocal("cachePolicy", event.target.value as CachePolicy)}><option value="standard">Стандартная</option><option value="minimal">Минимальная</option><option value="disabled">Отключён</option></select></div></div></section>;
  }

  function renderPrivacy() {
    if (remoteLoading) return <section aria-labelledby="settings-privacy-title" className="settings-section-content"><div className="settings-section-heading"><div><p className="settings-eyebrow">Сервер</p><h2 id="settings-privacy-title">Приватность</h2><p>Управление видимостью и статусами аккаунта.</p></div></div><p className="settings-muted">Загрузка настроек сервера…</p></section>;
    if (remoteError || !account) return <section aria-labelledby="settings-privacy-title" className="settings-section-content"><div className="settings-section-heading"><div><p className="settings-eyebrow">Сервер</p><h2 id="settings-privacy-title">Приватность</h2><p>Управление видимостью и статусами аккаунта.</p></div></div>{remoteError ? renderRemoteError() : <p className="settings-muted">Настройки недоступны.</p>}</section>;
    return <section aria-labelledby="settings-privacy-title" className="settings-section-content"><div className="settings-section-heading"><div><p className="settings-eyebrow">Сервер</p><h2 id="settings-privacy-title">Приватность</h2><p>Эти параметры синхронизируются с аккаунтом на домашнем сервере.</p></div></div><div className="settings-card settings-list"><ToggleRow id="settings-show-online" label="Показывать статус онлайн" description="Разрешить другим видеть, что вы сейчас в сети." checked={account.showOnline} onChange={(checked) => updatePrivacy("showOnline", checked)} /><ToggleRow id="settings-show-last-seen" label="Показывать время последнего посещения" description="Показывать время последней активности." checked={account.showLastSeen} onChange={(checked) => updatePrivacy("showLastSeen", checked)} /><ToggleRow id="settings-read-receipts" label="Отправлять отметки о прочтении" description="Сообщать собеседникам о прочтении сообщений." checked={account.readReceipts} onChange={(checked) => updatePrivacy("readReceipts", checked)} /><ToggleRow id="settings-typing-indicators" label="Показывать набор текста" description="Показывать, когда вы печатаете сообщение." checked={account.typingIndicators} onChange={(checked) => updatePrivacy("typingIndicators", checked)} /><div className="flex justify-end border-t border-border/70 pt-3"><Button onClick={() => void savePrivacy()} disabled={actionBusy === "privacy"}>{actionBusy === "privacy" ? "Сохранение…" : "Сохранить"}</Button></div></div></section>;
  }

  function renderStorage() {
    return <section aria-labelledby="settings-storage-title" className="settings-section-content"><div className="settings-section-heading"><div><p className="settings-eyebrow">Локально</p><h2 id="settings-storage-title">Данные и хранилище</h2><p>Очистка сообщений и очереди не удаляет приватные E2E-ключи.</p></div><Button variant="outline" size="sm" onClick={refreshStorage}><Icon name="rotate_left" className="size-4" />Обновить</Button></div><div className="settings-card"><h3>Состояние хранилища</h3><div className="settings-detail-grid mt-3"><DetailRow label="Используется приложением и браузером" value={formatBytes(storageEstimate?.usage)} /><DetailRow label="Доступный лимит" value={formatBytes(storageEstimate?.quota)} /><DetailRow label="Кэш сообщений" value={`${messageCount} сообщений`} /><DetailRow label="Очередь исходящих" value={`${outboxCount} сообщений`} /></div><p className="mt-3 text-xs text-muted-foreground">Размер оценивается для локального origin целиком и может включать данные других функций приложения.</p></div><div className="settings-card settings-danger-card"><h3>Очистка</h3><p className="mt-1 text-sm text-muted-foreground">Кэш можно очистить безопасно. Очистка исходящих удалит сообщения, которые ещё не отправлены.</p><div className="mt-4 flex flex-wrap gap-2"><Button variant="outline" onClick={clearCache}>Очистить кэш сообщений</Button><Button variant="outline" className="border-destructive/50 text-destructive hover:bg-destructive/10" disabled={outboxCount === 0 || actionBusy === "outbox"} onClick={() => requestAction({ kind: "outbox", targetId: "outbox", label: "очередь исходящих сообщений" })}>Очистить очередь</Button></div><p className="mt-3 text-xs text-muted-foreground">Токен, профиль и E2E-ключи сохраняются.</p></div><div className="settings-card settings-danger-card"><h3>Удалить локальный профиль</h3><p className="mt-1 text-sm text-muted-foreground">Удалит профиль, кэш, очередь и локальные ключи этого аккаунта. Удаление аккаунта на сервере не выполняется.</p><div className="mt-4 flex justify-end"><Button variant="outline" className="border-destructive/50 text-destructive hover:bg-destructive/10" onClick={() => requestAction({ kind: "profile", targetId: profile.id, label: `профиль «${profile.name}»` })}>Удалить профиль</Button></div></div></section>;
  }

  function renderAbout() {
    return <section aria-labelledby="settings-about-title" className="settings-section-content"><div className="settings-section-heading"><div><p className="settings-eyebrow">Enter Messenger</p><h2 id="settings-about-title">О приложении</h2><p>Безопасный мессенджер с E2E-шифрованием.</p></div></div><div className="settings-card settings-about-card"><div className="settings-about-mark"><img src="/enter_logo.png" alt="Enter" /></div><div><h3>Enter Messenger</h3><p className="mt-1 text-sm text-muted-foreground">Desktop · версия 0.2.0</p><p className="mt-4 text-sm text-muted-foreground">Серверные настройки и локальные параметры разделены. Приватные ключи хранятся отдельно и не попадают в settings API.</p></div></div></section>;
  }

  function renderSection() {
    if (section === "account") return renderAccount();
    if (section === "security") return renderSecurity();
    if (section === "notifications") return renderNotifications();
    if (section === "appearance") return renderAppearance();
    if (section === "privacy") return renderPrivacy();
    if (section === "storage") return renderStorage();
    return renderAbout();
  }

  return <div className="settings-overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div ref={dialogRef} className="settings-panel" role="dialog" aria-modal="true" aria-labelledby="settings-title">
      <header className="settings-panel-header"><div><p className="settings-eyebrow">Enter Messenger</p><h1 id="settings-title">Настройки</h1></div><button type="button" className="icon-button" title="Закрыть настройки" aria-label="Закрыть настройки" onClick={onClose}><Icon name="close" className="size-4" /></button></header>
      <div className="settings-panel-body"><nav className="settings-nav" aria-label="Разделы настроек">{sections.map((item) => <button key={item.id} type="button" className={item.id === section ? "settings-nav-item settings-nav-item-active" : "settings-nav-item"} aria-current={item.id === section ? "page" : undefined} onClick={() => setSection(item.id)}><Icon name={item.icon} className="size-4 shrink-0" /><span>{item.label}</span></button>)}</nav><div className="settings-main">{feedback && <div className={feedback.kind === "error" ? "settings-error settings-feedback" : "settings-success settings-feedback"} role={feedback.kind === "error" ? "alert" : "status"} aria-live="polite"><Icon name={feedback.kind === "error" ? "error" : "check_circle"} className="size-4 shrink-0" /><span>{feedback.text}</span></div>}{renderSection()}</div></div>
      {pendingAction && <div className="settings-confirm" role="alertdialog" aria-modal="true" aria-labelledby="settings-confirm-title"><div><h2 id="settings-confirm-title">Подтвердите действие</h2><p className="mt-1 text-sm text-muted-foreground">Вы действительно хотите: {pendingAction.label}? Это действие нельзя отменить.</p></div><div className="flex justify-end gap-2"><Button variant="outline" onClick={() => setPendingAction(null)} disabled={Boolean(actionBusy)}>Отмена</Button><Button className="bg-destructive text-destructive-foreground hover:bg-destructive/90" onClick={() => void executePendingAction()} disabled={Boolean(actionBusy)}>{actionBusy ? "Выполнение…" : "Подтвердить"}</Button></div></div>}
    </div>
  </div>;
}

export { SettingsPanel };
