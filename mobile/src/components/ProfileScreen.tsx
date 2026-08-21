import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import type { Profile } from "../types";
import { colors, fonts, radii } from "../theme";
import { Icon, type IconName } from "./Icon";
import { ProfileAvatar } from "./Avatar";

type Props = { profile: Profile; onClose: () => void; onOpenProfiles: () => void; onAddProfile: () => void };

function serverAddress(profile: Profile) {
  return profile.server.replace(/^https?:\/\//, "");
}

function DetailRow({ icon, label, value }: { icon: IconName; label: string; value: string }) {
  return <View style={styles.detailRow}><View style={styles.detailIcon}><Icon name={icon} size={18} color={colors.primary} /></View><View style={styles.detailCopy}><Text style={styles.detailLabel}>{label}</Text><Text style={styles.detailValue} numberOfLines={1}>{value}</Text></View></View>;
}

function ActionRow({ icon, label, description, onPress }: { icon: IconName; label: string; description: string; onPress: () => void }) {
  return <Pressable onPress={onPress} style={({ pressed }) => [styles.actionRow, pressed && styles.pressed]}><View style={styles.detailIcon}><Icon name={icon} size={18} color={colors.primary} /></View><View style={styles.detailCopy}><Text style={styles.detailValue}>{label}</Text><Text style={styles.detailLabel}>{description}</Text></View><Icon name="arrowForward" size={18} color={colors.muted} /></Pressable>;
}

export function ProfileScreen({ profile, onClose, onOpenProfiles, onAddProfile }: Props) {
  return <View style={styles.root}><View style={styles.header}><Pressable onPress={onClose} style={styles.back} hitSlop={8}><Icon name="arrowBack" size={21} color={colors.foreground} /></Pressable><View><Text style={styles.headerTitle}>Профиль</Text><Text style={styles.headerSubtitle}>Управление аккаунтом</Text></View></View><ScrollView bounces={false} contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
    <View style={styles.hero}><ProfileAvatar name={profile.name} size={92} /><Text style={styles.name}>{profile.name}</Text><Text style={styles.handle}>@{profile.handle.replace(/^@/, "")}</Text><View style={styles.activeBadge}><Icon name="checkCircle" size={15} color={colors.primary} /><Text style={styles.activeBadgeText}>Аккаунт активен</Text></View></View>
    <Section title="Данные профиля"><DetailRow icon="person" label="Имя" value={profile.name} /><DetailRow icon="person" label="Логин" value={`@${profile.handle.replace(/^@/, "")}`} /><DetailRow icon="language" label="Сервер" value={serverAddress(profile)} /></Section>
    <Section title="Управление"><ActionRow icon="person" label="Сменить профиль" description="Переключиться на другой аккаунт" onPress={onOpenProfiles} /><ActionRow icon="plus" label="Добавить профиль" description="Подключить ещё один сервер" onPress={onAddProfile} /></Section>
  </ScrollView></View>;
}

function Section({ title, children }: { title: string; children: React.ReactNode }) { return <View style={styles.section}><Text style={styles.sectionTitle}>{title}</Text>{children}</View>; }

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  header: { minHeight: 76, paddingHorizontal: 16, paddingTop: 12, paddingBottom: 10, borderBottomWidth: 1, borderBottomColor: colors.border, flexDirection: "row", alignItems: "center", gap: 10 },
  back: { width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center" },
  headerTitle: { color: colors.foreground, fontFamily: fonts.headingBold, fontSize: 19 },
  headerSubtitle: { color: colors.muted, fontFamily: fonts.body, fontSize: 12, marginTop: 3 },
  content: { padding: 16, paddingBottom: 30, gap: 14 },
  hero: { alignItems: "center", backgroundColor: colors.surface, borderRadius: radii.lg, padding: 24 },
  name: { color: colors.foreground, fontFamily: fonts.headingBold, fontSize: 23, marginTop: 13 },
  handle: { color: colors.muted, fontFamily: fonts.body, fontSize: 14, marginTop: 4 },
  activeBadge: { marginTop: 13, borderRadius: radii.pill, backgroundColor: "#302960", paddingHorizontal: 10, paddingVertical: 6, flexDirection: "row", alignItems: "center", gap: 6 },
  activeBadgeText: { color: colors.primary, fontFamily: fonts.bodySemibold, fontSize: 12 },
  section: { backgroundColor: colors.surface, borderRadius: radii.lg, padding: 16, gap: 4 },
  sectionTitle: { color: colors.muted, fontFamily: fonts.bodyBold, fontSize: 12, letterSpacing: 0.4, marginBottom: 6 },
  detailRow: { minHeight: 64, borderTopWidth: 1, borderTopColor: colors.border, flexDirection: "row", alignItems: "center", gap: 11 },
  detailIcon: { width: 38, height: 38, borderRadius: 12, backgroundColor: "#2c2552", alignItems: "center", justifyContent: "center" },
  detailCopy: { flex: 1, minWidth: 0, gap: 4 },
  detailLabel: { color: colors.muted, fontFamily: fonts.body, fontSize: 12 },
  detailValue: { color: colors.foreground, fontFamily: fonts.bodySemibold, fontSize: 14 },
  actionRow: { minHeight: 70, borderTopWidth: 1, borderTopColor: colors.border, flexDirection: "row", alignItems: "center", gap: 11 },
  pressed: { opacity: 0.72 },
});
