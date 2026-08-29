import { useEffect, useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import type { Conversation } from "../types";
import { FOLDER_ICONS, FOLDER_TEMPLATES, folderContains, type ChatFolder } from "../folders";
import { colors, fonts, radii } from "../theme";
import { Icon } from "./Icon";
import { SafeAreaSheet } from "./SafeAreaSheet";

export type FolderDraft = Pick<ChatFolder, "name" | "template" | "icon">;

const EMPTY_DRAFT: FolderDraft = { name: "", template: "custom", icon: "folder" };

function SheetButton({ label, onPress, primary = false }: { label: string; onPress: () => void; primary?: boolean }) {
  return <Pressable style={({ pressed }) => [styles.sheetButton, primary && styles.primaryButton, pressed && styles.pressed]} onPress={onPress}><Text style={[styles.sheetButtonText, primary && styles.primaryButtonText]}>{label}</Text></Pressable>;
}

export function FolderEditorSheet({ visible, folder, onClose, onSave }: { visible: boolean; folder?: ChatFolder | null; onClose: () => void; onSave: (draft: FolderDraft) => void }) {
  const [draft, setDraft] = useState<FolderDraft>(EMPTY_DRAFT);

  useEffect(() => {
    setDraft(folder ? { name: folder.name, template: folder.template, icon: folder.icon } : EMPTY_DRAFT);
  }, [folder, visible]);

  function save() {
    const name = draft.name.trim();
    if (name) onSave({ ...draft, name });
  }

  return <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}><SafeAreaSheet onClose={onClose} sheetStyle={styles.sheet}>
    <View style={styles.handle} />
    <Text style={styles.title}>{folder ? "Настройки папки" : "Новая папка"}</Text>
    <ScrollView bounces={false} keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
      <TextInput value={draft.name} onChangeText={(name) => setDraft((current) => ({ ...current, name }))} placeholder="Например, Работа" placeholderTextColor={colors.muted} maxLength={40} autoFocus style={styles.input} />
      {FOLDER_TEMPLATES.map((option) => <Pressable key={option.id} style={({ pressed }) => [styles.templateOption, draft.template === option.id && styles.selectedOption, pressed && styles.pressed]} onPress={() => setDraft((current) => ({ ...current, template: option.id }))}><View style={styles.optionCopy}><Text style={styles.optionTitle}>{option.label}</Text></View>{draft.template === option.id && <Icon name="checkCircle" size={21} color={colors.primary} />}</Pressable>)}
      <View style={styles.icons}>{FOLDER_ICONS.map((option) => <Pressable key={option.id} accessibilityLabel={option.label} style={({ pressed }) => [styles.iconOption, draft.icon === option.id && styles.selectedIcon, pressed && styles.pressed]} onPress={() => setDraft((current) => ({ ...current, icon: option.id }))}><Icon name={option.id} size={21} color={draft.icon === option.id ? colors.primary : colors.muted} /></Pressable>)}</View>
    </ScrollView>
    <View style={styles.footer}><SheetButton label="Отмена" onPress={onClose} /><SheetButton label="Сохранить" onPress={save} primary /></View>
  </SafeAreaSheet></Modal>;
}

export function FolderPickerSheet({ visible, conversation, folders, onClose, onToggle }: { visible: boolean; conversation?: Conversation; folders: ChatFolder[]; onClose: () => void; onToggle: (folderId: string, included: boolean) => void }) {
  return <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}><SafeAreaSheet onClose={onClose} sheetStyle={styles.sheet}>
    <View style={styles.handle} />
    <Text style={styles.title} numberOfLines={1}>{conversation?.name ? `Папки: ${conversation.name}` : "Папки чата"}</Text>
    <ScrollView bounces={false} style={styles.pickerList} contentContainerStyle={styles.pickerContent}>
      {folders.length === 0 ? <Text style={styles.emptyText}>Сначала создайте папку.</Text> : folders.map((folder) => {
        const included = conversation ? folderContains(folder, conversation) : false;
        const automatic = folder.template !== "custom";
        return <Pressable key={folder.id} disabled={automatic} style={({ pressed }) => [styles.folderRow, pressed && styles.pressed]} onPress={() => onToggle(folder.id, !included)}><View style={[styles.folderIcon, included && styles.folderIconActive]}><Icon name={folder.icon} size={19} color={included ? colors.primary : colors.muted} /></View><View style={styles.optionCopy}><Text style={styles.optionTitle}>{folder.name}</Text></View><View style={[styles.checkbox, included && styles.checkboxActive]}>{included && <Icon name="check" size={14} color={colors.primaryText} />}</View></Pressable>;
      })}
    </ScrollView>
    <View style={styles.footer}><SheetButton label="Готово" onPress={onClose} primary /></View>
  </SafeAreaSheet></Modal>;
}

export function FolderMenuSheet({ visible, folder, onClose, onOpen, onEdit, onDelete }: { visible: boolean; folder?: ChatFolder; onClose: () => void; onOpen: () => void; onEdit: () => void; onDelete: () => void }) {
  if (!folder) return null;
  return <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}><SafeAreaSheet onClose={onClose} sheetStyle={styles.sheet}>
    <View style={styles.handle} /><View style={styles.folderHeading}><View style={styles.folderIconActive}><Icon name={folder.icon} size={20} color={colors.primary} /></View><Text style={styles.title}>{folder.name}</Text></View>
    <View style={styles.menuList}><Pressable style={({ pressed }) => [styles.menuRow, pressed && styles.pressed]} onPress={() => { onClose(); onOpen(); }}><Icon name="folder" size={20} color={colors.foreground} /><Text style={styles.menuText}>Открыть папку</Text></Pressable><Pressable style={({ pressed }) => [styles.menuRow, pressed && styles.pressed]} onPress={() => { onClose(); onEdit(); }}><Icon name="settings" size={20} color={colors.foreground} /><Text style={styles.menuText}>Настроить папку</Text></Pressable><Pressable style={({ pressed }) => [styles.menuRow, pressed && styles.pressed]} onPress={() => { onClose(); onDelete(); }}><Icon name="delete" size={20} color={colors.danger} /><Text style={[styles.menuText, styles.dangerText]}>Удалить папку</Text></Pressable></View>
  </SafeAreaSheet></Modal>;
}

const styles = StyleSheet.create({
  sheet: { backgroundColor: colors.surface, borderTopLeftRadius: 26, borderTopRightRadius: 26, borderWidth: 1, borderColor: colors.border, padding: 18, paddingBottom: 28, maxHeight: "92%" },
  handle: { width: 38, height: 4, borderRadius: 4, backgroundColor: colors.border, alignSelf: "center", marginBottom: 18 },
  title: { color: colors.foreground, fontFamily: fonts.headingBold, fontSize: 21 },
  content: { paddingTop: 22, paddingBottom: 4, gap: 9 },
  input: { minHeight: 46, borderRadius: radii.md, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.background, color: colors.foreground, fontFamily: fonts.body, fontSize: 15, paddingHorizontal: 13, paddingVertical: 0 },
  templateOption: { minHeight: 58, borderRadius: radii.md, borderWidth: 1, borderColor: colors.border, paddingHorizontal: 13, paddingVertical: 10, flexDirection: "row", alignItems: "center", gap: 10 },
  selectedOption: { borderColor: colors.primary, backgroundColor: colors.accent },
  optionCopy: { flex: 1, minWidth: 0, gap: 3 },
  optionTitle: { color: colors.foreground, fontFamily: fonts.bodySemibold, fontSize: 14 },
  icons: { flexDirection: "row", gap: 9, paddingBottom: 6 },
  iconOption: { width: 42, height: 42, borderRadius: 12, borderWidth: 1, borderColor: colors.border, alignItems: "center", justifyContent: "center" },
  selectedIcon: { borderColor: colors.primary, backgroundColor: colors.accent },
  footer: { flexDirection: "row", justifyContent: "flex-end", gap: 9, paddingTop: 16 },
  sheetButton: { minHeight: 42, borderRadius: radii.md, paddingHorizontal: 16, alignItems: "center", justifyContent: "center" },
  primaryButton: { backgroundColor: colors.primary },
  sheetButtonText: { color: colors.foreground, fontFamily: fonts.bodySemibold, fontSize: 14 },
  primaryButtonText: { color: colors.primaryText },
  pickerList: { marginTop: 18 },
  pickerContent: { gap: 8, paddingBottom: 4 },
  folderRow: { minHeight: 58, borderRadius: radii.md, paddingHorizontal: 10, paddingVertical: 8, backgroundColor: colors.background, flexDirection: "row", alignItems: "center", gap: 10 },
  folderIcon: { width: 38, height: 38, borderRadius: 11, backgroundColor: colors.surfaceRaised, alignItems: "center", justifyContent: "center" },
  folderIconActive: { width: 38, height: 38, borderRadius: 11, backgroundColor: colors.accent, alignItems: "center", justifyContent: "center" },
  checkbox: { width: 22, height: 22, borderRadius: 6, borderWidth: 1, borderColor: colors.border, alignItems: "center", justifyContent: "center" },
  checkboxActive: { borderColor: colors.primary, backgroundColor: colors.primary },
  emptyText: { color: colors.muted, fontFamily: fonts.body, fontSize: 14, paddingVertical: 14 },
  folderHeading: { flexDirection: "row", alignItems: "center", gap: 11 },
  menuList: { borderTopWidth: 1, borderTopColor: colors.border, marginTop: 18 },
  menuRow: { minHeight: 54, borderBottomWidth: 1, borderBottomColor: colors.border, flexDirection: "row", alignItems: "center", gap: 12 },
  menuText: { color: colors.foreground, fontFamily: fonts.body, fontSize: 15 },
  dangerText: { color: colors.danger },
  pressed: { opacity: 0.68 },
});
