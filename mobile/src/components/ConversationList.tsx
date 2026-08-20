import { useMemo, useState } from "react";
import { ActivityIndicator, FlatList, Image, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import type { Conversation, Profile, SearchUser } from "../types";
import { colors, fonts, radii } from "../theme";
import { Icon } from "./Icon";
import { ConversationAvatar, ProfileAvatar } from "./Avatar";
import { SafeAreaSheet } from "./SafeAreaSheet";

type Action = "pin" | "mute" | "archive" | "delete" | "unread" | "folder";
type Props = {
  profile?: Profile;
  syncConnected?: boolean;
  conversations: Conversation[];
  activeFolder?: string;
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
};

const ALL_FOLDER = "all";
const DEFAULT_FOLDER = "Личное";

function preview(value: string) {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > 54 ? `${compact.slice(0, 54).trimEnd()}…` : compact;
}

export function ConversationList({ profile, syncConnected = false, conversations, activeFolder = ALL_FOLDER, activeId, query, searchUser, searchBusy, searchError, onQueryChange, onSelect, onProfilePress, onOpenSearchUser, onAction, onSelectFolder }: Props) {
  const folders = useMemo(() => [...new Set([DEFAULT_FOLDER, ...conversations.map((item) => item.folder).filter((folder): folder is string => Boolean(folder))])], [conversations]);
  const visible = useMemo(() => conversations.filter((item) => !item.archived && !item.deleted && (activeFolder === ALL_FOLDER || item.folder === activeFolder) && `${item.name} ${item.handle ?? ""} ${item.lastMessage}`.toLowerCase().includes(query.toLowerCase())).sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned))), [activeFolder, conversations, query]);

  return <View style={styles.root}>
    <View style={styles.header}><Image source={require("../../assets/enter_logo.png")} style={styles.logoImage} resizeMode="contain" accessibilityLabel="Enter" /><View style={styles.headerTitle}><Text style={styles.headerTitleText}>{syncConnected ? "Сообщения" : "Подключение..."}</Text></View><Pressable onPress={onProfilePress} hitSlop={8}>{profile ? <ProfileAvatar name={profile.name} size={40} /> : <View style={styles.emptyProfile}><Icon name="plus" size={19} color={colors.muted} /></View>}</Pressable></View>
    <View style={styles.search}><Icon name="search" size={19} color={colors.muted} /><TextInput value={query} onChangeText={onQueryChange} placeholder="Поиск чатов или @username" placeholderTextColor={colors.muted} autoCapitalize="none" style={styles.searchInput} returnKeyType="search" /></View>
    <ScrollView bounces={false} horizontal style={styles.folderScroll} showsHorizontalScrollIndicator={false} contentContainerStyle={styles.folderBar}>
      <FolderChip active={activeFolder === ALL_FOLDER} icon="chat" label="Все чаты" onPress={() => onSelectFolder(ALL_FOLDER)} />
      {folders.map((folder) => <FolderChip key={folder} active={activeFolder === folder} icon="folder" label={folder} onPress={() => onSelectFolder(folder)} />)}
    </ScrollView>
    {searchBusy && <View style={styles.inlineNotice}><ActivityIndicator size="small" color={colors.primary} /><Text style={styles.noticeText}>Ищем пользователя…</Text></View>}
    {!!searchError && <View style={[styles.inlineNotice, styles.errorNotice]}><Icon name="error" size={18} color={colors.danger} /><Text style={[styles.noticeText, styles.errorText]}>{searchError}</Text></View>}
    {searchUser && <Pressable style={styles.searchResult} onPress={() => onOpenSearchUser(searchUser)} disabled={searchUser.deviceCount === 0}><ProfileAvatar name={searchUser.name} size={44} /><View style={styles.rowCopy}><Text style={styles.rowName}>{searchUser.name}</Text><Text style={styles.rowMeta} numberOfLines={1}>@{searchUser.handle} · {searchUser.server.replace(/^https?:\/\//, "")}</Text></View><Icon name="arrowForward" size={19} color={colors.muted} /></Pressable>}
    <FlatList bounces={false} data={visible} keyExtractor={(item) => item.id} contentContainerStyle={styles.list} showsVerticalScrollIndicator={false} renderItem={({ item }) => <ConversationRow conversation={item} active={activeId === item.id} onSelect={() => onSelect(item.id)} onAction={onAction} />} ListEmptyComponent={<View style={styles.empty}><Text style={styles.emptyTitle}>Нет чатов</Text></View>} />
  </View>;
}

function ConversationRow({ conversation, active, onSelect, onAction }: { conversation: Conversation; active: boolean; onSelect: () => void; onAction: (conversation: Conversation, action: Action) => void }) {
  const [actionsVisible, setActionsVisible] = useState(false);
  function openActions() {
    setActionsVisible(true);
  }

  function runAction(action: Action) {
    setActionsVisible(false);
    onAction(conversation, action);
  }

  return <>
    <View>
    <Pressable onPress={onSelect} onLongPress={openActions} style={({ pressed }) => [styles.row, active && styles.activeRow, pressed && styles.pressed]}>
    <View><ConversationAvatar conversation={conversation} size={48} />{conversation.online && <View style={styles.online} />}</View>
    <View style={styles.rowCopy}><View style={styles.nameLine}><Text style={styles.rowName} numberOfLines={1}>{conversation.name}</Text>{conversation.pinned && <Icon name="pin" size={13} color={colors.primary} />}{conversation.muted && <Icon name="notificationsOff" size={13} color={colors.muted} />}{conversation.folder && <Icon name="folder" size={13} color={colors.muted} />}</View><View style={styles.previewLine}><Text style={styles.rowMessage} numberOfLines={1}>{preview(conversation.lastMessage)}</Text>{conversation.time ? <Text style={styles.rowTime}>{conversation.time}</Text> : null}</View></View>
    <View style={styles.rowRight}>{conversation.unread ? <View style={styles.unread}><Text style={styles.unreadText}>{conversation.unread}</Text></View> : null}</View>
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
            <ConversationAction icon="folder" label={conversation.folder ? "Убрать из папки" : "Добавить в папку"} onPress={() => runAction("folder")} />
            <ConversationAction icon="archive" label="Архивировать" onPress={() => runAction("archive")} />
            <ConversationAction icon="delete" label="Удалить чат" destructive onPress={() => runAction("delete")} />
          </View>
      </SafeAreaSheet>
    </Modal>
  </>;
}

function FolderChip({ active, icon, label, onPress }: { active: boolean; icon: "chat" | "folder"; label: string; onPress: () => void }) {
  return <Pressable style={({ pressed }) => [styles.folderChip, active && styles.folderChipActive, pressed && styles.pressed]} onPress={onPress}><Icon name={icon} size={15} color={active ? colors.foreground : colors.muted} /><Text style={[styles.folderText, active && styles.folderTextActive]}>{label}</Text></Pressable>;
}

function ConversationAction({ icon, label, onPress, destructive = false }: { icon: "pin" | "notifications" | "notificationsOff" | "chat" | "folder" | "archive" | "delete"; label: string; onPress: () => void; destructive?: boolean }) {
  return <Pressable style={({ pressed }) => [styles.actionRow, pressed && styles.actionPressed]} onPress={onPress}><Icon name={icon} size={20} color={destructive ? colors.danger : colors.foreground} /><Text style={[styles.actionLabel, destructive && styles.actionDanger]}>{label}</Text></Pressable>;
}

export type { Action };

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  header: { position: "relative", paddingHorizontal: 20, paddingTop: 12, paddingBottom: 10, flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  logoImage: { width: 92, height: 23 },
  headerTitle: { position: "absolute", left: 0, right: 0, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8 },
  headerTitleText: { color: colors.foreground, fontFamily: fonts.headingBold, fontSize: 18 },
  emptyProfile: { width: 40, height: 40, borderRadius: 20, borderWidth: 1, borderStyle: "dashed", borderColor: colors.border, alignItems: "center", justifyContent: "center" },
  search: { marginHorizontal: 16, marginBottom: 12, minHeight: 46, borderRadius: radii.md, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 13 },
  searchInput: { flex: 1, color: colors.foreground, fontFamily: fonts.body, fontSize: 14, paddingVertical: 0 },
  folderScroll: { height: 32, flexGrow: 0 },
  folderBar: { gap: 8, paddingHorizontal: 16, alignItems: "center" },
  folderChip: { height: 30, minHeight: 0, borderRadius: 15, borderWidth: 1, borderColor: colors.border, paddingHorizontal: 12, flexDirection: "row", alignItems: "center", gap: 6, backgroundColor: colors.surface },
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
  activeRow: { backgroundColor: colors.accent },
  pressed: { opacity: 0.72 },
  online: { position: "absolute", right: -1, bottom: 1, width: 12, height: 12, borderRadius: 6, backgroundColor: colors.success, borderWidth: 2, borderColor: colors.background },
  rowCopy: { flex: 1, minWidth: 0, gap: 5 },
  nameLine: { flexDirection: "row", alignItems: "center", gap: 5 },
  previewLine: { minWidth: 0, flexDirection: "row", alignItems: "center", gap: 8 },
  rowName: { flexShrink: 1, color: colors.foreground, fontFamily: fonts.bodySemibold, fontSize: 15 },
  rowMeta: { color: colors.muted, fontFamily: fonts.body, fontSize: 12 },
  rowMessage: { flex: 1, minWidth: 0, color: colors.muted, fontFamily: fonts.body, fontSize: 13 },
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
