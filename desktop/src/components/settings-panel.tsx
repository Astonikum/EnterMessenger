import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { blockAccount as blockRemoteAccount, changePassword as changeRemotePassword, deleteAccount as deleteRemoteAccount, getAccountSettings, getBlacklist, getDevices, getSessions, refreshSessionMetadata, revokeDevice, revokeOtherSessions, revokeSession, unblockAccount as unblockRemoteAccount, updateAccountSettings, type AccountSettings, type BlockedAccount, type ManagedDevice, type ManagedSession } from "../lib/enter-api";
import type { AccentPreference, CachePolicy, CallDataSaving, ChatListLayout, DensityPreference, FontScale, LocalClientSettings, ProxyProtocol, ThemePreference } from "../lib/local-settings";
import { Button } from "./ui/button";
import { Icon } from "./ui/icon";
import { Input } from "./ui/input";
import { MessageList } from "./message-list";
import type { Profile } from "../types";
import { friendlyError } from "../lib/client-errors";
import { CURRENT_VERSION, fetchLatestRelease, isNewerVersion, type PlatformRelease } from "../lib/github-releases";

type SettingsSection = "password" | "security" | "notifications" | "appearance" | "privacy" | "storage" | "energy" | "updates";
type PendingAction = { kind: "device" | "session" | "other-sessions" | "outbox" | "profile" | "account"; targetId: string; label: string };
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
  { id: "appearance", label: "Чаты", icon: "tune" },
  { id: "password", label: "Пароль", icon: "key" },
  { id: "security", label: "Безопасность и устройства", icon: "security" },
  { id: "notifications", label: "Уведомления", icon: "notifications" },
  { id: "privacy", label: "Приватность", icon: "security" },
  { id: "storage", label: "Данные и хранилище", icon: "database" },
  { id: "energy", label: "Энергосбережение", icon: "bolt" },
  { id: "updates", label: "Обновления", icon: "download" },
];

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

function knownValue(value: string | null | undefined) {
  const normalized = value?.trim();
  return normalized && normalized.toLowerCase() !== "unknown" ? normalized : undefined;
}

function shortId(value: string | null | undefined) {
  return value ? value.slice(0, 8) : "—";
}

function formatSessionDate(value: number | null | undefined) {
  return value && Number.isFinite(value)
    ? new Intl.DateTimeFormat("ru-RU", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value))
    : "—";
}

function formatReleaseDate(value: string | null) {
  return value ? new Intl.DateTimeFormat("ru-RU", { dateStyle: "medium" }).format(new Date(value)) : "дата не указана";
}

function deviceTitle(device: ManagedDevice) {
  return knownValue(device.name) || `Устройство ${shortId(device.deviceId)}`;
}

function deviceDetails(device: ManagedDevice) {
  return [
    knownValue(device.platform) || "Платформа не указана",
    knownValue(device.appVersion) ? `версия ${knownValue(device.appVersion)}` : undefined,
    `ID ${shortId(device.deviceId)}`,
    `активно ${formatSessionDate(device.lastSeenAt ?? device.createdAt)}`,
  ].filter(Boolean).join(" · ");
}

function sessionTitle(session: ManagedSession) {
  return knownValue(session.deviceName) || `Устройство ${shortId(session.deviceId || session.id)}`;
}

function sessionDetails(session: ManagedSession) {
  return [
    knownValue(session.platform) || "Платформа не указана",
    knownValue(session.appVersion) ? `версия ${knownValue(session.appVersion)}` : undefined,
    session.deviceId ? `ID ${shortId(session.deviceId)}` : `сессия ${shortId(session.id)}`,
    `создана ${formatSessionDate(session.createdAt)}`,
    `активна ${formatSessionDate(session.lastSeenAt ?? session.createdAt)}`,
    session.current ? "текущая" : `до ${formatSessionDate(session.expiresAt)}`,
  ].filter(Boolean).join(" · ");
}

function FieldLabel({ children, htmlFor, description }: { children: string; htmlFor: string; description?: string }) {
  return <label htmlFor={htmlFor} className="field-label"><span>{children}</span>{description && <span className="mt-1 block text-xs font-normal leading-5 text-muted-foreground">{description}</span>}</label>;
}

function ToggleRow({ id, label, description, checked, onChange }: { id: string; label: string; description?: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <label htmlFor={id} className="settings-toggle-row">
      <span className="min-w-0 flex-1"><span className="block text-sm font-medium">{label}</span>{description && <span className="mt-1 block text-xs leading-5 text-muted-foreground">{description}</span>}</span>
      <input id={id} type="checkbox" className="settings-toggle" checked={checked} onChange={(event) => onChange(event.target.checked)} />
    </label>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return <div className="settings-detail-row"><span className="text-xs text-muted-foreground">{label}</span><span className="min-w-0 truncate text-sm font-medium">{value}</span></div>;
}

function RangeRow({ id, label, description, value, min, max, onChange, suffix = "" }: { id: string; label: string; description: string; value: number; min: number; max: number; onChange: (value: number) => void; suffix?: string }) {
  return <div className="settings-range-row"><div className="min-w-0"><span className="block text-sm font-medium">{label}</span><span className="mt-1 block text-xs leading-5 text-muted-foreground">{description}</span></div><div className="settings-range-control"><input id={id} type="range" min={min} max={max} step="1" value={value} onChange={(event) => onChange(Number(event.target.value))} aria-label={label} /><output htmlFor={id}>{value}{suffix}</output></div></div>;
}

function SettingsPanel({ profile, localSettings, messageCount, outboxCount, onLocalSettingsChange, onClearMessageCache, onClearOutbox, onRemoveProfile, onClose }: SettingsPanelProps) {
  const [section, setSection] = useState<SettingsSection>("password");
  const [account, setAccount] = useState<AccountSettings | null>(null);
  const [devices, setDevices] = useState<ManagedDevice[]>([]);
  const [sessions, setSessions] = useState<ManagedSession[]>([]);
  const [blocked, setBlocked] = useState<BlockedAccount[]>([]);
  const [blockedAddress, setBlockedAddress] = useState("");
  const [remoteLoading, setRemoteLoading] = useState(true);
  const [remoteError, setRemoteError] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [passwordConfirmation, setPasswordConfirmation] = useState("");
  const [actionBusy, setActionBusy] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);
  const [storageEstimate, setStorageEstimate] = useState<StorageEstimate | null>(null);
  const [updateState, setUpdateState] = useState<{ loading: boolean; error: string; release: PlatformRelease | null; checkedAt: number | null }>({ loading: false, error: "", release: null, checkedAt: null });
  const [updateRefreshKey, setUpdateRefreshKey] = useState(0);
  const privacyRevisionRef = useRef(0);
  const privacyWriteRef = useRef(Promise.resolve());
  const loadRemote = useCallback(async () => {
    setRemoteLoading(true);
    setRemoteError("");
    try {
      await refreshSessionMetadata(profile).catch(() => undefined);
      const [nextAccount, nextDevices, nextSessions, nextBlocked] = await Promise.all([getAccountSettings(profile), getDevices(profile), getSessions(profile), getBlacklist(profile)]);
      setAccount(nextAccount);
      setDevices(nextDevices);
      setSessions(nextSessions);
      setBlocked(nextBlocked);
    } catch (reason) {
      setRemoteError(friendlyError(reason, "Не удалось загрузить настройки сервера"));
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
    if (section !== "updates") return;
    const controller = new AbortController();
    setUpdateState((current) => ({ ...current, loading: true, error: "" }));
    void fetchLatestRelease("desktop", controller.signal)
      .then((release) => setUpdateState({ loading: false, error: "", release, checkedAt: Date.now() }))
      .catch((reason: unknown) => {
        if (reason instanceof Error && reason.name === "AbortError") return;
        setUpdateState({ loading: false, error: friendlyError(reason, "Не удалось проверить релизы GitHub"), release: null, checkedAt: Date.now() });
      });
    return () => controller.abort();
  }, [section, updateRefreshKey]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); onClose(); }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  function showSuccess(text: string) {
    setFeedback({ kind: "success", text });
  }

  function showError(reason: unknown, fallback: string) {
    setFeedback({ kind: "error", text: friendlyError(reason, fallback) });
  }

  function updateLocal<K extends keyof LocalClientSettings>(key: K, value: LocalClientSettings[K]) {
    onLocalSettingsChange({ ...localSettings, [key]: value });
    setFeedback(null);
  }

  function savePrivacy(next: AccountSettings) {
    const revision = ++privacyRevisionRef.current;
    privacyWriteRef.current = privacyWriteRef.current.catch(() => undefined).then(async () => {
      try {
        const saved = await updateAccountSettings(profile, {
          showOnline: next.showOnline,
          showLastSeen: next.showLastSeen,
          readReceipts: next.readReceipts,
          typingIndicators: next.typingIndicators,
          showPhone: next.showPhone,
          showProfilePhoto: next.showProfilePhoto,
          allowForwarding: next.allowForwarding,
          allowCalls: next.allowCalls,
          suggestPeople: next.suggestPeople,
        });
        if (revision === privacyRevisionRef.current) setAccount(saved);
      } catch (reason) {
        if (revision === privacyRevisionRef.current) showError(reason, "Не удалось сохранить приватность");
      }
    });
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
      } else if (action.kind === "account") {
        await deleteRemoteAccount(profile);
        await onRemoveProfile(profile);
        setPendingAction(null);
        onClose();
        return;
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
    showSuccess("Кэш сообщений очищен");
    refreshStorage();
  }

  function updatePrivacy(key: "showOnline" | "showLastSeen" | "readReceipts" | "typingIndicators" | "showPhone" | "showProfilePhoto" | "allowForwarding" | "allowCalls" | "suggestPeople", value: boolean) {
    if (!account) return;
    const next = { ...account, [key]: value };
    setAccount(next);
    setFeedback(null);
    savePrivacy(next);
  }

  async function addBlockedAccount(event: FormEvent) {
    event.preventDefault();
    const address = blockedAddress.trim();
    if (!address) return;
    setActionBusy("blacklist");
    try {
      const entry = await blockRemoteAccount(profile, address);
      setBlocked((current) => [entry, ...current.filter((item) => item.address !== entry.address)]);
      setBlockedAddress("");
      showSuccess("Пользователь добавлен в чёрный список");
    } catch (reason) {
      showError(reason, "Не удалось заблокировать пользователя");
    } finally {
      setActionBusy(null);
    }
  }

  async function removeBlockedAccount(entry: BlockedAccount) {
    setActionBusy(`blacklist:${entry.id}`);
    try {
      await unblockRemoteAccount(profile, entry.id);
      setBlocked((current) => current.filter((item) => item.id !== entry.id));
      showSuccess("Пользователь удалён из чёрного списка");
    } catch (reason) {
      showError(reason, "Не удалось снять блокировку");
    } finally {
      setActionBusy(null);
    }
  }

  function renderRemoteError() {
    return <div className="settings-error" role="alert"><Icon name="error" className="size-4 shrink-0" /><span className="min-w-0 flex-1">{remoteError}</span><Button variant="outline" size="sm" onClick={() => void loadRemote()}>Повторить</Button></div>;
  }

  function renderPassword() {
    return <section aria-labelledby="settings-password-title" className="settings-section-content">
      <div className="settings-section-heading"><div><h2 id="settings-password-title">Пароль</h2></div></div>
      <form className="settings-card space-y-4" onSubmit={submitPassword}><div><h3>Изменить пароль</h3></div><div className="settings-form-grid"><div><FieldLabel htmlFor="settings-current-password">Текущий пароль</FieldLabel><Input id="settings-current-password" type="password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} autoComplete="current-password" /></div><div><FieldLabel htmlFor="settings-new-password">Новый пароль</FieldLabel><Input id="settings-new-password" type="password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} autoComplete="new-password" /></div><div><FieldLabel htmlFor="settings-confirm-password">Повторите новый пароль</FieldLabel><Input id="settings-confirm-password" type="password" value={passwordConfirmation} onChange={(event) => setPasswordConfirmation(event.target.value)} autoComplete="new-password" /></div></div><div className="flex justify-end"><Button type="submit" disabled={actionBusy === "password"}>{actionBusy === "password" ? "Изменение…" : "Изменить пароль"}</Button></div></form>
    </section>;
  }

  function renderSecurity() {
    return <section aria-labelledby="settings-security-title" className="settings-section-content">
      <div className="settings-section-heading"><div><h2 id="settings-security-title">Безопасность и устройства</h2></div><Button variant="outline" size="sm" onClick={() => void loadRemote()} disabled={remoteLoading}><Icon name="rotate_left" className="size-4" />Обновить</Button></div>
      {remoteLoading ? <p className="settings-muted">Загрузка устройств и сессий…</p> : remoteError ? renderRemoteError() : <>
        <div className="settings-card"><div className="mb-3 flex items-start justify-between gap-3"><h3>Устройства</h3></div><div className="settings-list">{devices.length === 0 ? <p className="settings-muted">Устройства не зарегистрированы.</p> : devices.map((device) => { const current = device.current || device.deviceId === profile.deviceId; return <div key={device.deviceId} className="settings-list-row"><span className="settings-list-icon"><Icon name="database" className="size-4" /></span><span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{deviceTitle(device)}</span><span className="mt-1 block text-xs leading-5 text-muted-foreground">{deviceDetails(device)}{current ? " · это устройство" : ""}</span></span><Button variant="outline" size="sm" disabled={current || Boolean(device.revokedAt) || actionBusy === "device"} onClick={() => requestAction({ kind: "device", targetId: device.deviceId, label: `устройство «${deviceTitle(device)}»` })}>{device.revokedAt ? "Отозвано" : "Отозвать"}</Button></div>; })}</div></div>
        <div className="settings-card"><div className="mb-3 flex items-start justify-between gap-3"><h3>Сессии</h3><Button variant="outline" size="sm" disabled={sessions.filter((session) => !session.current).length === 0 || actionBusy === "other-sessions"} onClick={() => requestAction({ kind: "other-sessions", targetId: "all-other-sessions", label: "все остальные сессии" })}>Отозвать остальные</Button></div><div className="settings-list">{sessions.length === 0 ? <p className="settings-muted">Сессии не найдены.</p> : sessions.map((session) => <div key={session.id} className="settings-list-row"><span className="settings-list-icon"><Icon name="security" className="size-4" /></span><span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{sessionTitle(session)}</span><span className="mt-1 block text-xs leading-5 text-muted-foreground">{sessionDetails(session)}</span></span><Button variant="outline" size="sm" disabled={session.current || actionBusy === "session"} onClick={() => requestAction({ kind: "session", targetId: session.id, label: `сессию «${sessionTitle(session)}»` })}>Отозвать</Button></div>)}</div></div>
      </>}
    </section>;
  }

  function renderNotifications() {
    const toggle = (key: keyof LocalClientSettings["notifications"], label: string, description = "") => <ToggleRow id={`settings-notification-${String(key)}`} label={label} description={description} checked={localSettings.notifications[key] as boolean} onChange={(checked) => updateLocal("notifications", { ...localSettings.notifications, [key]: checked })} />;
    return <section aria-labelledby="settings-notifications-title" className="settings-section-content"><div className="settings-section-heading"><div><h2 id="settings-notifications-title">Уведомления и звуки</h2></div></div><div className="settings-card settings-list"><h3>Показывать уведомления</h3>{toggle("desktop", "Всех аккаунтов", "Показывать новые сообщения в системе")}{toggle("allAccounts", "Все аккаунты")}{toggle("privateChats", "Личные чаты")}{toggle("groups", "Группы")}{toggle("channels", "Каналы")}{toggle("stories", "Истории")}{toggle("reactions", "Реакции")}</div><div className="settings-card settings-list"><h3>Счётчик сообщений</h3>{toggle("showCounter", "Показывать счётчик")}{toggle("mutedChats", "Чаты без уведомлений")}</div><div className="settings-card settings-list"><h3>В приложении</h3>{toggle("sound", "Звук уведомлений")}{toggle("inAppSound", "Звук в чате")}{toggle("inAppVibration", "Вибросигнал")}{toggle("preview", "Показывать текст")}{toggle("inAppPreview", "Предпросмотр текста")}{toggle("popups", "Всплывающие окна")}</div><div className="settings-card settings-list"><h3>События</h3>{toggle("contactJoined", "Контакт присоединился")}{toggle("pinnedMessages", "Закреплённые сообщения")}</div><div className="settings-card settings-list"><h3>Другое</h3>{toggle("restartOnClose", "Перезапуск при закрытии")}{toggle("backgroundConnection", "Фоновое соединение")}<div className="settings-list-row"><span className="min-w-0 flex-1"><span className="block text-sm font-medium">Повтор уведомлений</span><span className="mt-1 block text-xs leading-5 text-muted-foreground">Период повторного напоминания</span></span><select className="settings-select w-auto" value={localSettings.notifications.repeatInterval} onChange={(event) => updateLocal("notifications", { ...localSettings.notifications, repeatInterval: Number(event.target.value) as 0 | 60 | 300 | 3600 })}><option value="0">Никогда</option><option value="60">1 минута</option><option value="300">5 минут</option><option value="3600">1 час</option></select></div></div></section>;
  }

  function renderAppearance() {
    return <section aria-labelledby="settings-chats-title" className="settings-section-content"><div className="settings-section-heading"><div><h2 id="settings-chats-title">Чаты</h2></div></div><div className="settings-card"><h3>Предпросмотр</h3><div className="settings-chat-preview" style={{ fontSize: `${localSettings.messageTextSize}px` }}><div className="settings-preview-list-row"><span className="settings-preview-avatar">A</span><span><strong>Alexander</strong><small>Доброе утро!</small>{localSettings.chatListLayout === "three-line" && <small>В сети</small>}</span></div><div className="settings-preview-messages"><MessageList messages={[{ id: "settings-preview-in", author: "them", text: "Доброе утро! 👋", time: "14:08" }, { id: "settings-preview-out", author: "me", text: "В Токио утро 😎", time: "14:23" }]} /></div></div></div><div className="settings-card settings-form-grid"><div><FieldLabel htmlFor="settings-theme" description="Системная, светлая или тёмная тема">Тема</FieldLabel><select id="settings-theme" className="settings-select" value={localSettings.theme} onChange={(event) => updateLocal("theme", event.target.value as ThemePreference)}><option value="system">Системная</option><option value="light">Светлая</option><option value="dark">Тёмная</option></select></div><div><FieldLabel htmlFor="settings-font-scale" description="Размер текста в чатах">Размер текста интерфейса</FieldLabel><select id="settings-font-scale" className="settings-select" value={localSettings.fontScale} onChange={(event) => updateLocal("fontScale", Number(event.target.value) as FontScale)}><option value="0.9">Маленький</option><option value="1">Обычный</option><option value="1.1">Крупный</option></select></div><div><FieldLabel htmlFor="settings-density" description="Расстояние между элементами интерфейса">Плотность</FieldLabel><select id="settings-density" className="settings-select" value={localSettings.density} onChange={(event) => updateLocal("density", event.target.value as DensityPreference)}><option value="comfortable">Комфортная</option><option value="compact">Компактная</option></select></div><div><FieldLabel htmlFor="settings-accent" description="Цвет кнопок и выделения">Акцентный цвет</FieldLabel><select id="settings-accent" className="settings-select" value={localSettings.accent} onChange={(event) => updateLocal("accent", event.target.value as AccentPreference)}><option value="violet">Фиолетовый</option><option value="blue">Синий</option><option value="green">Зелёный</option><option value="rose">Розовый</option></select></div><div><FieldLabel htmlFor="settings-locale" description="Язык интерфейса и дат">Язык дат и интерфейса</FieldLabel><select id="settings-locale" className="settings-select" value={localSettings.locale} onChange={(event) => updateLocal("locale", event.target.value as "ru" | "en")}><option value="ru">Русский</option><option value="en">English</option></select></div><div><FieldLabel htmlFor="settings-chat-list-layout" description="Количество строк в превью одного диалога">Список чатов</FieldLabel><select id="settings-chat-list-layout" className="settings-select" value={localSettings.chatListLayout} onChange={(event) => updateLocal("chatListLayout", event.target.value as ChatListLayout)}><option value="two-line">Двухстрочный</option><option value="three-line">Трёхстрочный</option></select></div></div><div className="settings-card settings-range-list"><RangeRow id="settings-message-text-size" label="Размер текста сообщений" description="Размер текста внутри пузырей сообщений" value={localSettings.messageTextSize} min={14} max={22} suffix=" px" onChange={(value) => updateLocal("messageTextSize", value)} /><RangeRow id="settings-bubble-radius" label="Скругление пузырей" description="Радиус углов блоков сообщений" value={localSettings.bubbleRadius} min={6} max={22} suffix=" px" onChange={(value) => updateLocal("bubbleRadius", value)} /></div></section>;
  }

  function renderPrivacy() {
    if (remoteLoading) return <section aria-labelledby="settings-privacy-title" className="settings-section-content"><div className="settings-section-heading"><div><h2 id="settings-privacy-title">Приватность</h2></div></div><p className="settings-muted">Загрузка настроек сервера…</p></section>;
    if (remoteError || !account) return <section aria-labelledby="settings-privacy-title" className="settings-section-content"><div className="settings-section-heading"><div><h2 id="settings-privacy-title">Приватность</h2></div></div>{remoteError ? renderRemoteError() : <p className="settings-muted">Настройки недоступны.</p>}</section>;
    return <section aria-labelledby="settings-privacy-title" className="settings-section-content"><div className="settings-section-heading"><div><h2 id="settings-privacy-title">Приватность</h2><p className="settings-muted mt-1">Правила применяются на сервере и синхронизируются между устройствами.</p></div></div><div className="settings-card settings-list"><h3>Безопасность и видимость</h3><ToggleRow id="settings-show-online" label="Показывать статус онлайн" description="Показывать собеседникам, что вы активны" checked={account.showOnline} onChange={(checked) => updatePrivacy("showOnline", checked)} /><ToggleRow id="settings-show-last-seen" label="Показывать время последнего посещения" description="Показывать время последней активности" checked={account.showLastSeen} onChange={(checked) => updatePrivacy("showLastSeen", checked)} /><ToggleRow id="settings-show-phone" label="Показывать номер телефона" description="Разрешать отображение номера в профиле" checked={account.showPhone} onChange={(checked) => updatePrivacy("showPhone", checked)} /><ToggleRow id="settings-show-profile-photo" label="Фотографии профиля" description="Кто может видеть фотографии профиля" checked={account.showProfilePhoto} onChange={(checked) => updatePrivacy("showProfilePhoto", checked)} /><ToggleRow id="settings-allow-forwarding" label="Пересылка сообщений" description="Разрешать пересылку сообщений от вас" checked={account.allowForwarding} onChange={(checked) => updatePrivacy("allowForwarding", checked)} /><ToggleRow id="settings-allow-calls" label="Звонки" description="Разрешать входящие звонки" checked={account.allowCalls} onChange={(checked) => updatePrivacy("allowCalls", checked)} /><ToggleRow id="settings-suggest-people" label="Подсказка людей при поиске" description="Показывать часто используемые контакты в поиске" checked={account.suggestPeople} onChange={(checked) => updatePrivacy("suggestPeople", checked)} /><ToggleRow id="settings-read-receipts" label="Отправлять отметки о прочтении" description="Показывать собеседникам, что сообщение прочитано" checked={account.readReceipts} onChange={(checked) => updatePrivacy("readReceipts", checked)} /><ToggleRow id="settings-typing-indicators" label="Показывать набор текста" description="Показывать, когда вы печатаете" checked={account.typingIndicators} onChange={(checked) => updatePrivacy("typingIndicators", checked)} /></div><div className="settings-card settings-list"><h3>Чёрный список</h3><form className="flex gap-2 border-b border-border/70 pb-3" onSubmit={addBlockedAccount}><Input aria-label="Enter-адрес для блокировки" placeholder="handle@server" value={blockedAddress} onChange={(event) => setBlockedAddress(event.target.value)} /><Button type="submit" disabled={!blockedAddress.trim() || actionBusy === "blacklist"}>Добавить</Button></form>{blocked.length === 0 ? <p className="settings-muted mt-3">Заблокированных пользователей нет.</p> : blocked.map((entry) => <div key={entry.id} className="settings-list-row"><span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{entry.name}</span><span className="mt-1 block truncate text-xs text-muted-foreground">{entry.address}</span></span><Button variant="outline" size="sm" disabled={actionBusy === `blacklist:${entry.id}`} onClick={() => void removeBlockedAccount(entry)}>Разблокировать</Button></div>)}</div></section>;
  }

  function renderStorage() {
    const media = localSettings.media;
    const auto = media.autoDownload;
    return <section aria-labelledby="settings-storage-title" className="settings-section-content"><div className="settings-section-heading"><div><h2 id="settings-storage-title">Данные и хранилище</h2></div><Button variant="outline" size="sm" onClick={refreshStorage}><Icon name="rotate_left" className="size-4" />Обновить</Button></div><div className="settings-card"><h3>Использование сети и кэша</h3><div className="settings-detail-grid mt-3"><DetailRow label="Используется" value={formatBytes(storageEstimate?.usage)} /><DetailRow label="Лимит" value={formatBytes(storageEstimate?.quota)} /><DetailRow label="Кэш сообщений" value={`${messageCount} сообщений`} /><DetailRow label="Очередь исходящих" value={`${outboxCount} сообщений`} /></div><div className="mt-4"><FieldLabel htmlFor="settings-cache-policy" description="Отключённая политика не сохраняет сообщения между запусками">Политика кэша</FieldLabel><select id="settings-cache-policy" className="settings-select mt-2" value={localSettings.cachePolicy} onChange={(event) => updateLocal("cachePolicy", event.target.value as CachePolicy)}><option value="standard">Стандартная</option><option value="minimal">Минимальная</option><option value="disabled">Отключена</option></select></div></div><div className="settings-card settings-list"><h3>Автозагрузка медиа</h3><ToggleRow id="settings-autodownload-cellular" label="Через мобильную сеть" description="Фото, видео и файлы в пределах лимитов" checked={auto.cellular} onChange={(checked) => updateLocal("media", { ...media, autoDownload: { ...auto, cellular: checked } })} /><ToggleRow id="settings-autodownload-wifi" label="Через сети Wi‑Fi" description="Разрешить автоматическую загрузку по Wi‑Fi" checked={auto.wifi} onChange={(checked) => updateLocal("media", { ...media, autoDownload: { ...auto, wifi: checked } })} /><ToggleRow id="settings-autodownload-roaming" label="В роуминге" description="Разрешить загрузку в роуминге" checked={auto.roaming} onChange={(checked) => updateLocal("media", { ...media, autoDownload: { ...auto, roaming: checked } })} /><RangeRow id="settings-photo-limit" label="Лимит фото" description="Максимальный размер автозагрузки" value={auto.photoLimitMb} min={1} max={100} suffix=" МБ" onChange={(value) => updateLocal("media", { ...media, autoDownload: { ...auto, photoLimitMb: value } })} /><RangeRow id="settings-video-limit" label="Лимит видео" description="Максимальный размер автозагрузки" value={auto.videoLimitMb} min={1} max={500} suffix=" МБ" onChange={(value) => updateLocal("media", { ...media, autoDownload: { ...auto, videoLimitMb: value } })} /><RangeRow id="settings-file-limit" label="Лимит файлов" description="Максимальный размер автозагрузки" value={auto.fileLimitMb} min={1} max={100} suffix=" МБ" onChange={(value) => updateLocal("media", { ...media, autoDownload: { ...auto, fileLimitMb: value } })} /><ToggleRow id="settings-autoplay-video" label="Автовоспроизведение видео и GIF" checked={media.autoplayVideo} onChange={(checked) => updateLocal("media", { ...media, autoplayVideo: checked, autoplayGif: checked })} /><ToggleRow id="settings-streaming" label="Потоковое воспроизведение" description="Доступно только для незашифрованных источников" checked={media.streaming} onChange={(checked) => updateLocal("media", { ...media, streaming: checked })} /><ToggleRow id="settings-save-gallery" label="Сохранять медиа в галерее" description="Для текущих личных чатов" checked={media.saveToGallery.privateChats} onChange={(checked) => updateLocal("media", { ...media, saveToGallery: { ...media.saveToGallery, privateChats: checked } })} /></div><div className="settings-card"><FieldLabel htmlFor="settings-call-data-saving" description="Ограничение трафика голосовых и видеозвонков">Экономия трафика звонков</FieldLabel><select id="settings-call-data-saving" className="settings-select mt-2" value={media.callDataSaving} onChange={(event) => updateLocal("media", { ...media, callDataSaving: event.target.value as CallDataSaving })}><option value="never">Никогда</option><option value="roaming">Только в роуминге</option><option value="always">Всегда</option></select></div><div className="settings-card"><h3>Прокси</h3><ToggleRow id="settings-proxy-enabled" label="Использовать прокси" description="Конфигурация сохраняется локально; транспорт подключается сетевым адаптером приложения" checked={localSettings.proxy.enabled} onChange={(checked) => updateLocal("proxy", { ...localSettings.proxy, enabled: checked })} /><div className="settings-form-grid mt-3"><div><FieldLabel htmlFor="settings-proxy-protocol">Протокол</FieldLabel><select id="settings-proxy-protocol" className="settings-select" value={localSettings.proxy.protocol} onChange={(event) => updateLocal("proxy", { ...localSettings.proxy, protocol: event.target.value as ProxyProtocol })}><option value="socks5">SOCKS5</option><option value="http">HTTP</option></select></div><div><FieldLabel htmlFor="settings-proxy-host">Хост</FieldLabel><Input id="settings-proxy-host" value={localSettings.proxy.host} onChange={(event) => updateLocal("proxy", { ...localSettings.proxy, host: event.target.value })} placeholder="proxy.example.com" /></div><div><FieldLabel htmlFor="settings-proxy-port">Порт</FieldLabel><Input id="settings-proxy-port" type="number" min="1" max="65535" value={localSettings.proxy.port} onChange={(event) => updateLocal("proxy", { ...localSettings.proxy, port: Number(event.target.value) || 1 })} /></div><div><FieldLabel htmlFor="settings-proxy-username">Логин</FieldLabel><Input id="settings-proxy-username" value={localSettings.proxy.username} onChange={(event) => updateLocal("proxy", { ...localSettings.proxy, username: event.target.value })} /></div><div><FieldLabel htmlFor="settings-proxy-password">Пароль</FieldLabel><Input id="settings-proxy-password" type="password" value={localSettings.proxy.password} onChange={(event) => updateLocal("proxy", { ...localSettings.proxy, password: event.target.value })} /></div></div><p className="settings-muted mt-2">В браузере проксирование fetch/WebSocket ограничено платформой; поля готовы для нативного сетевого адаптера.</p></div><div className="settings-card settings-danger-card"><h3>Очистка</h3><div className="mt-4 flex flex-wrap gap-2"><Button variant="outline" onClick={clearCache}>Очистить кэш сообщений</Button><Button variant="outline" className="border-destructive/50 text-destructive hover:bg-destructive/10" disabled={outboxCount === 0 || actionBusy === "outbox"} onClick={() => requestAction({ kind: "outbox", targetId: "outbox", label: "очередь исходящих сообщений" })}>Очистить очередь</Button></div></div><div className="settings-card settings-danger-card"><h3>Удалить профиль</h3><p className="settings-muted mt-2">Удаляет только локальную сессию этого устройства.</p><div className="mt-4 flex justify-end"><Button variant="outline" className="border-destructive/50 text-destructive hover:bg-destructive/10" onClick={() => requestAction({ kind: "profile", targetId: profile.id, label: `профиль «${profile.name}»` })}>Удалить локально</Button></div><div className="mt-2 flex justify-end"><Button variant="outline" className="border-destructive/50 text-destructive hover:bg-destructive/10" onClick={() => requestAction({ kind: "account", targetId: profile.id, label: `аккаунт «${profile.name}» на сервере` })}>Удалить аккаунт</Button></div></div></section>;
  }

  function renderEnergy() {
    const energy = localSettings.energySaving;
    const toggle = (key: Exclude<keyof typeof energy, "threshold">, label: string) => <ToggleRow id={`settings-energy-${String(key)}`} label={label} checked={energy[key]} onChange={(checked) => updateLocal("energySaving", { ...energy, [key]: checked })} />;
    return <section aria-labelledby="settings-energy-title" className="settings-section-content"><div className="settings-section-heading"><div><h2 id="settings-energy-title">Энергосбережение</h2><p className="settings-muted mt-1">Автоматически ограничивает тяжёлые эффекты при низком заряде.</p></div></div><div className="settings-card"><ToggleRow id="settings-energy-enabled" label="Режим энергосбережения" description={`Включается при заряде ниже ${energy.threshold}%`} checked={energy.enabled} onChange={(checked) => updateLocal("energySaving", { ...energy, enabled: checked })} /><RangeRow id="settings-energy-threshold" label="Порог включения" description="Уровень заряда для режима" value={energy.threshold} min={5} max={50} suffix="%" onChange={(value) => updateLocal("energySaving", { ...energy, threshold: value })} /></div><div className="settings-card settings-list"><h3>Параметры энергосбережения</h3>{toggle("stickers", "Анимация стикеров")}{toggle("emoji", "Анимация эмодзи")}{toggle("chatAnimations", "Анимации в чатах")}{toggle("callAnimations", "Анимации звонков")}{toggle("autoplayVideo", "Автозапуск видео")}{toggle("autoplayGif", "Автозапуск GIF")}{toggle("particles", "Движение частиц")}{toggle("smoothTransitions", "Плавные переходы")}</div></section>;
  }

  function renderUpdates() {
    const release = updateState.release;
    const status = release ? (isNewerVersion(release.version) ? `Доступна новая версия v${release.version}` : release.version === CURRENT_VERSION ? `Установлена последняя версия v${CURRENT_VERSION}` : `Установлена версия v${CURRENT_VERSION}`) : "";
    return <section aria-labelledby="settings-updates-title" className="settings-section-content">
      <div className="settings-section-heading"><div><h2 id="settings-updates-title">Обновления</h2></div></div>
      <div className="settings-card settings-version-card">
        <p className="settings-card-section-title">Версия</p>
        <div className="settings-version-row"><h3>Desktop-приложение</h3><span className="settings-version-badge">v{CURRENT_VERSION}</span></div>
      </div>
      <div className="settings-card settings-update-card">
        <p className="settings-card-section-title">Проверка обновлений</p>
        <div className="settings-update-summary"><div><h3>Enter Desktop</h3><p className="settings-muted mt-1">Ищем последний опубликованный desktop-релиз на GitHub</p></div><Button variant="outline" size="sm" onClick={() => setUpdateRefreshKey((value) => value + 1)} disabled={updateState.loading}><Icon name="rotate_left" className="size-4" />{updateState.loading ? "Проверка…" : "Проверить"}</Button></div>
        {updateState.loading && <p className="settings-muted">Запрашиваю последний опубликованный релиз…</p>}
        {updateState.error && <div className="settings-error" role="alert"><Icon name="error" className="size-4 shrink-0" /><span>{updateState.error}</span></div>}
        {!updateState.loading && !updateState.error && !release && <p className="settings-muted">Опубликованных desktop-релизов пока нет.</p>}
        {release && <div className="settings-update-result"><div className="settings-update-status"><Icon name={isNewerVersion(release.version) ? "download" : "check_circle"} className="size-5 shrink-0" /><div><strong>{status}</strong><span>{release.name} · опубликован {formatReleaseDate(release.publishedAt)}</span></div></div>{release.body && <div className="settings-update-notes">{release.body}</div>}<div className="settings-update-assets"><span className="text-xs font-medium text-muted-foreground">Файлы релиза</span>{release.assets.length ? release.assets.map((asset) => <a key={asset.browserDownloadUrl} className="settings-update-asset" href={asset.browserDownloadUrl} target="_blank" rel="noreferrer"><Icon name="download" className="size-4 shrink-0" /><span>{asset.name}</span></a>) : <span className="settings-muted">Файлы не прикреплены.</span>}</div><a className="settings-update-release-link" href={release.htmlUrl} target="_blank" rel="noreferrer">Открыть релиз на GitHub</a></div>}
        {updateState.checkedAt && <p className="settings-muted text-xs">Проверено {new Intl.DateTimeFormat("ru-RU", { timeStyle: "short" }).format(new Date(updateState.checkedAt))}</p>}
      </div>
    </section>;
  }

  function renderSection() {
    if (section === "password") return renderPassword();
    if (section === "security") return renderSecurity();
    if (section === "notifications") return renderNotifications();
    if (section === "appearance") return renderAppearance();
    if (section === "privacy") return renderPrivacy();
    if (section === "storage") return renderStorage();
    if (section === "energy") return renderEnergy();
    return renderUpdates();
  }

  return <div className="settings-workspace" role="region" aria-labelledby="settings-title">
      <header className="settings-panel-header"><h1 id="settings-title" className="font-heading text-[1.1875rem] font-semibold tracking-tight">Настройки</h1><button type="button" className="icon-button" title="Закрыть настройки" aria-label="Закрыть настройки" onClick={onClose}><Icon name="close" className="size-4" /></button></header>
      <div className="settings-panel-body"><nav className="settings-nav" aria-label="Разделы настроек">{sections.map((item) => <button key={item.id} type="button" className={`settings-nav-item settings-nav-item-${item.id}${item.id === section ? " settings-nav-item-active" : ""}`} aria-current={item.id === section ? "page" : undefined} onClick={() => setSection(item.id)}><span className="settings-nav-icon"><Icon name={item.icon} className="size-4 shrink-0" /></span><span>{item.label}</span></button>)}</nav><div className="settings-main">{feedback && <div className={feedback.kind === "error" ? "settings-error settings-feedback" : "settings-success settings-feedback"} role={feedback.kind === "error" ? "alert" : "status"} aria-live="polite"><Icon name={feedback.kind === "error" ? "error" : "check_circle"} className="size-4 shrink-0" /><span>{feedback.text}</span></div>}{renderSection()}</div></div>
      {pendingAction && <div className="settings-confirm" role="alertdialog" aria-modal="true" aria-labelledby="settings-confirm-title"><div><h2 id="settings-confirm-title">Подтвердите действие</h2><p className="mt-1 text-sm text-muted-foreground">Вы действительно хотите: {pendingAction.label}? Это действие нельзя отменить.</p></div><div className="flex justify-end gap-2"><Button variant="outline" onClick={() => setPendingAction(null)} disabled={Boolean(actionBusy)}>Отмена</Button><Button className="bg-destructive text-destructive-foreground hover:bg-destructive/90" onClick={() => void executePendingAction()} disabled={Boolean(actionBusy)}>{actionBusy ? "Выполнение…" : "Подтвердить"}</Button></div></div>}
  </div>;
}

export { SettingsPanel };
