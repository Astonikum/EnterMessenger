import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, FlatList, Image, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import type { Conversation, Profile, SearchUser } from "../types";
import { folderContains, type ChatFolder } from "../folders";
import { colors, fonts, radii, type ThemeColors } from "../theme";
import { Icon } from "./Icon";
import { ConversationAvatar, ProfileAvatar } from "./Avatar";
import { SafeAreaSheet } from "./SafeAreaSheet";
import { FolderEditorSheet, FolderMenuSheet, FolderPickerSheet, type FolderDraft } from "./FolderSheets";
import { readSettings } from "../settings";

type Action = "pin" | "mute" | "archive" | "delete" | "unread" | "folder";
type Props = {
  profile?: Profile;
  themeColors?: ThemeColors;
  syncConnected?: boolean;
  conversations: Conversation[];
  folders: ChatFolder[];
  activeFolder?: string;
  listLayout?: "two-line" | "three-line";
  activeId: string | null;
  query: string;
  searchUser?: SearchUser | null;
  searchBusy?: boolean;
  searchError?: string;
  onQueryChange: (value: string) => void;
  onSelect: (id: string) => void;
  onProfilePress: () => void;
  onOpenSearchUser: (user: SearchUser) => void;
  onAction: (conversation: Conversation, action: Action) => void;
  onSelectFolder: (folder: string) => void;
  onCreateFolder: (draft: FolderDraft) => void;
  onUpdateFolder: (folder: ChatFolder) => void;
  onDeleteFolder: (folder: ChatFolder) => void;
  onToggleConversationFolder: (conversationId: string, folderId: string, included: boolean) => void;
};

const ALL_FOLDER = "all";

function preview(value: string) {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > 54 ? `${compact.slice(0, 54).trimEnd()}…` : compact;
}

export function ConversationList({ profile, themeColors = colors, syncConnected = false, conversations, folders, activeFolder = ALL_FOLDER, listLayout = "two-line", activeId, query, searchUser, searchBusy, searchError, onQueryChange, onSelect, onProfilePress, onOpenSearchUser, onAction, onSelectFolder, onCreateFolder, onUpdateFolder, onDeleteFolder, onToggleConversationFolder }: Props) {
  const [folderMenu, setFolderMenu] = useState<ChatFolder>();
  const [folderEditor, setFolderEditor] = useState<ChatFolder | "new" | null>(null);
  const [folderTarget, setFolderTarget] = useState<Conversation>();
  const [density, setDensity] = useState<"comfortable" | "compact">("comfortable");
  useEffect(() => { void readSettings().then((settings) => setDensity(settings.density)); }, []);
  const visible = useMemo(() => conversations.filter((item) => !item.archived && !item.deleted && (activeFolder === ALL_FOLDER || folders.some((folder) => folder.id === activeFolder && folderContains(folder, item))) && `${item.name} ${item.handle ?? ""} ${item.lastMessage}`.toLowerCase().includes(query.toLowerCase())).sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned))), [activeFolder, conversations, folders, query]);

  return <View style={[styles.root, { backgroundColor: themeColors.background }]}>
    <View style={[styles.header, { backgroundColor: themeColors.background }]}><Image source={require("../../assets/enter_logo.png")} style={styles.logoImage} resizeMode="contain" accessibilityLabel="Enter" /><View style={styles.headerTitle}><Text style={[styles.headerTitleText, { color: themeColors.foreground }]}>{syncConnected ? "Сообщения" : "Подключение..."}</Text></View><Pressable onPress={onProfilePress} hitSlop={8}>{profile ? <ProfileAvatar name={profile.name} size={40} /> : <View style={[styles.emptyProfile, { borderColor: themeColors.border }]}><Icon name="plus" size={19} color={themeColors.muted} /></View>}</Pressable></View>
    <View style={[styles.search, { backgroundColor: themeColors.surface, borderColor: themeColors.border }]}><Icon name="search" size={19} color={themeColors.muted} /><TextInput value={query} onChangeText={onQueryChange} placeholder="Поиск чатов или @username" placeholderTextColor={themeColors.muted} autoCapitalize="none" style={[styles.searchInput, { color: themeColors.foreground }]} returnKeyType="search" /></View>
    <ScrollView bounces={false} horizontal style={styles.folderScroll} showsHorizontalScrollIndicator={false} contentContainerStyle={styles.folderBar}>
      <FolderChip themeColors={themeColors} active={activeFolder === ALL_FOLDER} icon="chat" label="Все чаты" onPress={() => onSelectFolder(ALL_FOLDER)} />
      {folders.map((folder) => <FolderChip key={folder.id} themeColors={themeColors} active={activeFolder === folder.id} icon={folder.icon} label={folder.name} onPress={() => onSelectFolder(folder.id)} onLongPress={() => setFolderMenu(folder)} />)}
      <Pressable accessibilityLabel="+" onPress={() => setFolderEditor("new")} style={({ pressed }) => [styles.folderChip, styles.folderAddButton, { backgroundColor: themeColors.surface, borderColor: themeColors.border }, pressed && styles.pressed]}><Icon name="plus" size={15} color={themeColors.muted} /></Pressable>
    </ScrollView>
    {searchBusy && <View style={[styles.inlineNotice, { backgroundColor: themeColors.surface }]}><ActivityIndicator size="small" color={themeColors.primary} /><Text style={[styles.noticeText, { color: themeColors.muted }]}>Ищем пользователя…</Text></View>}
    {!!searchError && <View style={[styles.inlineNotice, styles.errorNotice, { backgroundColor: themeColors.surface }]}><Icon name="error" size={18} color={themeColors.danger} /><Text style={[styles.noticeText, styles.errorText, { color: themeColors.danger }]}>{searchError}</Text></View>}
    {searchUser && <Pressable style={[styles.searchResult, { backgroundColor: themeColors.accent }]} onPress={() => onOpenSearchUser(searchUser)} disabled={searchUser.deviceCount === 0}><ProfileAvatar name={searchUser.name} size={44} /><View style={styles.rowCopy}><Text style={[styles.rowName, { color: themeColors.foreground }]}>{searchUser.name}</Text><Text style={[styles.rowMeta, { color: themeColors.muted }]} numberOfLines={1}>@{searchUser.handle} · {searchUser.server.replace(/^https?:\/\//, "")}</Text></View><Icon name="arrowForward" size={19} color={themeColors.muted} /></Pressable>}
    <FlatList bounces={false} data={visible} keyExtractor={(item) => item.id} contentContainerStyle={styles.list} showsVerticalScrollIndicator={false} renderItem={({ item }) => <ConversationRow themeColors={themeColors} conversation={item} folders={folders} listLayout={listLayout} density={density} active={activeId === item.id} onSelect={() => onSelect(item.id)} onAction={onAction} onOpenFolderPicker={() => setFolderTarget(item)} />} ListEmptyComponent={<View style={styles.empty}><Text style={[styles.emptyTitle, { color: themeColors.foreground }]}>Нет чатов</Text></View>} />
    <FolderMenuSheet visible={Boolean(folderMenu)} folder={folderMenu} onClose={() => setFolderMenu(undefined)} onOpen={() => { if (folderMenu) onSelectFolder(folderMenu.id); }} onEdit={() => { if (folderMenu) setFolderEditor(folderMenu); }} onDelete={() => { if (folderMenu) onDeleteFolder(folderMenu); }} />
    <FolderEditorSheet visible={folderEditor !== null} folder={folderEditor === "new" ? null : folderEditor} onClose={() => setFolderEditor(null)} onSave={(draft) => { if (folderEditor === "new") onCreateFolder(draft); else if (folderEditor) onUpdateFolder({ ...folderEditor, ...draft }); setFolderEditor(null); }} />
    <FolderPickerSheet visible={Boolean(folderTarget)} conversation={folderTarget} folders={folders} onClose={() => setFolderTarget(undefined)} onToggle={(folderId, included) => { if (folderTarget) onToggleConversationFolder(folderTarget.id, folderId, included); }} />
  </View>;
}

function ConversationRow({ themeColors = colors, conversation, folders, listLayout, density = "comfortable", active, onSelect, onAction, onOpenFolderPicker }: { themeColors?: ThemeColors; conversation: Conversation; folders: ChatFolder[]; listLayout: "two-line" | "three-line"; density?: "comfortable" | "compact"; active: boolean; onSelect: () => void; onAction: (conversation: Conversation, action: Action) => void; onOpenFolderPicker: () => void }) {
  const [actionsVisible, setActionsVisible] = useState(false);
  function openActions() {
    setActionsVisible(true);
  }

  function runAction(action: Action) {
    setActionsVisible(false);
    if (action === "folder") { onOpenFolderPicker(); return; }
    onAction(conversation, action);
  }

  return <>
    <View>
    <Pressable onPress={onSelect} onLongPress={openActions} style={({ pressed }) => [styles.row, density === "compact" && styles.compactRow, active && { backgroundColor: themeColors.accent }, pressed && styles.pressed]}>
    <View><ConversationAvatar conversation={conversation} size={48} />{conversation.online && <View style={[styles.online, { borderColor: themeColors.background }]} />}</View>
    <View style={styles.rowCopy}><View style={styles.nameLine}><Text style={[styles.rowName, { color: themeColors.foreground }]} numberOfLines={1}>{conversation.name}</Text>{conversation.pinned && <Icon name="pin" size={13} color={themeColors.primary} />}{conversation.muted && <Icon name="notificationsOff" size={13} color={themeColors.muted} />}{folders.some((folder) => folderContains(folder, conversation)) ? <Icon name="folder" size={13} color={themeColors.muted} /> : null}</View><View style={styles.previewLine}><Text style={[styles.rowMessage, { color: themeColors.muted }]} numberOfLines={1}>{preview(conversation.lastMessage)}</Text>{conversation.time ? <Text style={[styles.rowTime, { color: themeColors.muted }]}>{conversation.time}</Text> : null}</View>{listLayout === "three-line" && <Text style={[styles.rowExtra, { color: themeColors.muted }]} numberOfLines={1}>{conversation.handle ? `@${conversation.handle.replace(/^@/, "")}` : conversation.online ? "В сети" : "Не в сети"}</Text>}</View>
    <View style={styles.rowRight}>{conversation.unread ? <View style={[styles.unread, { backgroundColor: themeColors.primary }]}><Text style={[styles.unreadText, { color: themeColors.primaryText }]}>{conversation.unread}</Text></View> : null}</View>
    </Pressable>
    </View>
    <Modal visible={actionsVisible} transparent animationType="slide" onRequestClose={() => setActionsVisible(false)}>
      <SafeAreaSheet onClose={() => setActionsVisible(false)} sheetStyle={styles.actionSheet}>
          <View style={styles.handle} />
          <View style={styles.sheetTitleRow}><View style={styles.sheetTitleCopy}><Text style={styles.sheetTitle}>{conversation.name}</Text><Text style={styles.sheetSubtitle} numberOfLines={1}>{conversation.lastMessage}</Text></View><ConversationAvatar conversation={conversation} size={42} /></View>
          <View style={styles.actionList}>
            <ConversationAction icon="pin" label={conversation.pinned ? "Открепить" : "Закрепить"} onPress={() => runAction("pin")} />
            <ConversationAction icon={conversation.muted ? "notifications" : "notificationsOff"} label={conversation.muted ? "Включить уведомления" : "Выключить уведомления"} onPress={() => runAction("mute")} />
            <ConversationAction icon="chat" label="Пометить как непрочитанное" onPress={() => runAction("unread")} />
            <ConversationAction icon="folder" label="Настроить папки" onPress={() => runAction("folder")} />
            <ConversationAction icon="archive" label="Архивировать" onPress={() => runAction("archive")} />
            <ConversationAction icon="delete" label="Удалить чат" destructive onPress={() => runAction("delete")} />
          </View>
      </SafeAreaSheet>
    </Modal>
  </>;
}

function FolderChip({ themeColors = colors, active, icon, label, onPress, onLongPress }: { themeColors?: ThemeColors; active: boolean; icon: "chat" | "folder" | "person" | "star" | "bookmark"; label: string; onPress: () => void; onLongPress?: () => void }) {
  return <Pressable style={({ pressed }) => [styles.folderChip, { backgroundColor: themeColors.surface, borderColor: themeColors.border }, active && { borderColor: themeColors.primary, backgroundColor: themeColors.accent }, pressed && styles.pressed]} onPress={onPress} onLongPress={onLongPress}><Icon name={icon} size={15} color={active ? themeColors.foreground : themeColors.muted} /><Text style={[styles.folderText, { color: themeColors.muted }, active && { color: themeColors.foreground }]}>{label}</Text></Pressable>;
}

function ConversationAction({ icon, label, onPress, destructive = false }: { icon: "pin" | "notifications" | "notificationsOff" | "chat" | "folder" | "archive" | "delete"; label: string; onPress: () => void; destructive?: boolean }) {
  return <Pressable style={({ pressed }) => [styles.actionRow, pressed && styles.actionPressed]} onPress={onPress}><Icon name={icon} size={20} color={destructive ? colors.danger : colors.foreground} /><Text style={[styles.actionLabel, destructive && styles.actionDanger]}>{label}</Text></Pressable>;
}

export type { Action };

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  header: { position: "relative", minHeight: 70, paddingHorizontal: 20, flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  logoImage: { width: 92, height: 23 },
  headerTitle: { position: "absolute", left: 0, right: 0, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8 },
  headerTitleText: { color: colors.foreground, fontFamily: fonts.headingBold, fontSize: 19 },
  emptyProfile: { width: 40, height: 40, borderRadius: 20, borderWidth: 1, borderStyle: "dashed", borderColor: colors.border, alignItems: "center", justifyContent: "center" },
  search: { marginHorizontal: 16, marginBottom: 12, minHeight: 46, borderRadius: radii.md, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 13 },
  searchInput: { flex: 1, color: colors.foreground, fontFamily: fonts.body, fontSize: 14, paddingVertical: 0 },
  folderScroll: { height: 32, flexGrow: 0 },
  folderBar: { gap: 8, paddingHorizontal: 16, alignItems: "center" },
  folderChip: { height: 30, minHeight: 0, borderRadius: 15, borderWidth: 1, borderColor: colors.border, paddingHorizontal: 12, flexDirection: "row", alignItems: "center", gap: 6, backgroundColor: colors.surface },
  folderAddButton: { width: 30, paddingHorizontal: 0, justifyContent: "center" },
  folderChipActive: { borderColor: colors.primary, backgroundColor: colors.accent },
  folderText: { color: colors.muted, fontFamily: fonts.bodySemibold, fontSize: 12 },
  folderTextActive: { color: colors.foreground },
  inlineNotice: { marginHorizontal: 16, marginBottom: 8, borderRadius: radii.sm, backgroundColor: colors.surface, padding: 10, flexDirection: "row", alignItems: "center", gap: 8 },
  noticeText: { color: colors.muted, flex: 1, fontFamily: fonts.body, fontSize: 12 },
  errorNotice: { backgroundColor: "#321d20" },
  errorText: { color: "#ffb5b1" },
  searchResult: { marginHorizontal: 12, marginBottom: 8, padding: 10, borderRadius: radii.md, backgroundColor: colors.accent, flexDirection: "row", alignItems: "center", gap: 12 },
  list: { flexGrow: 1, paddingHorizontal: 12, paddingBottom: 18 },
  row: { minHeight: 72, borderRadius: radii.md, paddingHorizontal: 8, paddingVertical: 9, flexDirection: "row", alignItems: "center", gap: 12 },
  compactRow: { minHeight: 58, paddingVertical: 5, gap: 9 },
  activeRow: { backgroundColor: colors.accent },
  pressed: { opacity: 0.72 },
  online: { position: "absolute", right: -1, bottom: 1, width: 12, height: 12, borderRadius: 6, backgroundColor: colors.success, borderWidth: 2, borderColor: colors.background },
  rowCopy: { flex: 1, minWidth: 0, gap: 5 },
  nameLine: { flexDirection: "row", alignItems: "center", gap: 5 },
  previewLine: { minWidth: 0, flexDirection: "row", alignItems: "center", gap: 8 },
  rowName: { flexShrink: 1, color: colors.foreground, fontFamily: fonts.bodySemibold, fontSize: 15 },
  rowMeta: { color: colors.muted, fontFamily: fonts.body, fontSize: 12 },
  rowMessage: { flex: 1, minWidth: 0, color: colors.muted, fontFamily: fonts.body, fontSize: 13 },
  rowExtra: { color: colors.muted, fontFamily: fonts.body, fontSize: 11 },
  rowRight: { alignItems: "flex-end", alignSelf: "stretch", justifyContent: "center", gap: 6, paddingVertical: 1 },
  rowTime: { color: colors.muted, fontFamily: fonts.body, fontSize: 11 },
  unread: { minWidth: 20, height: 20, borderRadius: 10, backgroundColor: colors.primary, alignItems: "center", justifyContent: "center", paddingHorizontal: 5 },
  unreadText: { color: colors.primaryText, fontFamily: fonts.bodyBold, fontSize: 11 },
  empty: { flex: 1, alignItems: "center", justifyContent: "center", paddingHorizontal: 30 },
  emptyTitle: { color: colors.foreground, fontFamily: fonts.headingBold, fontSize: 15 },
  actionSheet: { backgroundColor: colors.surface, borderTopLeftRadius: 26, borderTopRightRadius: 26, padding: 18, paddingBottom: 28, borderWidth: 1, borderColor: colors.border },
  handle: { width: 38, height: 4, borderRadius: 4, backgroundColor: colors.border, alignSelf: "center", marginBottom: 18 },
  sheetTitleRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 14 },
  sheetTitleCopy: { flex: 1, gap: 4 },
  sheetTitle: { color: colors.foreground, fontFamily: fonts.headingBold, fontSize: 19 },
  sheetSubtitle: { color: colors.muted, fontFamily: fonts.body, fontSize: 12 },
  actionList: { borderTopWidth: 1, borderTopColor: colors.border },
  actionRow: { minHeight: 50, borderBottomWidth: 1, borderBottomColor: colors.border, flexDirection: "row", alignItems: "center", gap: 12 },
  actionPressed: { opacity: 0.65 },
  actionLabel: { flex: 1, color: colors.foreground, fontFamily: fonts.body, fontSize: 14 },
  actionDanger: { color: colors.danger },
});
