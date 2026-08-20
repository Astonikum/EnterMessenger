import { useState } from "react";
import { Pressable, ScrollView, StyleSheet, Switch, Text, View } from "react-native";
import { colors, fonts, radii } from "../theme";
import { Icon, type IconName } from "./Icon";

type CategoryId = "security" | "devices" | "notifications" | "storage" | "interface";
type Category = { id: CategoryId; label: string; icon: IconName };

const categories: Category[] = [
  { id: "security", label: "Безопасность", icon: "security" },
  { id: "devices", label: "Устройства", icon: "key" },
  { id: "notifications", label: "Уведомления", icon: "notifications" },
  { id: "storage", label: "Хранилище", icon: "database" },
  { id: "interface", label: "Интерфейс", icon: "tune" },
];

export function SettingsScreen({ onClose }: { onClose: () => void }) {
  const [category, setCategory] = useState<CategoryId | null>(null);
  const [notifications, setNotifications] = useState({ desktop: true, sound: false, preview: true });
  const [interfaceSettings, setInterfaceSettings] = useState({ animations: true, compact: false });
  const current = categories.find((item) => item.id === category);

  if (!current) return <View style={styles.root}><View style={styles.header}><Pressable onPress={onClose} style={styles.back}><Icon name="arrowBack" size={21} color={colors.foreground} /></Pressable><View><Text style={styles.headerTitle}>Настройки</Text><Text style={styles.headerSubtitle}>Приватность и внешний вид</Text></View></View><ScrollView bounces={false} contentContainerStyle={styles.categoryList} showsVerticalScrollIndicator={false}>{categories.map((item) => <Pressable key={item.id} onPress={() => setCategory(item.id)} style={({ pressed }) => [styles.category, pressed && styles.pressed]}><View style={styles.categoryIcon}><Icon name={item.icon} size={21} color={colors.primary} /></View><View style={styles.categoryCopy}><Text style={styles.categoryLabel}>{item.label}</Text><Text style={styles.categoryDescription}>{descriptionFor(item.id)}</Text></View><Icon name="arrowForward" size={19} color={colors.muted} /></Pressable>)}</ScrollView></View>;

  return <View style={styles.root}><View style={styles.header}><Pressable onPress={() => setCategory(null)} style={styles.back}><Icon name="arrowBack" size={21} color={colors.foreground} /></Pressable><View><Text style={styles.headerTitle}>{current.label}</Text><Text style={styles.headerSubtitle}>Настройки Enter</Text></View></View><ScrollView bounces={false} contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}><SettingsContent category={current.id} notifications={notifications} setNotifications={setNotifications} interfaceSettings={interfaceSettings} setInterfaceSettings={setInterfaceSettings} /></ScrollView></View>;
}

function descriptionFor(id: CategoryId) {
  return ({ security: "Сквозное шифрование и ключи", devices: "Активные устройства и сессии", notifications: "Оповещения и звук", storage: "Кэш и синхронизация", interface: "Внешний вид приложения" })[id];
}

function SettingsContent({ category, notifications, setNotifications, interfaceSettings, setInterfaceSettings }: { category: CategoryId; notifications: { desktop: boolean; sound: boolean; preview: boolean }; setNotifications: (value: { desktop: boolean; sound: boolean; preview: boolean }) => void; interfaceSettings: { animations: boolean; compact: boolean }; setInterfaceSettings: (value: { animations: boolean; compact: boolean }) => void }) {
  if (category === "security") return <View style={styles.stack}><View style={styles.statusCard}><View style={styles.statusIcon}><Icon name="security" size={23} color={colors.primary} /></View><View style={styles.statusCopy}><Text style={styles.statusTitle}>Сквозное шифрование включено</Text><Text style={styles.statusDetail}>Ключи и содержимое сообщений используются только на устройствах участников диалога.</Text></View></View></View>;
  if (category === "devices") return <View style={styles.stack}><Section title="Текущее устройство"><StatusRow label="Это устройство" value="Активно" detail="Сообщения синхронизируются с сервером" /></Section><Section title="Другие устройства"><View style={styles.emptyRow}><Icon name="key" size={19} color={colors.muted} /><Text style={styles.emptyRowText}>Других активных устройств нет</Text></View></Section></View>;
  if (category === "notifications") return <View style={styles.stack}><Section title="Оповещения"><ToggleRow label="Уведомления приложения" description="Показывать новые сообщения в системе" value={notifications.desktop} onChange={(desktop) => setNotifications({ ...notifications, desktop })} /><ToggleRow label="Звук сообщений" description="Воспроизводить звук для новых сообщений" value={notifications.sound} onChange={(sound) => setNotifications({ ...notifications, sound })} /><ToggleRow label="Предпросмотр текста" description="Показывать текст сообщения в уведомлении" value={notifications.preview} onChange={(preview) => setNotifications({ ...notifications, preview })} /></Section></View>;
  if (category === "storage") return <View style={styles.stack}><Section title="Данные приложения"><StatusRow label="Кэш сообщений" value="Включён" detail="Последние сообщения доступны без ожидания синхронизации" /><StatusRow label="Синхронизация" value="Автоматически" detail="Изменения проверяются при подключении к серверу" /></Section></View>;
  return <View style={styles.stack}><Section title="Внешний вид"><ToggleRow label="Микроанимации" description="Плавные переходы между состояниями интерфейса" value={interfaceSettings.animations} onChange={(animations) => setInterfaceSettings({ ...interfaceSettings, animations })} /><ToggleRow label="Компактный список" description="Уменьшить расстояние между чатами" value={interfaceSettings.compact} onChange={(compact) => setInterfaceSettings({ ...interfaceSettings, compact })} /></Section></View>;
}

function Section({ title, children }: { title: string; children: React.ReactNode }) { return <View style={styles.section}><Text style={styles.sectionTitle}>{title}</Text>{children}</View>; }
function StatusRow({ label, value, detail }: { label: string; value: string; detail: string }) { return <View style={styles.statusRow}><View style={styles.statusCopy}><Text style={styles.statusTitle}>{label}</Text><Text style={styles.statusDetail}>{detail}</Text></View><Text style={styles.badge}>{value}</Text></View>; }
function ToggleRow({ label, description, value, onChange }: { label: string; description: string; value: boolean; onChange: (value: boolean) => void }) { return <View style={styles.toggleRow}><View style={styles.statusCopy}><Text style={styles.statusTitle}>{label}</Text><Text style={styles.statusDetail}>{description}</Text></View><Switch value={value} onValueChange={onChange} trackColor={{ false: colors.border, true: "#6f63b8" }} thumbColor={value ? colors.primary : colors.muted} /> </View>; }

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
  content: { padding: 16, paddingBottom: 30 },
  stack: { gap: 14 },
  statusCard: { borderRadius: radii.lg, backgroundColor: "#252047", padding: 16, flexDirection: "row", alignItems: "flex-start", gap: 12 },
  statusIcon: { width: 40, height: 40, borderRadius: 12, backgroundColor: "#352b65", alignItems: "center", justifyContent: "center" },
  statusCopy: { flex: 1, gap: 5 },
  statusTitle: { color: colors.foreground, fontFamily: fonts.bodySemibold, fontSize: 14, lineHeight: 19 },
  statusDetail: { color: colors.muted, fontFamily: fonts.body, fontSize: 12, lineHeight: 18 },
  section: { backgroundColor: colors.surface, borderRadius: radii.lg, padding: 16, gap: 4 },
  sectionTitle: { color: colors.muted, fontFamily: fonts.bodyBold, fontSize: 12, letterSpacing: 0.4, marginBottom: 6 },
  statusRow: { minHeight: 68, borderTopWidth: 1, borderTopColor: colors.border, paddingVertical: 12, flexDirection: "row", alignItems: "center", gap: 10 },
  badge: { color: colors.primary, backgroundColor: "#302960", borderRadius: radii.pill, fontFamily: fonts.bodyBold, paddingHorizontal: 9, paddingVertical: 5, fontSize: 11 },
  emptyRow: { minHeight: 58, borderTopWidth: 1, borderTopColor: colors.border, flexDirection: "row", alignItems: "center", gap: 9 },
  emptyRowText: { color: colors.muted, fontFamily: fonts.body, fontSize: 13 },
  toggleRow: { minHeight: 76, borderTopWidth: 1, borderTopColor: colors.border, paddingVertical: 12, flexDirection: "row", alignItems: "center", gap: 12 },
  pressed: { opacity: 0.72 },
});
