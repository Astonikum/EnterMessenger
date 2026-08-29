import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { ActivityIndicator, Alert, Linking, Modal, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from "react-native";
import { colors, fonts, radii, type ThemeColors } from "../theme";
import { Icon, type IconName } from "./Icon";
import { MessageBubble } from "./ChatScreen";
import type { Profile } from "../types";
import { DEFAULT_SETTINGS, readSettings, writeSettings, type MobileSettings } from "../settings";
import { blockAccount, changePassword, deleteDevice, deleteSession, fetchAccountSettings, fetchBlacklist, fetchDevices, fetchSessions, refreshSessionMetadata, revokeOtherSessions, unblockAccount, updateAccountSettings, type AccountDevice, type AccountSession, type AccountSettings, type BlockedAccount } from "../rn-api";
import { friendlyError } from "../client-errors";
import { CURRENT_VERSION, fetchLatestRelease, isNewerVersion, type PlatformRelease } from "../github-releases";

type CategoryId = "password" | "security" | "notifications" | "appearance" | "privacy" | "storage" | "energy" | "updates" | "logs";
type Category = { id: CategoryId; label: string; icon: IconName };

const categories: Category[] = [
  { id: "appearance", label: "Чаты", icon: "tune" },
  { id: "password", label: "Пароль", icon: "key" },
  { id: "security", label: "Безопасность и устройства", icon: "security" },
  { id: "notifications", label: "Уведомления", icon: "notifications" },
  { id: "privacy", label: "Приватность", icon: "key" },
  { id: "storage", label: "Данные и хранилище", icon: "database" },
  { id: "energy", label: "Энергосбережение", icon: "speed" },
  { id: "updates", label: "Обновления", icon: "download" },
  { id: "logs", label: "Диагностические логи", icon: "logs" },
];

type OperationState = { loading: boolean; error: string; success: string };
type UpdateState = { loading: boolean; error: string; release: PlatformRelease | null; checkedAt: number | null };
const idleState: OperationState = { loading: false, error: "", success: "" };
const ThemeContext = createContext<ThemeColors>(colors);

function useThemeColors() {
  return useContext(ThemeContext);
}

export function SettingsScreen({ profile, themeColors = colors, onClose, onOpenLogs, onClearMessageCache, onClearOutbox, onForgetLocalPrivateKeys, onDeleteAccount, onSettingsChange }: {
  profile: Profile;
  themeColors?: ThemeColors;
  onClose: () => void;
  onOpenLogs: () => void;
  onClearMessageCache: () => Promise<void>;
  onClearOutbox: () => Promise<void>;
  onForgetLocalPrivateKeys: () => Promise<void>;
  onDeleteAccount: () => Promise<void>;
  onSettingsChange?: (settings: MobileSettings) => void;
}) {
  const [category, setCategory] = useState<CategoryId | null>(null);
  const [localSettings, setLocalSettings] = useState<MobileSettings>(DEFAULT_SETTINGS);
  const [localState, setLocalState] = useState<OperationState>(idleState);
  const [remoteState, setRemoteState] = useState<OperationState>(idleState);
  const [account, setAccount] = useState<AccountSettings>({ id: profile.id, name: profile.name, handle: profile.handle, showOnline: true, showLastSeen: true, readReceipts: true, typingIndicators: true, showPhone: false, showProfilePhoto: true, allowForwarding: true, allowCalls: true, suggestPeople: true });
  const [passwords, setPasswords] = useState({ current: "", next: "", confirm: "" });
  const [devices, setDevices] = useState<AccountDevice[]>([]);
  const [sessions, setSessions] = useState<AccountSession[]>([]);
  const [blocked, setBlocked] = useState<BlockedAccount[]>([]);
  const [updateState, setUpdateState] = useState<UpdateState>({ loading: false, error: "", release: null, checkedAt: null });
  const [updateRefreshKey, setUpdateRefreshKey] = useState(0);
  const accountRef = useRef(account);
  const privacyRevisionRef = useRef(0);
  const privacyWriteRef = useRef(Promise.resolve());

  useEffect(() => {
    let mounted = true;
    setLocalState({ ...idleState, loading: true });
    void readSettings().then((value) => { if (mounted) { setLocalSettings(value); setLocalState(idleState); } }).catch(() => { if (mounted) setLocalState({ ...idleState, error: "Не удалось загрузить локальные настройки" }); });
    return () => { mounted = false; };
  }, []);

  useEffect(() => {
    if (category !== "privacy" && category !== "security") return;
    let mounted = true;
    setRemoteState({ ...idleState, loading: true });
    const request = category === "privacy" ? Promise.all([fetchAccountSettings(profile), fetchBlacklist(profile)]).then(([value, nextBlocked]) => { if (mounted) { accountRef.current = value; setAccount(value); setBlocked(nextBlocked); } }) : refreshSessionMetadata(profile).catch(() => undefined).then(() => Promise.all([fetchDevices(profile), fetchSessions(profile)])).then(([nextDevices, nextSessions]) => { if (mounted) { setDevices(nextDevices); setSessions(nextSessions); } });
    void request.then(() => { if (mounted) setRemoteState({ ...idleState, success: "Данные синхронизированы" }); }).catch((reason: unknown) => { if (mounted) setRemoteState({ ...idleState, error: friendlyError(reason, "Не удалось загрузить данные с сервера") }); });
    return () => { mounted = false; };
  }, [category, profile]);

  useEffect(() => {
    if (category !== "updates") return;
    const controller = new AbortController();
    setUpdateState((current) => ({ ...current, loading: true, error: "" }));
    void fetchLatestRelease("mobile", controller.signal)
      .then((release) => setUpdateState({ loading: false, error: "", release, checkedAt: Date.now() }))
      .catch((reason: unknown) => {
        if (reason instanceof Error && reason.name === "AbortError") return;
        setUpdateState({ loading: false, error: friendlyError(reason, "Не удалось проверить релизы GitHub"), release: null, checkedAt: Date.now() });
      });
    return () => controller.abort();
  }, [category, updateRefreshKey]);

  function saveLocal(patch: Partial<MobileSettings>) {
    const next = { ...localSettings, ...patch };
    setLocalSettings(next);
    setLocalState(idleState);
    void writeSettings(next).then((saved) => { onSettingsChange?.(saved); }).catch(() => setLocalState({ ...idleState, error: "Не удалось сохранить настройку" }));
  }

  async function runAction(success: string, action: () => Promise<void>) {
    setRemoteState({ ...idleState, loading: true });
    try { await action(); setRemoteState({ ...idleState, success }); } catch (reason) { setRemoteState({ ...idleState, error: friendlyError(reason, "Операция не выполнена") }); }
  }

  function confirmAction(title: string, message: string, success: string, action: () => Promise<void>) {
    Alert.alert(title, message, [{ text: "Отмена", style: "cancel" }, { text: "Подтвердить", style: "destructive", onPress: () => { void runAction(success, action); } }]);
  }

  function updatePrivacy(key: "showOnline" | "showLastSeen" | "readReceipts" | "typingIndicators" | "showPhone" | "showProfilePhoto" | "allowForwarding" | "allowCalls" | "suggestPeople", value: boolean) {
    const next = { ...accountRef.current, [key]: value };
    const revision = ++privacyRevisionRef.current;
    accountRef.current = next;
    setAccount(next);
    setRemoteState(idleState);
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
        if (revision === privacyRevisionRef.current) { accountRef.current = saved; setAccount(saved); }
      } catch (reason) {
        if (revision === privacyRevisionRef.current) setRemoteState({ ...idleState, error: friendlyError(reason, "Не удалось сохранить приватность") });
      }
    });
  }

  async function savePassword() {
    if (!passwords.current || passwords.next.length < 8) { setRemoteState({ ...idleState, error: "Введите текущий пароль и новый пароль от 8 символов" }); return; }
    if (passwords.next !== passwords.confirm) { setRemoteState({ ...idleState, error: "Новые пароли не совпадают" }); return; }
    await runAction("Пароль изменён", async () => { await changePassword(profile, { currentPassword: passwords.current, newPassword: passwords.next }); setPasswords({ current: "", next: "", confirm: "" }); });
  }

  if (!category) return <ThemeContext.Provider value={themeColors}><View style={[styles.root, { backgroundColor: themeColors.background }]}><Header title="Настройки" themeColors={themeColors} onBack={onClose} centered /><ScrollView contentContainerStyle={styles.categoryList} showsVerticalScrollIndicator={false}>{categories.map((item) => <Pressable key={item.id} onPress={() => { if (item.id === "logs") { onOpenLogs(); return; } setRemoteState(idleState); setLocalState(idleState); setCategory(item.id); }} style={({ pressed }) => [styles.category, { backgroundColor: themeColors.surface }, pressed && styles.pressed]} accessibilityRole="button" accessibilityLabel={item.label}><View style={[styles.categoryIcon, { backgroundColor: themeColors.accent }]}><Icon name={item.icon} size={21} color={themeColors.primary} /></View><View style={styles.categoryCopy}><Text style={[styles.categoryLabel, { color: themeColors.foreground }]}>{item.label}</Text></View><Icon name="arrowForward" size={19} color={themeColors.muted} /></Pressable>)}</ScrollView></View></ThemeContext.Provider>;

  const current = categories.find((item) => item.id === category)!;
  return <ThemeContext.Provider value={themeColors}><View style={[styles.root, { backgroundColor: themeColors.background }]}><Header title={current.label} themeColors={themeColors} onBack={() => setCategory(null)} /><ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}><Feedback state={remoteState} /><Feedback state={localState} /><SettingsContent category={category} localSettings={localSettings} saveLocal={saveLocal} account={account} onUpdatePrivacy={updatePrivacy} passwords={passwords} setPasswords={setPasswords} onSavePassword={() => { void savePassword(); }} devices={devices} sessions={sessions} blocked={blocked} profile={profile} updates={updateState} onCheckUpdates={() => setUpdateRefreshKey((value) => value + 1)} onDeleteDevice={(device) => confirmAction("Удалить устройство?", device.name ?? device.deviceId, "Устройство удалено", async () => { await deleteDevice(profile, device.deviceId); setDevices((items) => items.filter((item) => item.deviceId !== device.deviceId)); })} onDeleteSession={(session) => confirmAction("Завершить сессию?", session.deviceName ?? session.id, "Сессия завершена", async () => { await deleteSession(profile, session.id); setSessions((items) => items.filter((item) => item.id !== session.id)); })} onRevokeOthers={() => confirmAction("Завершить другие сессии?", "На других устройствах потребуется войти снова.", "Другие сессии завершены", async () => { await revokeOtherSessions(profile); setSessions((items) => items.filter((item) => item.current)); })} onBlock={(address) => runAction("Пользователь заблокирован", async () => { const value = await blockAccount(profile, address); setBlocked((items) => [value, ...items.filter((item) => item.address !== value.address)]); })} onUnblock={(entry) => runAction("Блокировка снята", async () => { await unblockAccount(profile, entry.id); setBlocked((items) => items.filter((item) => item.id !== entry.id)); })} onClearMessageCache={() => confirmAction("Очистить кэш сообщений?", "Локальные сообщения будут загружены снова при синхронизации.", "Кэш сообщений очищен", onClearMessageCache)} onClearOutbox={() => confirmAction("Очистить очередь отправки?", "Неотправленные сообщения будут удалены с этого устройства.", "Очередь отправки очищена", onClearOutbox)} onForgetKeys={() => confirmAction("Забыть приватные ключи?", "История на этом устройстве перестанет расшифровываться до повторной настройки.", "Локальные ключи удалены", onForgetLocalPrivateKeys)} onDeleteAccount={() => confirmAction("Удалить аккаунт?", "Аккаунт и его данные на сервере будут удалены без возможности восстановления.", "Аккаунт удалён", onDeleteAccount)} /></ScrollView></View></ThemeContext.Provider>;
}

function Header({ title, themeColors = colors, onBack, centered = false }: { title: string; themeColors?: ThemeColors; onBack: () => void; centered?: boolean }) {
  return <View style={[styles.header, { backgroundColor: themeColors.background }]}><Pressable onPress={onBack} style={styles.back} accessibilityRole="button" accessibilityLabel="Назад" accessibilityHint="Вернуться к предыдущему экрану"><Icon name="arrowBack" size={21} color={themeColors.foreground} /></Pressable>{centered ? <View pointerEvents="none" style={styles.centeredHeaderTitle}><Text style={[styles.headerTitle, { color: themeColors.foreground }]}>{title}</Text></View> : <Text style={[styles.headerTitle, { color: themeColors.foreground }]}>{title}</Text>}</View>;
}

function Feedback({ state }: { state: OperationState }) {
  const themeColors = useThemeColors();
  if (state.loading) return <View style={[styles.feedback, { backgroundColor: themeColors.surface }]}><ActivityIndicator size="small" color={themeColors.primary} /><Text style={[styles.feedbackText, { color: themeColors.foreground }]}>Загрузка…</Text></View>;
  if (state.error) return <View style={[styles.feedback, styles.feedbackError, { borderColor: themeColors.danger }]}><Icon name="error" size={17} color={themeColors.danger} /><Text style={[styles.feedbackText, { color: themeColors.foreground }]}>{state.error}</Text></View>;
  if (state.success) return <View style={[styles.feedback, styles.feedbackSuccess, { borderColor: themeColors.success }]}><Icon name="checkCircle" size={17} color={themeColors.success} /><Text style={[styles.feedbackText, { color: themeColors.foreground }]}>{state.success}</Text></View>;
  return null;
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

function deviceTitle(device: AccountDevice) {
  return knownValue(device.name) || `Устройство ${shortId(device.deviceId)}`;
}

function deviceDetails(device: AccountDevice) {
  return [
    knownValue(device.platform) || "Платформа не указана",
    knownValue(device.appVersion) ? `версия ${knownValue(device.appVersion)}` : undefined,
    `ID ${shortId(device.deviceId)}`,
    `активно ${formatSessionDate(device.lastSeenAt ?? device.createdAt)}`,
  ].filter(Boolean).join(" · ");
}

function sessionTitle(session: AccountSession) {
  return knownValue(session.deviceName) || `Устройство ${shortId(session.deviceId || session.id)}`;
}

function sessionDetails(session: AccountSession) {
  return [
    knownValue(session.platform) || "Платформа не указана",
    knownValue(session.appVersion) ? `версия ${knownValue(session.appVersion)}` : undefined,
    session.deviceId ? `ID ${shortId(session.deviceId)}` : `сессия ${shortId(session.id)}`,
    `создана ${formatSessionDate(session.createdAt)}`,
    `активна ${formatSessionDate(session.lastSeenAt ?? session.createdAt)}`,
    session.current ? "текущая" : `до ${formatSessionDate(session.expiresAt)}`,
  ].filter(Boolean).join(" · ");
}

function formatReleaseDate(value: string | null) {
  return value ? new Intl.DateTimeFormat("ru-RU", { dateStyle: "medium" }).format(new Date(value)) : "дата не указана";
}

function UpdatesContent({ state, onCheck }: { state: UpdateState; onCheck: () => void }) {
  const themeColors = useThemeColors();
  const release = state.release;
  const isNewer = release ? isNewerVersion(release.version) : false;
  const status = release ? (isNewer ? `Доступна новая версия v${release.version}` : release.version === CURRENT_VERSION ? `Установлена последняя версия v${CURRENT_VERSION}` : `Установлена версия v${CURRENT_VERSION}`) : "";
  const assets = release?.assets.filter((asset) => /\.(apk|aab)$/i.test(asset.name)) ?? [];
  return <View style={styles.stack}>
    <Section title="Версия"><StatusRow label="Мобильное приложение" value={`v${CURRENT_VERSION}`} /></Section>
    <Section title="Проверка обновлений"><View style={styles.updateSummary}><View style={styles.statusCopy}><Text style={[styles.statusTitle, { color: themeColors.foreground }]}>Enter Mobile</Text><Text style={[styles.statusDetail, { color: themeColors.muted }]}>Ищем последний опубликованный mobile-релиз на GitHub</Text></View><Pressable disabled={state.loading} onPress={onCheck} style={[styles.updateButton, { borderColor: themeColors.border }, state.loading && styles.disabledButton]} accessibilityRole="button" accessibilityLabel="Проверить обновления"><Icon name="rotateLeft" size={16} color={themeColors.primary} /><Text style={[styles.secondaryButtonText, { color: themeColors.primary }]}>{state.loading ? "Проверка…" : "Проверить"}</Text></Pressable></View>{state.loading && <Text style={[styles.emptyText, { color: themeColors.muted }]}>Запрашиваю релиз…</Text>}{state.error && <View style={[styles.feedback, styles.feedbackError, { borderColor: themeColors.danger }]}><Icon name="error" size={17} color={themeColors.danger} /><Text style={[styles.feedbackText, { color: themeColors.foreground }]}>{state.error}</Text></View>}{!state.loading && !state.error && !release && <Text style={[styles.emptyText, { color: themeColors.muted }]}>Опубликованных mobile-релизов пока нет.</Text>}{release && <View style={[styles.updateResult, { borderTopColor: themeColors.border }]}><View style={styles.updateStatus}><Icon name={isNewer ? "download" : "checkCircle"} size={20} color={themeColors.primary} /><View style={styles.statusCopy}><Text style={[styles.statusTitle, { color: themeColors.foreground }]}>{status}</Text><Text style={[styles.statusDetail, { color: themeColors.muted }]}>{release.name} · опубликован {formatReleaseDate(release.publishedAt)}</Text></View></View>{release.body ? <Text style={[styles.updateNotes, { color: themeColors.muted, backgroundColor: themeColors.background }]}>{release.body}</Text> : null}<View style={styles.updateAssets}><Text style={[styles.statusDetail, { color: themeColors.muted }]}>Файлы релиза</Text>{assets.length ? assets.map((asset) => <Pressable key={asset.browserDownloadUrl} onPress={() => { void Linking.openURL(asset.browserDownloadUrl); }} style={styles.updateAsset} accessibilityRole="link" accessibilityLabel={`Скачать ${asset.name}`}><Icon name="download" size={17} color={themeColors.primary} /><Text style={[styles.linkText, { color: themeColors.primary }]}>{asset.name}</Text></Pressable>) : <Text style={[styles.emptyText, { color: themeColors.muted }]}>APK/AAB не прикреплены.</Text>}</View><Pressable onPress={() => { void Linking.openURL(release.htmlUrl); }} accessibilityRole="link" accessibilityLabel="Открыть релиз на GitHub"><Text style={[styles.linkText, { color: themeColors.primary }]}>Открыть релиз на GitHub</Text></Pressable></View>}{state.checkedAt && <Text style={[styles.statusDetail, { color: themeColors.muted }]}>Проверено {new Intl.DateTimeFormat("ru-RU", { timeStyle: "short" }).format(new Date(state.checkedAt))}</Text>}</Section>
  </View>;
}

function SettingsContent({ category, localSettings, saveLocal, account, onUpdatePrivacy, passwords, setPasswords, onSavePassword, devices, sessions, blocked, profile, updates, onCheckUpdates, onDeleteDevice, onDeleteSession, onRevokeOthers, onBlock, onUnblock, onClearMessageCache, onClearOutbox, onForgetKeys, onDeleteAccount }: {
  category: CategoryId;
  localSettings: MobileSettings;
  saveLocal: (patch: Partial<MobileSettings>) => void;
  account: AccountSettings;
  onUpdatePrivacy: (key: "showOnline" | "showLastSeen" | "readReceipts" | "typingIndicators" | "showPhone" | "showProfilePhoto" | "allowForwarding" | "allowCalls" | "suggestPeople", value: boolean) => void;
  passwords: { current: string; next: string; confirm: string };
  setPasswords: (value: { current: string; next: string; confirm: string }) => void;
  onSavePassword: () => void;
  devices: AccountDevice[];
  sessions: AccountSession[];
  blocked: BlockedAccount[];
  profile: Profile;
  updates: UpdateState;
  onCheckUpdates: () => void;
  onDeleteDevice: (device: AccountDevice) => void;
  onDeleteSession: (session: AccountSession) => void;
  onRevokeOthers: () => void;
  onBlock: (address: string) => void;
  onUnblock: (entry: BlockedAccount) => void;
  onClearMessageCache: () => void;
  onClearOutbox: () => void;
  onForgetKeys: () => void;
  onDeleteAccount: () => void;
}) {
  const themeColors = useThemeColors();
  if (category === "password") return <View style={styles.stack}><Section title="Изменить пароль"><PasswordField label="Текущий пароль" value={passwords.current} onChangeText={(current) => setPasswords({ ...passwords, current })} /><PasswordField label="Новый пароль" value={passwords.next} onChangeText={(next) => setPasswords({ ...passwords, next })} /><PasswordField label="Повторите новый пароль" value={passwords.confirm} onChangeText={(confirm) => setPasswords({ ...passwords, confirm })} /><PrimaryButton label="Изменить пароль" onPress={onSavePassword} /></Section></View>;
  if (category === "security") return <View style={styles.stack}><View style={[styles.statusCard, { backgroundColor: themeColors.accent }]}><View style={[styles.statusIcon, { backgroundColor: themeColors.surfaceRaised }]}><Icon name="security" size={23} color={themeColors.primary} /></View><View style={styles.statusCopy}><Text style={[styles.statusTitle, { color: themeColors.foreground }]}>Сквозное шифрование включено</Text><Text style={[styles.statusDetail, { color: themeColors.muted }]}>Приватные ключи хранятся локально и не отправляются на сервер.</Text></View></View><Section title="Устройства"><RemoteList loading={!devices.length && !sessions.length} empty="Нет данных об устройствах" items={devices} render={(device) => { const current = device.deviceId === profile.deviceId; return <ActionRow key={device.deviceId} label={deviceTitle(device)} detail={`${deviceDetails(device)}${current ? " · это устройство" : ""}`} actionLabel={current ? undefined : "Удалить"} onAction={current ? undefined : () => onDeleteDevice(device)} />; }} /></Section><Section title="Сессии"><RemoteList loading={false} empty="Нет активных сессий" items={sessions} render={(session) => <ActionRow key={session.id} label={sessionTitle(session)} detail={sessionDetails(session)} actionLabel={session.current ? undefined : "Завершить"} onAction={session.current ? undefined : () => onDeleteSession(session)} />} />{sessions.some((session) => !session.current) && <SecondaryButton label="Завершить другие сессии" onPress={onRevokeOthers} />}</Section><Section title="Локальные ключи"><Text style={[styles.statusDetail, { color: themeColors.muted }]}>Удаление ключей необратимо для этого устройства.</Text><DangerButton label="Забыть приватные ключи" onPress={onForgetKeys} /></Section></View>;
  if (category === "notifications") { const n = localSettings.notifications; const toggle = (key: keyof typeof n, label: string, hint = "") => <ToggleRow key={String(key)} label={label} hint={hint} value={n[key] as boolean} onChange={(value) => saveLocal({ notifications: { ...n, [key]: value } })} />; return <View style={styles.stack}><Section title="Показывать уведомления">{toggle("desktop", "Всех аккаунтов", "Показывать новые сообщения в системе")}{toggle("allAccounts", "Все аккаунты")}{toggle("privateChats", "Личные чаты")}{toggle("groups", "Группы")}{toggle("channels", "Каналы")}{toggle("stories", "Истории")}{toggle("reactions", "Реакции")}</Section><Section title="Счётчик сообщений">{toggle("showCounter", "Показывать счётчик")}{toggle("mutedChats", "Чаты без уведомлений")}</Section><Section title="В приложении">{toggle("sound", "Звук уведомлений")}{toggle("inAppSound", "Звук в чате")}{toggle("inAppVibration", "Вибросигнал")}{toggle("preview", "Показывать текст")}{toggle("inAppPreview", "Предпросмотр текста")}{toggle("popups", "Всплывающие окна")}</Section><Section title="События">{toggle("contactJoined", "Контакт присоединился")}{toggle("pinnedMessages", "Закреплённые сообщения")}</Section><Section title="Другое">{toggle("restartOnClose", "Перезапуск при закрытии")}{toggle("backgroundConnection", "Фоновое соединение")}<ChoiceRow label="Повтор уведомлений" hint="Период повторного напоминания" value={String(n.repeatInterval)} options={["0", "60", "300", "3600"]} onChange={(value) => saveLocal({ notifications: { ...n, repeatInterval: Number(value) as 0 | 60 | 300 | 3600 } })} /></Section></View>; }
  if (category === "appearance") return <View style={styles.stack}><Section title="Предпросмотр"><View style={[styles.preview, { backgroundColor: themeColors.background }]}><View style={styles.previewRow}><View style={[styles.previewAvatar, { backgroundColor: themeColors.primary }]}><Text style={[styles.previewAvatarText, { color: themeColors.primaryText }]}>A</Text></View><View><Text style={[styles.statusTitle, { color: themeColors.foreground, fontSize: localSettings.messageTextSize }]}>Alexander</Text><Text style={[styles.statusDetail, { color: themeColors.muted }]}>Доброе утро! {localSettings.chatListLayout === "three-line" ? "· В сети" : ""}</Text></View></View><View style={styles.previewBubbles}><MessageBubble themeColors={themeColors} profile={profile} message={{ id: "settings-preview-in", author: "them", text: "Доброе утро! 👋", time: "14:08" }} messageTextSize={localSettings.messageTextSize} bubbleRadius={localSettings.bubbleRadius} onToggleSelection={() => undefined} onReply={() => undefined} onStartEdit={() => undefined} onPin={() => undefined} onSave={() => undefined} onDelete={() => undefined} onReact={() => undefined} onForward={() => undefined} /><MessageBubble themeColors={themeColors} profile={profile} message={{ id: "settings-preview-out", author: "me", text: "В Токио утро 😎", time: "14:23" }} messageTextSize={localSettings.messageTextSize} bubbleRadius={localSettings.bubbleRadius} onToggleSelection={() => undefined} onReply={() => undefined} onStartEdit={() => undefined} onPin={() => undefined} onSave={() => undefined} onDelete={() => undefined} onReact={() => undefined} onForward={() => undefined} /></View></View></Section><Section title="Внешний вид"><ChoiceRow label="Тема" hint="Системная, светлая или тёмная тема" value={localSettings.theme} options={["system", "light", "dark"]} onChange={(theme) => saveLocal({ theme: theme as MobileSettings["theme"] })} /><ChoiceRow label="Размер текста" hint="Размер текста в интерфейсе" value={String(localSettings.fontScale)} options={["0.9", "1", "1.1"]} onChange={(fontScale) => saveLocal({ fontScale: Number(fontScale) as MobileSettings["fontScale"] })} /><ChoiceRow label="Плотность" hint="Расстояние между элементами интерфейса" value={localSettings.density} options={["comfortable", "compact"]} onChange={(density) => saveLocal({ density: density as MobileSettings["density"] })} /><ChoiceRow label="Акцентный цвет" hint="Цвет кнопок и выделения" value={localSettings.accent} options={["violet", "blue", "green", "rose"]} onChange={(accent) => saveLocal({ accent: accent as MobileSettings["accent"] })} /><ChoiceRow label="Список чатов" hint="Количество строк в превью диалога" value={localSettings.chatListLayout} options={["two-line", "three-line"]} onChange={(chatListLayout) => saveLocal({ chatListLayout: chatListLayout as MobileSettings["chatListLayout"] })} /></Section><Section title="Оформление чатов"><SliderRow label="Размер текста сообщений" hint="Размер текста внутри пузырей сообщений" value={localSettings.messageTextSize} min={14} max={22} suffix=" px" onChange={(messageTextSize) => saveLocal({ messageTextSize })} /><SliderRow label="Скругление пузырей" hint="Радиус углов блоков сообщений" value={localSettings.bubbleRadius} min={6} max={22} suffix=" px" onChange={(bubbleRadius) => saveLocal({ bubbleRadius })} /></Section></View>;
  if (category === "privacy") return <View style={styles.stack}><Section title="Приватность"><ToggleRow label="Подтверждения прочтения" hint="Показывать собеседникам, что сообщение прочитано" value={account.readReceipts} onChange={(value) => onUpdatePrivacy("readReceipts", value)} /><ToggleRow label="Статус в сети" hint="Показывать, когда вы активны" value={account.showOnline} onChange={(value) => onUpdatePrivacy("showOnline", value)} /><ToggleRow label="Последнее посещение" hint="Показывать время последней активности" value={account.showLastSeen} onChange={(value) => onUpdatePrivacy("showLastSeen", value)} /><ToggleRow label="Номер телефона" hint="Разрешать отображение номера" value={account.showPhone} onChange={(value) => onUpdatePrivacy("showPhone", value)} /><ToggleRow label="Фотографии профиля" hint="Разрешать просмотр фотографий" value={account.showProfilePhoto} onChange={(value) => onUpdatePrivacy("showProfilePhoto", value)} /><ToggleRow label="Пересылка сообщений" hint="Разрешать пересылку сообщений от вас" value={account.allowForwarding} onChange={(value) => onUpdatePrivacy("allowForwarding", value)} /><ToggleRow label="Звонки" hint="Разрешать входящие звонки" value={account.allowCalls} onChange={(value) => onUpdatePrivacy("allowCalls", value)} /><ToggleRow label="Индикатор набора" hint="Показывать, когда вы печатаете" value={account.typingIndicators} onChange={(value) => onUpdatePrivacy("typingIndicators", value)} /></Section><Section title="Чёрный список"><BlacklistForm onBlock={onBlock} /><RemoteList loading={false} empty="Заблокированных пользователей нет" items={blocked} render={(entry) => <ActionRow key={entry.id} label={entry.name} detail={entry.address} actionLabel="Разблокировать" onAction={() => onUnblock(entry)} />} /></Section><Section title="Удаление аккаунта"><Text style={styles.statusDetail}>Удаляет аккаунт и данные на сервере без возможности восстановления.</Text><DangerButton label="Удалить аккаунт" onPress={onDeleteAccount} /></Section></View>;
  if (category === "storage") { const media = localSettings.media; const auto = media.autoDownload; return <View style={styles.stack}><Section title="Использование сети и кэша"><ChoiceRow label="Политика кэша" hint="Фактические правила хранения сообщений" value={localSettings.cachePolicy} options={["standard", "minimal", "disabled"]} onChange={(cachePolicy) => saveLocal({ cachePolicy: cachePolicy as MobileSettings["cachePolicy"] })} /><ActionRow label="Кэш сообщений" detail="Локальные сообщения будут загружены снова" actionLabel="Очистить" onAction={onClearMessageCache} /><ActionRow label="Очередь отправки" detail="Неотправленные сообщения хранятся на устройстве" actionLabel="Очистить" onAction={onClearOutbox} /></Section><Section title="Автозагрузка медиа">{<ToggleRow label="Через мобильную сеть" hint="Фото, видео и файлы в пределах лимитов" value={auto.cellular} onChange={(value) => saveLocal({ media: { ...media, autoDownload: { ...auto, cellular: value } } })} />}<ToggleRow label="Через Wi‑Fi" hint="Разрешить автозагрузку по Wi‑Fi" value={auto.wifi} onChange={(value) => saveLocal({ media: { ...media, autoDownload: { ...auto, wifi: value } } })} /><ToggleRow label="В роуминге" hint="Разрешить автозагрузку в роуминге" value={auto.roaming} onChange={(value) => saveLocal({ media: { ...media, autoDownload: { ...auto, roaming: value } } })} /><SliderRow label="Лимит фото" hint="Максимальный размер автозагрузки" value={auto.photoLimitMb} min={1} max={100} suffix=" МБ" onChange={(value) => saveLocal({ media: { ...media, autoDownload: { ...auto, photoLimitMb: value } } })} /><SliderRow label="Лимит видео" hint="Максимальный размер автозагрузки" value={auto.videoLimitMb} min={1} max={500} suffix=" МБ" onChange={(value) => saveLocal({ media: { ...media, autoDownload: { ...auto, videoLimitMb: value } } })} /><ToggleRow label="Автовоспроизведение видео и GIF" hint="Запускать видео после загрузки" value={media.autoplayVideo} onChange={(value) => saveLocal({ media: { ...media, autoplayVideo: value, autoplayGif: value } })} /><ToggleRow label="Сохранять в галерею" hint="Для текущих личных чатов" value={media.saveToGallery.privateChats} onChange={(value) => saveLocal({ media: { ...media, saveToGallery: { ...media.saveToGallery, privateChats: value } } })} /><ToggleRow label="Потоковое воспроизведение" hint="Только для незашифрованных источников" value={media.streaming} onChange={(value) => saveLocal({ media: { ...media, streaming: value } })} /></Section><Section title="Прокси"><ToggleRow label="Использовать прокси" hint="Параметры сохраняются для нативного сетевого адаптера" value={localSettings.proxy.enabled} onChange={(value) => saveLocal({ proxy: { ...localSettings.proxy, enabled: value } })} /><Field label="Хост" hint="Адрес прокси" value={localSettings.proxy.host} onChangeText={(host) => saveLocal({ proxy: { ...localSettings.proxy, host } })} placeholder="proxy.example.com" /><Field label="Порт" hint="Порт от 1 до 65535" keyboardType="number-pad" value={String(localSettings.proxy.port)} onChangeText={(port) => saveLocal({ proxy: { ...localSettings.proxy, port: Number(port) || 1 } })} /></Section></View>; }
  if (category === "energy") { const energy = localSettings.energySaving; const toggle = (key: Exclude<keyof typeof energy, "threshold">, label: string) => <ToggleRow key={String(key)} label={label} hint="Ограничивается только при активном режиме" value={energy[key]} onChange={(value) => saveLocal({ energySaving: { ...energy, [key]: value } })} />; return <View style={styles.stack}><Section title="Режим энергосбережения"><ToggleRow label="Включать режим" hint={`При заряде ниже ${energy.threshold}%`} value={energy.enabled} onChange={(value) => saveLocal({ energySaving: { ...energy, enabled: value } })} /><SliderRow label="Порог включения" hint="Уровень заряда" value={energy.threshold} min={5} max={50} suffix="%" onChange={(value) => saveLocal({ energySaving: { ...energy, threshold: value } })} /></Section><Section title="Параметры">{toggle("stickers", "Анимация стикеров")}{toggle("emoji", "Анимация эмодзи")}{toggle("chatAnimations", "Анимации в чатах")}{toggle("callAnimations", "Анимации звонков")}{toggle("autoplayVideo", "Автозапуск видео")}{toggle("autoplayGif", "Автозапуск GIF")}{toggle("particles", "Движение частиц")}{toggle("smoothTransitions", "Плавные переходы")}</Section></View>; }
  return <UpdatesContent state={updates} onCheck={onCheckUpdates} />;
}

function Section({ title, children }: { title: string; children: ReactNode }) { const themeColors = useThemeColors(); return <View style={[styles.section, { backgroundColor: themeColors.surface }]}><Text style={[styles.sectionTitle, { color: themeColors.primary }]}>{title}</Text>{children}</View>; }
function StatusRow({ label, value, detail }: { label: string; value: string; detail?: string }) { const themeColors = useThemeColors(); return <View style={[styles.statusRow, { borderTopColor: themeColors.border }]}><View style={styles.statusCopy}><Text style={[styles.statusTitle, { color: themeColors.foreground }]}>{label}</Text>{detail ? <Text style={[styles.statusDetail, { color: themeColors.muted }]}>{detail}</Text> : null}</View><Text style={[styles.badge, { color: themeColors.primary, backgroundColor: themeColors.accent }]}>{value}</Text></View>; }
function RemoteList<T>({ empty, items, render }: { loading: boolean; empty: string; items: T[]; render: (item: T) => ReactNode }) { return items.length ? <View>{items.map(render)}</View> : <Text style={styles.emptyText}>{empty}</Text>; }
function ActionRow({ label, detail, actionLabel, onAction }: { label: string; detail: string; actionLabel?: string; onAction?: () => void }) { const themeColors = useThemeColors(); return <View style={[styles.actionRow, { borderTopColor: themeColors.border }]}><View style={styles.statusCopy}><Text style={[styles.statusTitle, { color: themeColors.foreground }]}>{label}</Text><Text style={[styles.statusDetail, { color: themeColors.muted }]}>{detail}</Text></View>{actionLabel && onAction && <Pressable onPress={onAction} style={[styles.smallButton, { borderColor: themeColors.border }]} accessibilityRole="button" accessibilityLabel={`${actionLabel}: ${label}`}><Text style={[styles.smallButtonText, { color: themeColors.primary }]}>{actionLabel}</Text></Pressable>}</View>; }
function BlacklistForm({ onBlock }: { onBlock: (address: string) => void }) {
  const [address, setAddress] = useState("");
  return <View style={styles.blacklistForm}><TextInput style={styles.input} value={address} onChangeText={setAddress} placeholder="handle@server" placeholderTextColor={colors.muted} autoCapitalize="none" autoCorrect={false} accessibilityLabel="Enter-адрес для блокировки" /><Pressable style={[styles.smallButton, !address.trim() && styles.disabledButton]} disabled={!address.trim()} onPress={() => { onBlock(address.trim()); setAddress(""); }}><Text style={styles.smallButtonText}>Добавить</Text></Pressable></View>;
}
function ToggleRow({ label, hint, value, onChange }: { label: string; hint: string; value: boolean; onChange: (value: boolean) => void }) { const themeColors = useThemeColors(); return <View style={[styles.toggleRow, { borderTopColor: themeColors.border }]}><View style={styles.statusCopy}><Text style={[styles.statusTitle, { color: themeColors.foreground }]}>{label}</Text><Text style={[styles.statusDetail, { color: themeColors.muted }]}>{hint}</Text></View><Switch value={value} onValueChange={onChange} accessibilityLabel={label} accessibilityHint={hint} trackColor={{ false: themeColors.border, true: themeColors.accent }} thumbColor={value ? themeColors.primary : themeColors.muted} /></View>; }
function SliderRow({ label, hint, value, min, max, suffix, onChange }: { label: string; hint: string; value: number; min: number; max: number; suffix: string; onChange: (value: number) => void }) {
  const themeColors = useThemeColors();
  const [width, setWidth] = useState(1);
  const progress = (value - min) / (max - min);
  return <View style={[styles.sliderRow, { borderTopColor: themeColors.border }]}><View style={styles.sliderHeader}><View style={styles.statusCopy}><Text style={[styles.statusTitle, { color: themeColors.foreground }]}>{label}</Text><Text style={[styles.statusDetail, { color: themeColors.muted }]}>{hint}</Text></View><Text style={[styles.badge, { color: themeColors.primary, backgroundColor: themeColors.accent }]}>{value}{suffix}</Text></View><View style={[styles.sliderTrack, { backgroundColor: themeColors.border }]} onLayout={(event) => setWidth(event.nativeEvent.layout.width)}><Pressable style={StyleSheet.absoluteFill} onPress={(event) => onChange(Math.round(min + Math.max(0, Math.min(1, event.nativeEvent.locationX / width)) * (max - min)))} accessibilityRole="adjustable" accessibilityLabel={label} accessibilityValue={{ min, max, now: value }} /><View pointerEvents="none" style={[styles.sliderFill, { width: `${progress * 100}%`, backgroundColor: themeColors.primary }]} /><View pointerEvents="none" style={[styles.sliderThumb, { left: `${progress * 100}%`, backgroundColor: themeColors.primary }]} /></View></View>;
}
function ChoiceRow({ label, hint, value, options, onChange }: { label: string; hint: string; value: string; options: readonly string[]; onChange: (value: string) => void }) {
  const themeColors = useThemeColors();
  const [open, setOpen] = useState(false);
  const labels: Record<string, string> = { system: "Системная", light: "Светлая", dark: "Тёмная", "0.9": "Маленький", "1": "Обычный", "1.1": "Крупный", comfortable: "Комфортная", compact: "Компактная", violet: "Фиолетовый", blue: "Синий", green: "Зелёный", rose: "Розовый", ru: "Русский", en: "English", standard: "Стандартная", minimal: "Минимальная", disabled: "Отключён", "two-line": "Двухстрочный", "three-line": "Трёхстрочный" };
  const currentLabel = labels[value] ?? value;

  return <>
    <Pressable onPress={() => setOpen(true)} style={({ pressed }) => [styles.choiceRow, { borderTopColor: themeColors.border }, pressed && styles.pressed]} accessibilityRole="button" accessibilityLabel={label} accessibilityHint={`${hint}. Текущее значение: ${currentLabel}. Нажмите, чтобы выбрать вариант.`}>
      <View style={styles.statusCopy}><Text style={[styles.statusTitle, { color: themeColors.foreground }]}>{label}</Text><Text style={[styles.statusDetail, { color: themeColors.muted }]}>{hint}</Text></View>
      <Text style={[styles.badge, { color: themeColors.primary, backgroundColor: themeColors.accent }]}>{currentLabel}</Text>
    </Pressable>
    <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
      <Pressable style={styles.choiceDialogBackdrop} onPress={() => setOpen(false)}>
        <Pressable style={[styles.choiceDialog, { backgroundColor: themeColors.surface, borderColor: themeColors.border }]} onPress={(event) => event.stopPropagation()}>
        <Text style={[styles.choiceDialogTitle, { color: themeColors.foreground }]}>{label}</Text>
        <Text style={[styles.choiceDialogHint, { color: themeColors.muted }]}>{hint}</Text>
        <View style={[styles.choiceOptions, { borderTopColor: themeColors.border }]}>
          {options.map((option) => {
            const selected = option === value;
            return <Pressable key={option} onPress={() => { onChange(option); setOpen(false); }} style={({ pressed }) => [styles.choiceOption, { borderBottomColor: themeColors.border }, selected && { backgroundColor: themeColors.primary }, pressed && styles.pressed]} accessibilityRole="radio" accessibilityState={{ selected }} accessibilityLabel={labels[option] ?? option}>
              <Text style={[styles.choiceOptionText, { color: selected ? themeColors.primaryText : themeColors.foreground }]}>{labels[option] ?? option}</Text>
              {selected && <Icon name="check" size={20} color={themeColors.primaryText} />}
            </Pressable>;
          })}
        </View>
        </Pressable>
      </Pressable>
    </Modal>
  </>;
}
function Field({ label, hint, ...props }: { label: string; hint: string } & React.ComponentProps<typeof TextInput>) { const themeColors = useThemeColors(); return <View style={styles.field}><Text style={[styles.fieldLabel, { color: themeColors.foreground }]}>{label}</Text><TextInput {...props} style={[styles.input, { borderColor: themeColors.border, backgroundColor: themeColors.surfaceRaised, color: themeColors.foreground }]} placeholderTextColor={themeColors.muted} accessibilityLabel={label} accessibilityHint={hint} /></View>; }
function PasswordField({ label, value, onChangeText }: { label: string; value: string; onChangeText: (value: string) => void }) { return <Field label={label} hint="Пароль не отображается на экране" value={value} onChangeText={onChangeText} secureTextEntry autoCapitalize="none" autoCorrect={false} />; }
function PrimaryButton({ label, onPress }: { label: string; onPress: () => void }) { const themeColors = useThemeColors(); return <Pressable onPress={onPress} style={[styles.primaryButton, { backgroundColor: themeColors.primary }]} accessibilityRole="button" accessibilityLabel={label}><Text style={[styles.primaryButtonText, { color: themeColors.primaryText }]}>{label}</Text></Pressable>; }
function SecondaryButton({ label, onPress }: { label: string; onPress: () => void }) { const themeColors = useThemeColors(); return <Pressable onPress={onPress} style={[styles.secondaryButton, { borderColor: themeColors.border }]} accessibilityRole="button" accessibilityLabel={label}><Text style={[styles.secondaryButtonText, { color: themeColors.primary }]}>{label}</Text></Pressable>; }
function DangerButton({ label, onPress }: { label: string; onPress: () => void }) { const themeColors = useThemeColors(); return <Pressable onPress={onPress} style={[styles.dangerButton, { borderColor: themeColors.danger }]} accessibilityRole="button" accessibilityLabel={label} accessibilityHint="Требуется подтверждение"><Text style={[styles.dangerButtonText, { color: themeColors.danger }]}>{label}</Text></Pressable>; }

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  header: { minHeight: 70, paddingHorizontal: 16, borderBottomWidth: 1, borderBottomColor: colors.border, flexDirection: "row", alignItems: "center", gap: 10 },
  back: { zIndex: 2, width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center" },
  headerTitle: { color: colors.foreground, fontFamily: fonts.headingBold, fontSize: 19 },
  centeredHeaderTitle: { position: "absolute", left: 0, right: 0, alignItems: "center" },
  categoryList: { padding: 16, gap: 8 },
  category: { minHeight: 76, backgroundColor: colors.surface, borderRadius: radii.md, padding: 12, flexDirection: "row", alignItems: "center", gap: 12 },
  categoryIcon: { width: 44, height: 44, borderRadius: 14, backgroundColor: "#2c2552", alignItems: "center", justifyContent: "center" },
  categoryCopy: { flex: 1, gap: 4 },
  categoryLabel: { color: colors.foreground, fontFamily: fonts.bodySemibold, fontSize: 15 },
  content: { padding: 16, paddingBottom: 30, gap: 12 },
  stack: { gap: 14 },
  statusCard: { borderRadius: radii.lg, backgroundColor: "#252047", padding: 16, flexDirection: "row", alignItems: "flex-start", gap: 12 },
  updateSummary: { flexDirection: "row", alignItems: "flex-start", gap: 10 },
  updateButton: { minHeight: 42, borderRadius: radii.sm, borderWidth: 1, alignItems: "center", justifyContent: "center", flexDirection: "row", gap: 6, paddingHorizontal: 10 },
  updateResult: { borderTopWidth: 1, paddingTop: 12, gap: 10 },
  updateStatus: { flexDirection: "row", alignItems: "flex-start", gap: 8 },
  updateNotes: { borderRadius: radii.sm, padding: 10, fontFamily: fonts.body, fontSize: 12, lineHeight: 18 },
  updateAssets: { gap: 3 },
  updateAsset: { minHeight: 32, flexDirection: "row", alignItems: "center", gap: 6 },
  linkText: { fontFamily: fonts.bodySemibold, fontSize: 13 },
  statusIcon: { width: 40, height: 40, borderRadius: 12, backgroundColor: "#352b65", alignItems: "center", justifyContent: "center" },
  statusCopy: { flex: 1, gap: 5 },
  statusTitle: { color: colors.foreground, fontFamily: fonts.bodySemibold, fontSize: 14, lineHeight: 19 },
  statusDetail: { color: colors.muted, fontFamily: fonts.body, fontSize: 12, lineHeight: 18 },
  section: { backgroundColor: colors.surface, borderRadius: radii.lg, padding: 16, gap: 4 },
  sectionTitle: { color: colors.muted, fontFamily: fonts.bodyBold, fontSize: 12, letterSpacing: 0.4, marginBottom: 6 },
  statusRow: { minHeight: 68, borderTopWidth: 1, borderTopColor: colors.border, paddingVertical: 12, flexDirection: "row", alignItems: "center", gap: 10 },
  actionRow: { minHeight: 68, borderTopWidth: 1, borderTopColor: colors.border, paddingVertical: 12, flexDirection: "row", alignItems: "center", gap: 10 },
  toggleRow: { minHeight: 76, borderTopWidth: 1, borderTopColor: colors.border, paddingVertical: 12, flexDirection: "row", alignItems: "center", gap: 12 },
  choiceRow: { minHeight: 68, borderTopWidth: 1, borderTopColor: colors.border, paddingVertical: 12, flexDirection: "row", alignItems: "center", gap: 10 },
  choiceDialogBackdrop: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: "rgba(0,0,0,0.56)", padding: 20 },
  choiceDialog: { width: "100%", maxWidth: 420, maxHeight: "78%", borderRadius: radii.lg, borderWidth: 1, padding: 18 },
  choiceDialogTitle: { fontFamily: fonts.headingBold, fontSize: 19 },
  choiceDialogHint: { fontFamily: fonts.body, fontSize: 12, lineHeight: 18, marginTop: 4, marginBottom: 12 },
  choiceOptions: { borderTopWidth: 1 },
  choiceOption: { minHeight: 52, borderBottomWidth: 1, paddingHorizontal: 10, flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  choiceOptionText: { fontFamily: fonts.bodySemibold, fontSize: 15 },
  sliderRow: { minHeight: 92, borderTopWidth: 1, borderTopColor: colors.border, paddingVertical: 12, gap: 10 },
  sliderHeader: { flexDirection: "row", alignItems: "center", gap: 10 },
  sliderTrack: { height: 6, borderRadius: 3, backgroundColor: colors.border, position: "relative", marginHorizontal: 2 },
  sliderFill: { position: "absolute", left: 0, top: 0, bottom: 0, borderRadius: 3, backgroundColor: colors.primary },
  sliderThumb: { position: "absolute", top: -5, width: 16, height: 16, marginLeft: -8, borderRadius: 8, backgroundColor: colors.primary },
  badge: { color: colors.primary, backgroundColor: "#302960", borderRadius: radii.pill, fontFamily: fonts.bodyBold, paddingHorizontal: 9, paddingVertical: 5, fontSize: 11 },
  emptyText: { color: colors.muted, fontFamily: fonts.body, fontSize: 13, paddingVertical: 12 },
  field: { gap: 5, paddingVertical: 5 },
  fieldLabel: { color: colors.foreground, fontFamily: fonts.bodySemibold, fontSize: 13 },
  input: { minHeight: 44, borderWidth: 1, borderColor: colors.border, borderRadius: radii.sm, backgroundColor: colors.surfaceRaised, color: colors.foreground, paddingHorizontal: 12, fontFamily: fonts.body, fontSize: 15 },
  address: { color: colors.primary, fontFamily: fonts.bodyMedium, fontSize: 14 },
  primaryButton: { minHeight: 46, borderRadius: radii.md, backgroundColor: colors.primary, alignItems: "center", justifyContent: "center", paddingHorizontal: 16 },
  primaryButtonText: { color: colors.foreground, fontFamily: fonts.bodyBold, fontSize: 14 },
  secondaryButton: { minHeight: 42, borderRadius: radii.sm, borderWidth: 1, borderColor: colors.border, alignItems: "center", justifyContent: "center", marginTop: 10 },
  secondaryButtonText: { color: colors.primary, fontFamily: fonts.bodySemibold, fontSize: 13 },
  dangerButton: { minHeight: 42, borderRadius: radii.sm, borderWidth: 1, borderColor: "#713532", alignItems: "center", justifyContent: "center", marginTop: 12 },
  dangerButtonText: { color: colors.danger, fontFamily: fonts.bodySemibold, fontSize: 13 },
  smallButton: { borderRadius: radii.sm, borderWidth: 1, borderColor: colors.border, paddingHorizontal: 10, paddingVertical: 8 },
  smallButtonText: { color: colors.primary, fontFamily: fonts.bodySemibold, fontSize: 12 },
  feedback: { minHeight: 34, borderRadius: radii.sm, backgroundColor: colors.surface, paddingHorizontal: 10, flexDirection: "row", alignItems: "center", gap: 8 },
  feedbackError: { borderWidth: 1, borderColor: "#713532" },
  feedbackSuccess: { borderWidth: 1, borderColor: "#275e3a" },
  feedbackText: { flex: 1, color: colors.foreground, fontFamily: fonts.body, fontSize: 12 },
  blacklistForm: { flexDirection: "row", alignItems: "center", gap: 8, paddingTop: 8, paddingBottom: 8 },
  disabledButton: { opacity: 0.45 },
  preview: { backgroundColor: "#0f1117", borderRadius: radii.md, padding: 12, gap: 8, marginTop: 4 },
  previewRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  previewAvatar: { width: 32, height: 32, borderRadius: 16, backgroundColor: colors.primary, alignItems: "center", justifyContent: "center" },
  previewAvatarText: { color: colors.primaryText, fontFamily: fonts.bodyBold },
  previewBubbles: { gap: 6 },
  previewBubble: { maxWidth: "86%", paddingHorizontal: 10, paddingVertical: 7 },
  previewIncoming: { alignSelf: "flex-start", backgroundColor: "#293542" },
  previewOutgoing: { alignSelf: "flex-end", backgroundColor: "#5547a2" },
  previewText: { color: colors.foreground, fontFamily: fonts.body },
  pressed: { opacity: 0.72 },
});
