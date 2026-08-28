import { useEffect, useState, type ReactNode } from "react";
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from "react-native";
import { colors, fonts, radii } from "../theme";
import { Icon, type IconName } from "./Icon";
import type { Profile } from "../types";
import { DEFAULT_SETTINGS, readSettings, writeSettings, type MobileSettings } from "../settings";
import { changePassword, deleteDevice, deleteSession, fetchAccountSettings, fetchDevices, fetchSessions, revokeOtherSessions, updateAccountSettings, type AccountDevice, type AccountSession, type AccountSettings } from "../rn-api";

type CategoryId = "account" | "security" | "notifications" | "appearance" | "privacy" | "data" | "about";
type Category = { id: CategoryId; label: string; description: string; icon: IconName };

const categories: Category[] = [
  { id: "account", label: "Аккаунт", description: "Имя и публичный адрес", icon: "person" },
  { id: "security", label: "Безопасность и устройства", description: "Пароль, ключи и сессии", icon: "security" },
  { id: "notifications", label: "Уведомления", description: "Оповещения и звук", icon: "notifications" },
  { id: "appearance", label: "Внешний вид", description: "Анимации и плотность списка", icon: "tune" },
  { id: "privacy", label: "Приватность", description: "Видимость и подтверждения", icon: "key" },
  { id: "data", label: "Данные и хранилище", description: "Кэш и очередь отправки", icon: "database" },
  { id: "about", label: "О приложении", description: "Enter Messenger и версия", icon: "info" },
];

type OperationState = { loading: boolean; error: string; success: string };
const idleState: OperationState = { loading: false, error: "", success: "" };

export function SettingsScreen({ profile, onClose, onClearMessageCache, onClearOutbox, onForgetLocalPrivateKeys }: {
  profile: Profile;
  onClose: () => void;
  onClearMessageCache: () => Promise<void>;
  onClearOutbox: () => Promise<void>;
  onForgetLocalPrivateKeys: () => Promise<void>;
}) {
  const [category, setCategory] = useState<CategoryId | null>(null);
  const [localSettings, setLocalSettings] = useState<MobileSettings>(DEFAULT_SETTINGS);
  const [localState, setLocalState] = useState<OperationState>(idleState);
  const [remoteState, setRemoteState] = useState<OperationState>(idleState);
  const [account, setAccount] = useState<AccountSettings>({ id: profile.id, name: profile.name, handle: profile.handle, showOnline: true, showLastSeen: true, readReceipts: true, typingIndicators: true });
  const [accountName, setAccountName] = useState(profile.name);
  const [accountHandle, setAccountHandle] = useState(profile.handle.replace(/^@+/, ""));
  const [passwords, setPasswords] = useState({ current: "", next: "", confirm: "" });
  const [devices, setDevices] = useState<AccountDevice[]>([]);
  const [sessions, setSessions] = useState<AccountSession[]>([]);

  useEffect(() => {
    let mounted = true;
    setLocalState({ ...idleState, loading: true });
    void readSettings().then((value) => { if (mounted) { setLocalSettings(value); setLocalState({ ...idleState, success: "Локальные настройки загружены" }); } }).catch(() => { if (mounted) setLocalState({ ...idleState, error: "Не удалось загрузить локальные настройки" }); });
    return () => { mounted = false; };
  }, []);

  useEffect(() => {
    if (category !== "account" && category !== "privacy" && category !== "security") return;
    let mounted = true;
    setRemoteState({ ...idleState, loading: true });
    const request = category === "account" ? fetchAccountSettings(profile).then((value) => { if (mounted) { setAccount(value); setAccountName(value.name); setAccountHandle(value.handle.replace(/^@+/, "")); } }) : Promise.all([fetchDevices(profile), fetchSessions(profile)]).then(([nextDevices, nextSessions]) => { if (mounted) { setDevices(nextDevices); setSessions(nextSessions); } });
    void request.then(() => { if (mounted) setRemoteState({ ...idleState, success: "Данные синхронизированы" }); }).catch((reason: unknown) => { if (mounted) setRemoteState({ ...idleState, error: reason instanceof Error ? reason.message : "Не удалось загрузить данные с сервера" }); });
    return () => { mounted = false; };
  }, [category, profile]);

  function saveLocal(patch: Partial<MobileSettings>) {
    const next = { ...localSettings, ...patch };
    setLocalSettings(next);
    setLocalState({ ...idleState, loading: true });
    void writeSettings(next).then(() => setLocalState({ ...idleState, success: "Сохранено" })).catch(() => setLocalState({ ...idleState, error: "Не удалось сохранить настройку" }));
  }

  async function runAction(success: string, action: () => Promise<void>) {
    setRemoteState({ ...idleState, loading: true });
    try { await action(); setRemoteState({ ...idleState, success }); } catch (reason) { setRemoteState({ ...idleState, error: reason instanceof Error ? reason.message : "Операция не выполнена" }); }
  }

  function confirmAction(title: string, message: string, success: string, action: () => Promise<void>) {
    Alert.alert(title, message, [{ text: "Отмена", style: "cancel" }, { text: "Подтвердить", style: "destructive", onPress: () => { void runAction(success, action); } }]);
  }

  async function saveAccount() {
    const name = accountName.trim();
    const handle = accountHandle.trim().replace(/^@+/, "");
    if (name.length < 1 || name.length > 80) { setRemoteState({ ...idleState, error: "Имя должно содержать от 1 до 80 символов" }); return; }
    if (handle !== account.handle.replace(/^@+/, "")) { setRemoteState({ ...idleState, error: "Username нельзя изменить в этом разделе" }); return; }
    await runAction("Данные аккаунта сохранены", async () => { const value = await updateAccountSettings(profile, { name }); setAccount(value); setAccountName(value.name); setAccountHandle(value.handle.replace(/^@+/, "")); });
  }

  function updatePrivacy(key: "showOnline" | "showLastSeen" | "readReceipts" | "typingIndicators", value: boolean) {
    setAccount((current) => ({ ...current, [key]: value }));
  }

  async function savePrivacy() {
    await runAction("Настройки приватности сохранены", async () => {
      const value = await updateAccountSettings(profile, {
        showOnline: account.showOnline,
        showLastSeen: account.showLastSeen,
        readReceipts: account.readReceipts,
        typingIndicators: account.typingIndicators,
      });
      setAccount(value);
    });
  }

  async function savePassword() {
    if (!passwords.current || passwords.next.length < 8) { setRemoteState({ ...idleState, error: "Введите текущий пароль и новый пароль от 8 символов" }); return; }
    if (passwords.next !== passwords.confirm) { setRemoteState({ ...idleState, error: "Новые пароли не совпадают" }); return; }
    await runAction("Пароль изменён", async () => { await changePassword(profile, { currentPassword: passwords.current, newPassword: passwords.next }); setPasswords({ current: "", next: "", confirm: "" }); });
  }

  if (!category) return <View style={styles.root}><Header title="Настройки" subtitle="Enter Messenger" onBack={onClose} /><ScrollView contentContainerStyle={styles.categoryList} showsVerticalScrollIndicator={false}>{categories.map((item) => <Pressable key={item.id} onPress={() => { setRemoteState(idleState); setLocalState(idleState); setCategory(item.id); }} style={({ pressed }) => [styles.category, pressed && styles.pressed]} accessibilityRole="button" accessibilityLabel={item.label} accessibilityHint={`Открыть раздел: ${item.description}`}><View style={styles.categoryIcon}><Icon name={item.icon} size={21} color={colors.primary} /></View><View style={styles.categoryCopy}><Text style={styles.categoryLabel}>{item.label}</Text><Text style={styles.categoryDescription}>{item.description}</Text></View><Icon name="arrowForward" size={19} color={colors.muted} /></Pressable>)}</ScrollView></View>;

  const current = categories.find((item) => item.id === category)!;
  return <View style={styles.root}><Header title={current.label} subtitle="Настройки Enter" onBack={() => setCategory(null)} /><ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}><Feedback state={remoteState} /><Feedback state={localState} /><SettingsContent category={category} localSettings={localSettings} saveLocal={saveLocal} accountName={accountName} accountHandle={accountHandle} setAccountName={setAccountName} setAccountHandle={setAccountHandle} account={account} onSaveAccount={() => { void saveAccount(); }} onUpdatePrivacy={updatePrivacy} onSavePrivacy={() => { void savePrivacy(); }} passwords={passwords} setPasswords={setPasswords} onSavePassword={() => { void savePassword(); }} devices={devices} sessions={sessions} profile={profile} onDeleteDevice={(device) => confirmAction("Удалить устройство?", device.name ?? device.deviceId, "Устройство удалено", async () => { await deleteDevice(profile, device.deviceId); setDevices((items) => items.filter((item) => item.deviceId !== device.deviceId)); })} onDeleteSession={(session) => confirmAction("Завершить сессию?", session.deviceName ?? session.id, "Сессия завершена", async () => { await deleteSession(profile, session.id); setSessions((items) => items.filter((item) => item.id !== session.id)); })} onRevokeOthers={() => confirmAction("Завершить другие сессии?", "На других устройствах потребуется войти снова.", "Другие сессии завершены", async () => { await revokeOtherSessions(profile); setSessions((items) => items.filter((item) => item.current)); })} onClearMessageCache={() => confirmAction("Очистить кэш сообщений?", "Локальные сообщения будут загружены снова при синхронизации.", "Кэш сообщений очищен", onClearMessageCache)} onClearOutbox={() => confirmAction("Очистить очередь отправки?", "Неотправленные сообщения будут удалены с этого устройства.", "Очередь отправки очищена", onClearOutbox)} onForgetKeys={() => confirmAction("Забыть приватные ключи?", "История на этом устройстве перестанет расшифровываться до повторной настройки.", "Локальные ключи удалены", onForgetLocalPrivateKeys)} /></ScrollView></View>;
}

function Header({ title, subtitle, onBack }: { title: string; subtitle: string; onBack: () => void }) {
  return <View style={styles.header}><Pressable onPress={onBack} style={styles.back} accessibilityRole="button" accessibilityLabel="Назад" accessibilityHint="Вернуться к предыдущему экрану"><Icon name="arrowBack" size={21} color={colors.foreground} /></Pressable><View><Text style={styles.headerTitle}>{title}</Text><Text style={styles.headerSubtitle}>{subtitle}</Text></View></View>;
}

function Feedback({ state }: { state: OperationState }) {
  if (state.loading) return <View style={styles.feedback}><ActivityIndicator size="small" color={colors.primary} /><Text style={styles.feedbackText}>Загрузка…</Text></View>;
  if (state.error) return <View style={[styles.feedback, styles.feedbackError]}><Icon name="error" size={17} color={colors.danger} /><Text style={styles.feedbackText}>{state.error}</Text></View>;
  if (state.success) return <View style={[styles.feedback, styles.feedbackSuccess]}><Icon name="checkCircle" size={17} color={colors.success} /><Text style={styles.feedbackText}>{state.success}</Text></View>;
  return null;
}

function SettingsContent({ category, localSettings, saveLocal, accountName, accountHandle, setAccountName, setAccountHandle, account, onSaveAccount, onUpdatePrivacy, onSavePrivacy, passwords, setPasswords, onSavePassword, devices, sessions, profile, onDeleteDevice, onDeleteSession, onRevokeOthers, onClearMessageCache, onClearOutbox, onForgetKeys }: {
  category: CategoryId;
  localSettings: MobileSettings;
  saveLocal: (patch: Partial<MobileSettings>) => void;
  accountName: string;
  accountHandle: string;
  setAccountName: (value: string) => void;
  setAccountHandle: (value: string) => void;
  account: AccountSettings;
  onSaveAccount: () => void;
  onUpdatePrivacy: (key: "showOnline" | "showLastSeen" | "readReceipts" | "typingIndicators", value: boolean) => void;
  onSavePrivacy: () => void;
  passwords: { current: string; next: string; confirm: string };
  setPasswords: (value: { current: string; next: string; confirm: string }) => void;
  onSavePassword: () => void;
  devices: AccountDevice[];
  sessions: AccountSession[];
  profile: Profile;
  onDeleteDevice: (device: AccountDevice) => void;
  onDeleteSession: (session: AccountSession) => void;
  onRevokeOthers: () => void;
  onClearMessageCache: () => void;
  onClearOutbox: () => void;
  onForgetKeys: () => void;
}) {
  if (category === "account") return <View style={styles.stack}><Section title="Публичные данные"><Field label="Имя" hint="Отображается собеседникам" value={accountName} onChangeText={setAccountName} autoCapitalize="words" /><Field label="Username" hint="Username задаётся сервером" value={accountHandle} editable={false} autoCapitalize="none" autoCorrect={false} /></Section><PrimaryButton label="Сохранить имя" onPress={onSaveAccount} /><Section title="Текущий адрес"><Text style={styles.address}>@{account.handle.replace(/^@+/, "")}@{profile.server.replace(/^https?:\/\//, "")}</Text></Section></View>;
  if (category === "security") return <View style={styles.stack}><View style={styles.statusCard}><View style={styles.statusIcon}><Icon name="security" size={23} color={colors.primary} /></View><View style={styles.statusCopy}><Text style={styles.statusTitle}>Сквозное шифрование включено</Text><Text style={styles.statusDetail}>Приватные ключи хранятся локально и не отправляются на сервер.</Text></View></View><Section title="Изменить пароль"><PasswordField label="Текущий пароль" value={passwords.current} onChangeText={(current) => setPasswords({ ...passwords, current })} /><PasswordField label="Новый пароль" value={passwords.next} onChangeText={(next) => setPasswords({ ...passwords, next })} /><PasswordField label="Повторите новый пароль" value={passwords.confirm} onChangeText={(confirm) => setPasswords({ ...passwords, confirm })} /><PrimaryButton label="Изменить пароль" onPress={onSavePassword} /></Section><Section title="Устройства"><RemoteList loading={!devices.length && !sessions.length} empty="Нет данных об устройствах" items={devices} render={(device) => { const current = device.deviceId === profile.deviceId; return <ActionRow key={device.deviceId} label={device.name ?? device.deviceId} detail={`${device.platform || "Устройство"}${current ? " · это устройство" : ""}`} actionLabel={current ? undefined : "Удалить"} onAction={current ? undefined : () => onDeleteDevice(device)} />; }} /></Section><Section title="Сессии"><RemoteList loading={false} empty="Нет активных сессий" items={sessions} render={(session) => <ActionRow key={session.id} label={session.deviceName ?? session.id} detail={session.current ? "Текущая сессия" : "Активная сессия"} actionLabel={session.current ? undefined : "Завершить"} onAction={session.current ? undefined : () => onDeleteSession(session)} />} />{sessions.some((session) => !session.current) && <SecondaryButton label="Завершить другие сессии" onPress={onRevokeOthers} />}</Section><Section title="Локальные ключи"><Text style={styles.statusDetail}>Удаление ключей необратимо для этого устройства.</Text><DangerButton label="Забыть приватные ключи" onPress={onForgetKeys} /></Section></View>;
  if (category === "notifications") return <View style={styles.stack}><Section title="Оповещения"><ToggleRow label="Уведомления приложения" hint="Показывать новые сообщения в системе" value={localSettings.notifications.enabled} onChange={(enabled) => saveLocal({ notifications: { ...localSettings.notifications, enabled } })} /><ToggleRow label="Звук сообщений" hint="Воспроизводить звук для новых сообщений" value={localSettings.notifications.sound} onChange={(sound) => saveLocal({ notifications: { ...localSettings.notifications, sound } })} /><ToggleRow label="Предпросмотр текста" hint="Показывать текст сообщения в уведомлении" value={localSettings.notifications.preview} onChange={(preview) => saveLocal({ notifications: { ...localSettings.notifications, preview } })} /></Section></View>;
  if (category === "appearance") return <View style={styles.stack}><Section title="Внешний вид"><ChoiceRow label="Тема" hint="Системная, светлая или тёмная тема" value={localSettings.theme} options={["system", "light", "dark"]} onChange={(theme) => saveLocal({ theme: theme as MobileSettings["theme"] })} /><ChoiceRow label="Размер текста" hint="Размер текста в чатах" value={localSettings.textSize} options={["small", "medium", "large"]} onChange={(textSize) => saveLocal({ textSize: textSize as MobileSettings["textSize"] })} /><ChoiceRow label="Язык" hint="Язык интерфейса" value={localSettings.language} options={["system", "ru", "en"]} onChange={(language) => saveLocal({ language: language as MobileSettings["language"] })} /></Section></View>;
  if (category === "privacy") return <View style={styles.stack}><Section title="Приватность"><ToggleRow label="Подтверждения прочтения" hint="Показывать собеседникам, что сообщение прочитано" value={account.readReceipts} onChange={(value) => onUpdatePrivacy("readReceipts", value)} /><ToggleRow label="Статус в сети" hint="Показывать, когда вы активны" value={account.showOnline} onChange={(value) => onUpdatePrivacy("showOnline", value)} /><ToggleRow label="Последнее посещение" hint="Показывать время последней активности" value={account.showLastSeen} onChange={(value) => onUpdatePrivacy("showLastSeen", value)} /><ToggleRow label="Индикатор набора" hint="Показывать, когда вы печатаете" value={account.typingIndicators} onChange={(value) => onUpdatePrivacy("typingIndicators", value)} /></Section><PrimaryButton label="Сохранить приватность" onPress={onSavePrivacy} /></View>;
  if (category === "data") return <View style={styles.stack}><Section title="Данные приложения"><ChoiceRow label="Хранение кэша" hint="Максимальный срок локального хранения" value={`${localSettings.cache.retentionDays} дней`} options={["0 дней", "7 дней", "30 дней", "90 дней", "365 дней"]} onChange={(value) => saveLocal({ cache: { ...localSettings.cache, retentionDays: Number.parseInt(value, 10) } })} /><ToggleRow label="Автозагрузка медиа" hint="Загружать вложения автоматически" value={localSettings.cache.autoloadMedia} onChange={(autoloadMedia) => saveLocal({ cache: { ...localSettings.cache, autoloadMedia } })} /><ActionRow label="Кэш сообщений" detail="Локальные сообщения будут загружены снова" actionLabel="Очистить" onAction={onClearMessageCache} /><ActionRow label="Очередь отправки" detail="Неотправленные сообщения хранятся на устройстве" actionLabel="Очистить" onAction={onClearOutbox} /></Section></View>;
  return <View style={styles.stack}><View style={styles.statusCard}><View style={styles.statusIcon}><Icon name="info" size={23} color={colors.primary} /></View><View style={styles.statusCopy}><Text style={styles.statusTitle}>Enter Messenger</Text><Text style={styles.statusDetail}>Приватный мессенджер с E2E-шифрованием.</Text></View></View><Section title="Версия"><StatusRow label="Мобильное приложение" value="0.2.0" detail="Expo iOS · Android · web" /></Section></View>;
}

function Section({ title, children }: { title: string; children: ReactNode }) { return <View style={styles.section}><Text style={styles.sectionTitle}>{title}</Text>{children}</View>; }
function StatusRow({ label, value, detail }: { label: string; value: string; detail: string }) { return <View style={styles.statusRow}><View style={styles.statusCopy}><Text style={styles.statusTitle}>{label}</Text><Text style={styles.statusDetail}>{detail}</Text></View><Text style={styles.badge}>{value}</Text></View>; }
function RemoteList<T>({ empty, items, render }: { loading: boolean; empty: string; items: T[]; render: (item: T) => ReactNode }) { return items.length ? <View>{items.map(render)}</View> : <Text style={styles.emptyText}>{empty}</Text>; }
function ActionRow({ label, detail, actionLabel, onAction }: { label: string; detail: string; actionLabel?: string; onAction?: () => void }) { return <View style={styles.actionRow}><View style={styles.statusCopy}><Text style={styles.statusTitle}>{label}</Text><Text style={styles.statusDetail}>{detail}</Text></View>{actionLabel && onAction && <Pressable onPress={onAction} style={styles.smallButton} accessibilityRole="button" accessibilityLabel={`${actionLabel}: ${label}`}><Text style={styles.smallButtonText}>{actionLabel}</Text></Pressable>}</View>; }
function ToggleRow({ label, hint, value, onChange }: { label: string; hint: string; value: boolean; onChange: (value: boolean) => void }) { return <View style={styles.toggleRow}><View style={styles.statusCopy}><Text style={styles.statusTitle}>{label}</Text><Text style={styles.statusDetail}>{hint}</Text></View><Switch value={value} onValueChange={onChange} accessibilityLabel={label} accessibilityHint={hint} trackColor={{ false: colors.border, true: "#6f63b8" }} thumbColor={value ? colors.primary : colors.muted} /></View>; }
function ChoiceRow({ label, hint, value, options, onChange }: { label: string; hint: string; value: string; options: readonly string[]; onChange: (value: string) => void }) { const index = Math.max(0, options.indexOf(value)); const next = options[(index + 1) % options.length] ?? value; return <Pressable onPress={() => onChange(next)} style={({ pressed }) => [styles.choiceRow, pressed && styles.pressed]} accessibilityRole="button" accessibilityLabel={label} accessibilityHint={`${hint}. Текущее значение: ${value}. Нажмите для изменения.`}><View style={styles.statusCopy}><Text style={styles.statusTitle}>{label}</Text><Text style={styles.statusDetail}>{hint}</Text></View><Text style={styles.badge}>{value}</Text></Pressable>; }
function Field({ label, hint, ...props }: { label: string; hint: string } & React.ComponentProps<typeof TextInput>) { return <View style={styles.field}><Text style={styles.fieldLabel}>{label}</Text><TextInput {...props} style={styles.input} placeholderTextColor={colors.muted} accessibilityLabel={label} accessibilityHint={hint} /></View>; }
function PasswordField({ label, value, onChangeText }: { label: string; value: string; onChangeText: (value: string) => void }) { return <Field label={label} hint="Пароль не отображается на экране" value={value} onChangeText={onChangeText} secureTextEntry autoCapitalize="none" autoCorrect={false} />; }
function PrimaryButton({ label, onPress }: { label: string; onPress: () => void }) { return <Pressable onPress={onPress} style={styles.primaryButton} accessibilityRole="button" accessibilityLabel={label}><Text style={styles.primaryButtonText}>{label}</Text></Pressable>; }
function SecondaryButton({ label, onPress }: { label: string; onPress: () => void }) { return <Pressable onPress={onPress} style={styles.secondaryButton} accessibilityRole="button" accessibilityLabel={label}><Text style={styles.secondaryButtonText}>{label}</Text></Pressable>; }
function DangerButton({ label, onPress }: { label: string; onPress: () => void }) { return <Pressable onPress={onPress} style={styles.dangerButton} accessibilityRole="button" accessibilityLabel={label} accessibilityHint="Требуется подтверждение"><Text style={styles.dangerButtonText}>{label}</Text></Pressable>; }

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  header: { minHeight: 76, paddingHorizontal: 16, paddingTop: 12, paddingBottom: 10, borderBottomWidth: 1, borderBottomColor: colors.border, flexDirection: "row", alignItems: "center", gap: 10 },
  back: { width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center" },
  headerTitle: { color: colors.foreground, fontFamily: fonts.headingBold, fontSize: 19 },
  headerSubtitle: { color: colors.muted, fontFamily: fonts.body, fontSize: 12, marginTop: 3 },
  categoryList: { padding: 16, gap: 8 },
  category: { minHeight: 76, backgroundColor: colors.surface, borderRadius: radii.md, padding: 12, flexDirection: "row", alignItems: "center", gap: 12 },
  categoryIcon: { width: 44, height: 44, borderRadius: 14, backgroundColor: "#2c2552", alignItems: "center", justifyContent: "center" },
  categoryCopy: { flex: 1, gap: 4 },
  categoryLabel: { color: colors.foreground, fontFamily: fonts.bodySemibold, fontSize: 15 },
  categoryDescription: { color: colors.muted, fontFamily: fonts.body, fontSize: 12 },
  content: { padding: 16, paddingBottom: 30, gap: 12 },
  stack: { gap: 14 },
  statusCard: { borderRadius: radii.lg, backgroundColor: "#252047", padding: 16, flexDirection: "row", alignItems: "flex-start", gap: 12 },
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
  badge: { color: colors.primary, backgroundColor: "#302960", borderRadius: radii.pill, fontFamily: fonts.bodyBold, paddingHorizontal: 9, paddingVertical: 5, fontSize: 11 },
  emptyText: { color: colors.muted, fontFamily: fonts.body, fontSize: 13, paddingVertical: 12 },
  field: { gap: 5, paddingVertical: 5 },
  fieldLabel: { color: colors.foreground, fontFamily: fonts.bodySemibold, fontSize: 13 },
  input: { minHeight: 44, borderWidth: 1, borderColor: colors.border, borderRadius: radii.sm, backgroundColor: colors.surfaceRaised, color: colors.foreground, paddingHorizontal: 12, fontFamily: fonts.body, fontSize: 15 },
  address: { color: colors.primary, fontFamily: fonts.bodyMedium, fontSize: 14 },
  primaryButton: { minHeight: 46, borderRadius: radii.md, backgroundColor: colors.primary, alignItems: "center", justifyContent: "center", paddingHorizontal: 16 },
  primaryButtonText: { color: colors.primaryText, fontFamily: fonts.bodyBold, fontSize: 14 },
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
  pressed: { opacity: 0.72 },
});
