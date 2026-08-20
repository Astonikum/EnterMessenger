import { Alert, Modal, Pressable, StyleSheet, Text, View } from "react-native";
import type { Profile } from "../types";
import { colors, fonts, radii } from "../theme";
import { Icon } from "./Icon";
import { ProfileAvatar } from "./Avatar";
import { SafeAreaSheet } from "./SafeAreaSheet";

type Props = { visible: boolean; profiles: Profile[]; activeProfile?: Profile; onClose: () => void; onSelect: (profile: Profile) => void; onAdd: () => void; onRemove: (profile: Profile) => void };

export function ProfileSheet({ visible, profiles, activeProfile, onClose, onSelect, onAdd, onRemove }: Props) {
  function confirmRemove(profile: Profile) {
    Alert.alert("Удалить профиль?", `${profile.name} будет удалён с этого устройства.`, [{ text: "Отмена", style: "cancel" }, { text: "Удалить", style: "destructive", onPress: () => onRemove(profile) }]);
  }

  return <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}><SafeAreaSheet onClose={onClose} sheetStyle={styles.sheet}>
    <View style={styles.handle} /><View style={styles.titleRow}><View><Text style={styles.title}>Профили</Text><Text style={styles.subtitle}>Аккаунты на разных серверах</Text></View><Pressable onPress={onClose} hitSlop={12}><Icon name="close" size={22} color={colors.muted} /></Pressable></View>
    {profiles.map((profile) => <View key={profile.id} style={styles.profileRow}>
      <Pressable style={({ pressed }) => [styles.profileMain, pressed && styles.pressed]} onPress={() => { onSelect(profile); onClose(); }} onLongPress={() => confirmRemove(profile)}>
        <ProfileAvatar name={profile.name} size={44} /><View style={styles.profileCopy}><Text style={styles.profileName}>{profile.name}</Text><Text style={styles.profileHandle} numberOfLines={1}>{profile.handle.replace(/^@/, "")}@{profile.server.replace(/^https?:\/\//, "")}</Text></View>{profile.id === activeProfile?.id && <Icon name="check" size={21} color={colors.primary} />}
      </Pressable>
      <Pressable onPress={() => confirmRemove(profile)} hitSlop={12}><Icon name="more" size={21} color={colors.muted} /></Pressable>
    </View>)}
    <Pressable style={({ pressed }) => [styles.add, pressed && styles.pressed]} onPress={() => { onClose(); onAdd(); }}><View style={styles.addIcon}><Icon name="plus" size={21} color={colors.primary} /></View><Text style={styles.addText}>Добавить сервер</Text></Pressable>
  </SafeAreaSheet></Modal>;
}

const styles = StyleSheet.create({
  sheet: { backgroundColor: colors.surface, borderTopLeftRadius: 26, borderTopRightRadius: 26, padding: 20, paddingBottom: 32, borderWidth: 1, borderColor: colors.border },
  handle: { width: 38, height: 4, borderRadius: radii.pill, backgroundColor: colors.border, alignSelf: "center", marginBottom: 20 },
  titleRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 18 },
  title: { color: colors.foreground, fontFamily: fonts.headingBold, fontSize: 22 },
  subtitle: { color: colors.muted, fontFamily: fonts.body, fontSize: 13, marginTop: 4 },
  profileRow: { minHeight: 64, borderRadius: radii.md, paddingHorizontal: 8, flexDirection: "row", alignItems: "center", gap: 12 },
  profileMain: { flex: 1, flexDirection: "row", alignItems: "center", gap: 12 },
  profileCopy: { flex: 1, gap: 4 },
  profileName: { color: colors.foreground, fontFamily: fonts.bodySemibold, fontSize: 15 },
  profileHandle: { color: colors.muted, fontFamily: fonts.body, fontSize: 12 },
  add: { minHeight: 56, marginTop: 10, borderTopWidth: 1, borderTopColor: colors.border, paddingTop: 16, flexDirection: "row", alignItems: "center", gap: 12 },
  addIcon: { width: 44, height: 44, borderRadius: 22, borderWidth: 1, borderStyle: "dashed", borderColor: colors.border, alignItems: "center", justifyContent: "center" },
  addText: { color: colors.muted, fontFamily: fonts.bodySemibold, fontSize: 15 },
  pressed: { opacity: 0.7 },
});
