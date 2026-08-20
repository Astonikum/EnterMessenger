import { useEffect, useMemo, useRef, useState } from "react";
import { Animated, Easing, FlatList, KeyboardAvoidingView, Modal, PanResponder, Platform, Pressable, ScrollView, Share, StyleSheet, Text, TextInput, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import type { Conversation, Message } from "../types";
import { makeId } from "../data";
import { colors, fonts, radii } from "../theme";
import { Icon } from "./Icon";
import { ConversationAvatar } from "./Avatar";
import { SafeAreaSheet } from "./SafeAreaSheet";

type Props = {
  conversation: Conversation;
  messages: Message[];
  error?: string;
  replyTo?: Message | null;
  editingMessage?: Message | null;
  onBack: () => void;
  onSend: (message: Message) => void;
  onReply: (message: Message) => void;
  onStartEdit?: (message: Message) => void;
  onEdit: (message: Message) => void;
  onPin: (message: Message) => void;
  onSave: (message: Message) => void;
  onDelete: (message: Message) => void;
  onReact: (message: Message, reaction: string) => void;
  onForward: (message: Message) => void;
  onCancelContext: () => void;
};

export function ChatScreen({ conversation, messages, error = "", replyTo, editingMessage, onBack, onSend, onReply, onStartEdit, onEdit, onPin, onSave, onDelete, onReact, onForward, onCancelContext }: Props) {
  const [text, setText] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [localEditingMessage, setLocalEditingMessage] = useState<Message | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [inputHeight, setInputHeight] = useState(36);
  const listRef = useRef<FlatList<Message>>(null);
  const contextMotion = useRef(new Animated.Value(0)).current;
  const activeEditingMessage = editingMessage ?? localEditingMessage;
  const startEditing = (message: Message) => {
    if (onStartEdit) onStartEdit(message);
    else { setLocalEditingMessage(message); setText(message.text); onCancelContext(); }
  };
  const visibleMessages = useMemo(() => {
    const value = searchQuery.trim().toLowerCase();
    return value ? messages.filter((message) => message.text.toLowerCase().includes(value)) : messages;
  }, [messages, searchQuery]);

  useEffect(() => setText(activeEditingMessage?.text ?? ""), [activeEditingMessage?.id]);
  useEffect(() => setSelectedIds((current) => current.filter((id) => messages.some((message) => message.id === id))), [messages]);
  useEffect(() => { if (visibleMessages.length) setTimeout(() => listRef.current?.scrollToEnd({ animated: false }), 30); }, [conversation.id, searchQuery]);
  useEffect(() => { Animated.timing(contextMotion, { toValue: replyTo || activeEditingMessage ? 1 : 0, duration: 130, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start(); }, [activeEditingMessage?.id, contextMotion, replyTo?.id]);

  function toggleSelection(messageId: string) {
    setSelectedIds((current) => current.includes(messageId) ? current.filter((id) => id !== messageId) : [...current, messageId]);
  }

  function submit() {
    const value = text.trim();
    if (!value || conversation.canWrite === false) return;
    if (activeEditingMessage) onEdit({ ...activeEditingMessage, text: value, edited: true });
    else onSend({ id: makeId(), author: "me", text: value, time: new Intl.DateTimeFormat("ru-RU", { hour: "2-digit", minute: "2-digit" }).format(new Date()), replyTo: replyTo ? { id: replyTo.id, text: replyTo.text } : undefined });
    setText(""); setInputHeight(36); setLocalEditingMessage(null); onCancelContext();
  }

  return <KeyboardAvoidingView style={styles.root} behavior={Platform.OS === "ios" ? "padding" : undefined} keyboardVerticalOffset={Platform.OS === "ios" ? 4 : 0}>
    <View style={styles.header}>{searchOpen ? <><Pressable onPress={() => { setSearchOpen(false); setSearchQuery(""); }} style={styles.headerButton} hitSlop={6}><Icon name="arrowBack" size={22} color={colors.foreground} /></Pressable><View style={styles.searchHeaderInput}><Icon name="search" size={18} color={colors.muted} /><TextInput value={searchQuery} onChangeText={setSearchQuery} placeholder="Поиск сообщений" placeholderTextColor={colors.muted} style={styles.searchInput} autoFocus /></View>{searchQuery.trim() ? <Text style={styles.matchCount}>{visibleMessages.length}</Text> : null}</> : <><Pressable onPress={onBack} style={styles.headerButton} hitSlop={6}><Icon name="arrowBack" size={22} color={colors.foreground} /></Pressable><ConversationAvatar conversation={conversation} size={44} /><View style={styles.headerCopy}><Text style={styles.headerName} numberOfLines={1}>{conversation.name}</Text><Text style={styles.headerSub} numberOfLines={1}>{conversation.subtitle ?? (conversation.online ? "в сети" : "был(а) недавно")}</Text></View><View style={styles.headerActions}><Pressable style={styles.headerButton} onPress={() => setSearchOpen(true)}><Icon name="search" size={20} color={colors.muted} /></Pressable></View></> }</View>
    {visibleMessages.length ? <View style={styles.messageArea}>
      {selectedIds.length > 0 && <View style={styles.selectionBar}><Text style={styles.selectionText}>Выбрано: {selectedIds.length}</Text><Pressable onPress={() => setSelectedIds([])} style={styles.selectionClose} hitSlop={8}><Icon name="close" size={17} color={colors.foreground} /></Pressable></View>}
      <FlatList
        ref={listRef}
        data={visibleMessages}
        keyExtractor={(item) => item.id}
        style={styles.messageList}
        contentContainerStyle={styles.messageListContent}
        bounces={false}
        showsVerticalScrollIndicator={false}
        onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: false })}
        ListHeaderComponent={<Text style={styles.day}>{searchQuery.trim() ? "РЕЗУЛЬТАТЫ ПОИСКА" : "СЕГОДНЯ"}</Text>}
        renderItem={({ item, index }) => <MessageBubble message={item} previous={visibleMessages[index - 1]} next={visibleMessages[index + 1]} selected={selectedIds.includes(item.id)} onToggleSelection={() => toggleSelection(item.id)} onReply={onReply} onStartEdit={startEditing} onPin={onPin} onSave={onSave} onDelete={onDelete} onReact={onReact} onForward={onForward} />}
      />
    </View> : <View style={styles.emptyChat}><View style={styles.emptyChatIcon}><Icon name={searchQuery.trim() ? "search" : conversation.canWrite === false ? "info" : "chat"} size={28} color={colors.primary} /></View><Text style={styles.emptyChatTitle}>{searchQuery.trim() ? "Ничего не найдено" : "Нет сообщений"}</Text><Text style={styles.emptyChatText}>{searchQuery.trim() ? "Попробуйте изменить запрос." : conversation.canWrite === false ? "Обновления появятся здесь." : "Начните общение"}</Text></View>}
    {error ? <Text style={styles.error}>{error}</Text> : null}
    {conversation.canWrite === false ? <View style={styles.readOnly}><Text style={styles.readOnlyText}>Этот чат доступен только для чтения</Text></View> : <View style={styles.composerWrap}>{(replyTo || activeEditingMessage) && <Animated.View style={{ opacity: contextMotion, transform: [{ translateX: contextMotion.interpolate({ inputRange: [0, 1], outputRange: [6, 0] }) }] }}><View style={styles.context}><View style={styles.contextAccent} /><View style={styles.contextCopy}><Text style={styles.contextTitle}>{activeEditingMessage ? "Редактирование сообщения" : "Ответ на сообщение"}</Text><Text style={styles.contextText} numberOfLines={1}>{activeEditingMessage?.text ?? replyTo?.text}</Text></View><Pressable onPress={() => { setText(""); setLocalEditingMessage(null); setInputHeight(36); onCancelContext(); }} hitSlop={10}><Icon name="close" size={18} color={colors.muted} /></Pressable></View></Animated.View>}<View style={styles.composer}><Pressable style={[styles.composerButton, styles.disabledAction]} disabled><Icon name="plus" size={21} color={colors.muted} /></Pressable><TextInput value={text} onChangeText={setText} placeholder="Написать сообщение…" placeholderTextColor={colors.muted} multiline maxLength={4000} scrollEnabled={inputHeight >= 112} onContentSizeChange={(event) => setInputHeight(Math.min(112, Math.max(36, event.nativeEvent.contentSize.height)))} style={[styles.messageInput, { height: inputHeight }]} onSubmitEditing={(event) => { if (Platform.OS !== "ios" && !event.nativeEvent.text.includes("\n")) submit(); }} blurOnSubmit={false} /><Pressable style={[styles.send, !text.trim() && styles.sendDisabled]} onPress={submit} disabled={!text.trim()}><Icon name="send" size={18} color={colors.primaryText} /></Pressable></View></View>}
  </KeyboardAvoidingView>;
}

function MessageBubble({ message, previous, next, selected = false, onToggleSelection, onReply, onStartEdit, onPin, onSave, onDelete, onReact, onForward }: { message: Message; previous?: Message; next?: Message; selected?: boolean; onToggleSelection: () => void; onReply: (message: Message) => void; onStartEdit: (message: Message) => void; onPin: (message: Message) => void; onSave: (message: Message) => void; onDelete: (message: Message) => void; onReact: (message: Message, reaction: string) => void; onForward: (message: Message) => void }) {
  const samePrevious = previous?.author === message.author && previous.time === message.time;
  const sameNext = next?.author === message.author && next.time === message.time;
  const bubblePosition = samePrevious
    ? sameNext
      ? (message.author === "me" ? styles.groupMiddleOut : styles.groupMiddleIn)
      : (message.author === "me" ? styles.groupBottomOut : styles.groupBottomIn)
    : styles.groupTop;
  const [actionsVisible, setActionsVisible] = useState(false);
  const swipeX = useRef(new Animated.Value(0)).current;
  const reactions = ["❤️", "💥", "👌", "👍", "👎", "🔥", "🥰", "👋"];

  const swipeResponder = useMemo(() => PanResponder.create({
    onMoveShouldSetPanResponder: (_, gesture) => gesture.dx > 10 && gesture.dx > Math.abs(gesture.dy) * 1.15,
    onPanResponderMove: (_, gesture) => swipeX.setValue(Math.min(64, Math.max(0, gesture.dx))),
    onPanResponderRelease: (_, gesture) => {
      if (gesture.dx > 52) onReply(message);
      Animated.timing(swipeX, { toValue: 0, duration: 100, easing: Easing.out(Easing.quad), useNativeDriver: true }).start();
    },
    onPanResponderTerminate: () => Animated.timing(swipeX, { toValue: 0, duration: 100, useNativeDriver: true }).start(),
  }), [message, onReply, swipeX]);

  function run(action: () => void) {
    setActionsVisible(false);
    action();
  }

  return <Animated.View {...swipeResponder.panHandlers} style={[styles.messageLine, message.author === "me" ? styles.outgoing : styles.incoming, !samePrevious ? styles.messageGap : styles.groupGap, { transform: [{ translateX: swipeX }] }]}><Animated.View pointerEvents="none" style={[styles.swipeReply, { opacity: swipeX.interpolate({ inputRange: [0, 52], outputRange: [0.15, 1] }), transform: [{ scale: swipeX.interpolate({ inputRange: [0, 52], outputRange: [0.7, 1] }) }] }]}><Icon name="reply" size={14} color={colors.primary} /></Animated.View><Pressable onLongPress={() => setActionsVisible(true)} delayLongPress={260} style={[styles.bubble, message.author === "me" ? styles.outBubble : styles.inBubble, bubblePosition, message.pinned && styles.pinned, selected && styles.selected]}>
    {message.replyTo && <View style={styles.replyQuote}><Text style={styles.replyQuoteLabel}>Ответ</Text><Text style={styles.replyQuoteText} numberOfLines={1}>{message.replyTo.text}</Text></View>}
    <Text style={[styles.messageText, message.author === "me" ? styles.outMessageText : styles.inMessageText]}>{message.text}</Text>{message.reaction && <Text style={styles.reaction}>{message.reaction}</Text>}{!sameNext && <View style={styles.messageMeta}><Text style={message.author === "me" ? styles.outMeta : styles.inMeta}>{message.time}{message.edited ? " · изменено" : ""}{message.deliveryStatus === "pending" ? " · отправляется" : message.deliveryStatus === "failed" ? " · не отправлено" : ""}</Text>{message.author === "me" && message.deliveryStatus === undefined && <Icon name={message.readAt ? "checkAll" : "check"} size={13} color="#d9d1ff" />}</View>}
  </Pressable><Modal visible={actionsVisible} transparent animationType="slide" onRequestClose={() => setActionsVisible(false)}><SafeAreaSheet onClose={() => setActionsVisible(false)} sheetStyle={styles.actionSheet}><View style={styles.handle} /><Text style={styles.actionTitle}>Сообщение</Text><ScrollView bounces={false} horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.reactionList}>{reactions.map((reaction) => <Pressable key={reaction} style={styles.reactionButton} onPress={() => run(() => onReact(message, reaction))}><Text style={styles.reactionButtonText}>{reaction}</Text></Pressable>)}</ScrollView><View style={styles.actionList}><ActionRow icon="reply" label="Ответить" onPress={() => run(() => onReply(message))} />{message.author === "me" && <ActionRow icon="edit" label="Изменить" onPress={() => run(() => onStartEdit(message))} />}<ActionRow icon="pin" label={message.pinned ? "Открепить" : "Закрепить"} onPress={() => run(() => onPin(message))} /><ActionRow icon="bookmark" label="Сохранить в Избранное" onPress={() => run(() => onSave(message))} /><ActionRow icon="copy" label="Копировать текст" onPress={() => run(() => void Clipboard.setStringAsync(message.text))} /><ActionRow icon="forward" label="Переслать" onPress={() => run(() => onForward(message))} /><ActionRow icon="share" label="Поделиться" onPress={() => run(() => void Share.share({ message: message.text }))} /><ActionRow icon="delete" label="Удалить" destructive onPress={() => run(() => onDelete(message))} /><ActionRow icon="checkCircle" label={selected ? "Снять выделение" : "Выделить"} onPress={() => run(onToggleSelection)} /></View></SafeAreaSheet></Modal></Animated.View>;
}

function ActionRow({ icon, label, onPress, destructive = false }: { icon: "reply" | "edit" | "pin" | "bookmark" | "copy" | "forward" | "share" | "delete" | "checkCircle"; label: string; onPress: () => void; destructive?: boolean }) {
  return <Pressable style={({ pressed }) => [styles.actionRow, pressed && styles.actionPressed]} onPress={onPress}><Icon name={icon} size={20} color={destructive ? colors.danger : colors.foreground} /><Text style={[styles.actionLabel, destructive && styles.actionDanger]}>{label}</Text></Pressable>;
}

export function ForwardSheet({ visible, message, conversations, currentId, onClose, onForward }: { visible: boolean; message?: Message | null; conversations: Conversation[]; currentId?: string | null; onClose: () => void; onForward: (id: string) => void }) {
  const [query, setQuery] = useState("");
  const targets = useMemo(() => conversations.filter((conversation) => conversation.id !== currentId && !conversation.archived && conversation.canWrite !== false && `${conversation.name} ${conversation.handle ?? ""}`.toLowerCase().includes(query.trim().toLowerCase())), [conversations, currentId, query]);
  return <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}><SafeAreaSheet onClose={onClose} sheetStyle={styles.forwardSheet}><View style={styles.handle} /><View style={styles.forwardTitle}><View><Text style={styles.sheetTitle}>Переслать сообщение</Text><Text style={styles.sheetSubtitle} numberOfLines={1}>{message?.text}</Text></View><Pressable onPress={onClose}><Icon name="close" size={21} color={colors.muted} /></Pressable></View><View style={styles.forwardSearch}><Icon name="search" size={19} color={colors.muted} /><TextInput value={query} onChangeText={setQuery} placeholder="Поиск чата" placeholderTextColor={colors.muted} style={styles.messageInput} autoFocus /></View><FlatList bounces={false} data={targets} keyExtractor={(item) => item.id} contentContainerStyle={styles.forwardList} ListEmptyComponent={<Text style={styles.noTargets}>Нет доступных чатов</Text>} renderItem={({ item }) => <Pressable style={styles.target} onPress={() => onForward(item.id)}><ConversationAvatar conversation={item} size={42} /><Text style={styles.targetName} numberOfLines={1}>{item.name}</Text><Icon name="forward" size={19} color={colors.muted} /></Pressable>} /></SafeAreaSheet></Modal>;
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  header: { minHeight: 70, paddingHorizontal: 12, paddingTop: 8, paddingBottom: 8, flexDirection: "row", alignItems: "center", gap: 10, borderBottomWidth: 1, borderBottomColor: colors.border },
  headerButton: { width: 38, height: 38, borderRadius: 19, alignItems: "center", justifyContent: "center" },
  headerCopy: { flex: 1, gap: 4 },
  headerName: { color: colors.foreground, fontFamily: fonts.bodyBold, fontSize: 15 },
  headerSub: { color: colors.muted, fontFamily: fonts.body, fontSize: 12 },
  headerActions: { flexDirection: "row", gap: 0, flexShrink: 0 },
  disabledAction: { opacity: 0.4 },
  searchHeaderInput: { flex: 1, minHeight: 42, borderRadius: 21, backgroundColor: colors.surface, paddingHorizontal: 12, flexDirection: "row", alignItems: "center", gap: 7 },
  searchInput: { flex: 1, color: colors.foreground, fontFamily: fonts.body, fontSize: 15, paddingVertical: 0 },
  matchCount: { minWidth: 22, color: colors.primary, fontFamily: fonts.body, fontSize: 12, textAlign: "right" },
  messageArea: { flex: 1 },
  messageList: { flex: 1 },
  messageListContent: { paddingHorizontal: 14, paddingVertical: 18 },
  selectionBar: { marginHorizontal: 14, marginTop: 8, minHeight: 40, borderRadius: radii.sm, borderWidth: 1, borderColor: "rgba(179,164,255,0.35)", backgroundColor: "rgba(27,27,27,0.96)", paddingHorizontal: 12, flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  selectionText: { color: colors.foreground, fontFamily: fonts.body, fontSize: 12 },
  selectionClose: { width: 28, height: 28, alignItems: "center", justifyContent: "center" },
  day: { color: colors.muted, fontFamily: fonts.bodyBold, fontSize: 10, letterSpacing: 2, textAlign: "center", marginBottom: 12 },
  messageLine: { flexDirection: "row", position: "relative" },
  swipeReply: { position: "absolute", left: 2, top: "50%", width: 24, height: 24, marginTop: -12, borderRadius: 12, backgroundColor: colors.accent, alignItems: "center", justifyContent: "center" },
  incoming: { justifyContent: "flex-start" },
  outgoing: { justifyContent: "flex-end" },
  messageGap: { marginTop: 9 },
  groupGap: { marginTop: 2 },
  bubble: { maxWidth: "90%", paddingHorizontal: 14, paddingVertical: 10, borderRadius: 19 },
  inBubble: { backgroundColor: colors.surfaceRaised, borderBottomLeftRadius: 6 },
  outBubble: { backgroundColor: colors.primary, borderBottomRightRadius: 6 },
  groupTop: {},
  groupMiddleOut: { borderTopRightRadius: 6, borderBottomRightRadius: 6 },
  groupMiddleIn: { borderTopLeftRadius: 6, borderBottomLeftRadius: 6 },
  groupBottomOut: { borderTopRightRadius: 0 },
  groupBottomIn: { borderTopLeftRadius: 0 },
  pinned: { borderWidth: 1, borderColor: colors.primary },
  selected: { borderWidth: 2, borderColor: colors.primary },
  messageText: { fontFamily: fonts.body, fontSize: 15, lineHeight: 21 },
  outMessageText: { color: colors.primaryText },
  inMessageText: { color: colors.foreground },
  messageMeta: { marginTop: 5, alignItems: "center", justifyContent: "flex-end", flexDirection: "row", gap: 4 },
  outMeta: { color: "#635b8d", fontFamily: fonts.body, fontSize: 10 },
  inMeta: { color: colors.muted, fontFamily: fonts.body, fontSize: 10 },
  reaction: { alignSelf: "flex-start", marginTop: 4, backgroundColor: "rgba(0,0,0,0.12)", borderRadius: 12, paddingHorizontal: 6, paddingVertical: 2, fontSize: 15 },
  replyQuote: { borderLeftWidth: 2, borderLeftColor: colors.primary, paddingLeft: 8, marginBottom: 6, gap: 2 },
  replyQuoteLabel: { color: colors.primary, fontFamily: fonts.bodyBold, fontSize: 10 },
  replyQuoteText: { color: colors.muted, fontFamily: fonts.body, fontSize: 11 },
  emptyChat: { flex: 1, alignItems: "center", justifyContent: "center", paddingHorizontal: 34, gap: 10 },
  emptyChatIcon: { width: 64, height: 64, borderRadius: 32, backgroundColor: "#29224d", alignItems: "center", justifyContent: "center", marginBottom: 2 },
  emptyChatTitle: { color: colors.foreground, fontFamily: fonts.headingBold, fontSize: 18 },
  emptyChatText: { color: colors.muted, fontFamily: fonts.body, textAlign: "center", fontSize: 14, lineHeight: 21 },
  error: { color: "#ffaaa6", backgroundColor: "#321d20", fontFamily: fonts.body, paddingHorizontal: 14, paddingVertical: 8, fontSize: 12 },
  readOnly: { minHeight: 56, borderTopWidth: 1, borderTopColor: colors.border, alignItems: "center", justifyContent: "center", flexDirection: "row", gap: 8 },
  readOnlyText: { color: colors.muted, fontFamily: fonts.body, fontSize: 12 },
  composerWrap: { borderTopWidth: 1, borderTopColor: colors.border, paddingHorizontal: 12, paddingVertical: 10, gap: 8 },
  composer: { minHeight: 48, borderWidth: 1, borderColor: colors.border, borderRadius: 24, backgroundColor: colors.surface, flexDirection: "row", alignItems: "flex-end", padding: 5, gap: 4 },
  composerButton: { width: 36, height: 36, borderRadius: 18, alignItems: "center", justifyContent: "center" },
  messageInput: { flex: 1, color: "#ffffff", fontFamily: fonts.body, fontSize: 15, minHeight: 36, maxHeight: 112, paddingHorizontal: 6, paddingVertical: 8 },
  send: { width: 38, height: 38, borderRadius: 19, backgroundColor: colors.primary, alignItems: "center", justifyContent: "center" },
  sendDisabled: { opacity: 0.42 },
  context: { minHeight: 48, backgroundColor: colors.surfaceRaised, borderRadius: radii.sm, padding: 8, flexDirection: "row", alignItems: "center", gap: 8 },
  contextAccent: { width: 3, alignSelf: "stretch", borderRadius: 2, backgroundColor: colors.primary },
  contextCopy: { flex: 1, gap: 3 },
  contextTitle: { color: colors.primary, fontFamily: fonts.bodyBold, fontSize: 11 },
  contextText: { color: colors.muted, fontFamily: fonts.body, fontSize: 12 },
  actionSheet: { maxHeight: "88%", backgroundColor: colors.surface, borderTopLeftRadius: 26, borderTopRightRadius: 26, padding: 18, paddingBottom: 28, borderWidth: 1, borderColor: colors.border },
  actionTitle: { color: colors.foreground, fontFamily: fonts.headingBold, fontSize: 19, marginBottom: 10 },
  reactionList: { gap: 8, paddingBottom: 14 },
  reactionButton: { width: 42, height: 42, borderRadius: 21, backgroundColor: colors.background, alignItems: "center", justifyContent: "center" },
  reactionButtonText: { fontSize: 21 },
  actionList: { borderTopWidth: 1, borderTopColor: colors.border },
  actionRow: { minHeight: 48, borderBottomWidth: 1, borderBottomColor: colors.border, flexDirection: "row", alignItems: "center", gap: 12 },
  actionPressed: { opacity: 0.65 },
  actionLabel: { flex: 1, color: colors.foreground, fontFamily: fonts.body, fontSize: 14 },
  actionDanger: { color: colors.danger },
  forwardSheet: { maxHeight: "82%", backgroundColor: colors.surface, borderTopLeftRadius: 26, borderTopRightRadius: 26, padding: 18, paddingBottom: 28, borderWidth: 1, borderColor: colors.border },
  handle: { width: 38, height: 4, borderRadius: 4, backgroundColor: colors.border, alignSelf: "center", marginBottom: 18 },
  forwardTitle: { flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between", gap: 12, marginBottom: 14 },
  sheetTitle: { color: colors.foreground, fontFamily: fonts.headingBold, fontSize: 19 },
  sheetSubtitle: { color: colors.muted, fontFamily: fonts.body, fontSize: 12, marginTop: 4, maxWidth: 280 },
  forwardSearch: { minHeight: 46, borderRadius: radii.md, backgroundColor: colors.background, borderWidth: 1, borderColor: colors.border, paddingHorizontal: 12, flexDirection: "row", alignItems: "center", gap: 7 },
  forwardList: { paddingTop: 10, gap: 4 },
  target: { minHeight: 58, borderRadius: radii.md, paddingHorizontal: 8, flexDirection: "row", alignItems: "center", gap: 12 },
  targetName: { flex: 1, color: colors.foreground, fontFamily: fonts.bodySemibold, fontSize: 15 },
  noTargets: { color: colors.muted, textAlign: "center", padding: 30 },
});
