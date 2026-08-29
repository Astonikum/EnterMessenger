import { useEffect, useMemo, useRef, useState } from "react";
import { Animated, Easing, FlatList, Image, KeyboardAvoidingView, Modal, PanResponder, Platform, Pressable, ScrollView, Share, StyleSheet, Text, TextInput, View } from "react-native";
import Clipboard from "@react-native-clipboard/clipboard";
import { pick, types } from "@react-native-documents/picker";
import { launchImageLibrary } from "react-native-image-picker";
import type { Conversation, Message, MessageAttachment, Profile } from "../types";
import type { MobileSettings } from "../settings";
import { MediaBubble, MediaGroup } from "./MediaBubble";
import type { EncryptedMedia, MobileMediaSource } from "../media";
import { makeId } from "../data";
import { colors, fonts, radii, type ThemeColors } from "../theme";
import { Icon } from "./Icon";
import { ConversationAvatar } from "./Avatar";
import { SafeAreaSheet } from "./SafeAreaSheet";
import { readSettings } from "../settings";
import { formatFileSize, presenceLabel, sameMessageStack } from "../../../common/src/format.ts";

type Props = {
  profile: Profile;
  conversation: Conversation;
  messages: Message[];
  error?: string;
  uploadProgress?: number | null;
  messageTextSize?: number;
  bubbleRadius?: number;
  themeColors?: ThemeColors;
  mediaSettings?: MobileSettings["media"];
  energySavingActive?: boolean;
  replyTo?: Message | null;
  editingMessage?: Message | null;
  onBack: () => void;
  onSend: (message: Message, pendingMedia?: PendingMedia[]) => void;
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

export type PendingMedia = { source: MobileMediaSource } | { encrypted: EncryptedMedia };

const MIN_MESSAGE_INPUT_HEIGHT = 21;
const MAX_MESSAGE_INPUT_HEIGHT = 112;

export function ChatScreen({ profile, conversation, messages, error = "", uploadProgress = null, messageTextSize = 16, bubbleRadius = 17, themeColors = colors, mediaSettings, energySavingActive = false, replyTo, editingMessage, onBack, onSend, onReply, onStartEdit, onEdit, onPin, onSave, onDelete, onReact, onForward, onCancelContext }: Props) {
  const [text, setText] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [localEditingMessage, setLocalEditingMessage] = useState<Message | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [inputHeight, setInputHeight] = useState(MIN_MESSAGE_INPUT_HEIGHT);
  const [inputScrollable, setInputScrollable] = useState(false);
  const [pendingMedia, setPendingMedia] = useState<PendingMedia[]>([]);
  const [density, setDensity] = useState<"comfortable" | "compact">("comfortable");
  const [attachmentMenuVisible, setAttachmentMenuVisible] = useState(false);
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
  useEffect(() => { void readSettings().then((settings) => setDensity(settings.density)); }, []);
  useEffect(() => setSelectedIds((current) => current.filter((id) => messages.some((message) => message.id === id))), [messages]);
  useEffect(() => { if (visibleMessages.length) setTimeout(() => listRef.current?.scrollToEnd({ animated: false }), 30); }, [conversation.id, searchQuery]);
  useEffect(() => { Animated.timing(contextMotion, { toValue: replyTo || activeEditingMessage ? 1 : 0, duration: 130, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start(); }, [activeEditingMessage?.id, contextMotion, replyTo?.id]);

  function toggleSelection(messageId: string) {
    setSelectedIds((current) => current.includes(messageId) ? current.filter((id) => id !== messageId) : [...current, messageId]);
  }

  function submit() {
    const value = text.trim();
    if (uploadProgress !== null || ((!value && pendingMedia.length === 0) || conversation.canWrite === false)) return;
    if (activeEditingMessage) onEdit({ ...activeEditingMessage, text: value, edited: true });
    else onSend({ id: makeId(), author: "me", text: value, time: new Intl.DateTimeFormat("ru-RU", { hour: "2-digit", minute: "2-digit" }).format(new Date()), replyTo: replyTo ? { id: replyTo.id, text: replyTo.text } : undefined }, pendingMedia);
    setText(""); setPendingMedia([]); setInputHeight(MIN_MESSAGE_INPUT_HEIGHT); setInputScrollable(false); setLocalEditingMessage(null); onCancelContext();
  }

  function handleInputTextChange(value: string) {
    setText(value);
    setInputScrollable(false);
    if (!value) setInputHeight(MIN_MESSAGE_INPUT_HEIGHT);
  }

  function handleInputContentSizeChange(event: { nativeEvent: { contentSize: { height: number } } }) {
    const contentHeight = Math.ceil(event.nativeEvent.contentSize.height);
    const nextHeight = Math.min(MAX_MESSAGE_INPUT_HEIGHT, Math.max(MIN_MESSAGE_INPUT_HEIGHT, contentHeight));
    setInputHeight(nextHeight);
    setInputScrollable(nextHeight >= MAX_MESSAGE_INPUT_HEIGHT);
  }

  function appendSources(sources: MobileMediaSource[]) {
    setPendingMedia((current) => [...current, ...sources.map((source) => ({ source }))].slice(0, 10));
  }

  async function pickGallery() {
    setAttachmentMenuVisible(false);
    const result = await launchImageLibrary({ mediaType: "mixed", selectionLimit: 0, quality: 1 });
    if (!result.didCancel) appendSources((result.assets ?? []).flatMap((asset) => asset.uri ? [{ uri: asset.uri, name: asset.fileName ?? `Медиа-${Date.now()}`, mimeType: asset.type ?? "application/octet-stream", size: asset.fileSize }] : []));
  }

  async function pickFiles() {
    setAttachmentMenuVisible(false);
    const result = await pick({ type: [types.allFiles], allowMultiSelection: true, mode: "import" });
    appendSources(result.map((asset) => ({ uri: asset.uri, name: asset.name ?? `Файл-${Date.now()}`, mimeType: asset.type ?? "application/octet-stream", size: asset.size ?? undefined })));
  }

  return <KeyboardAvoidingView style={[styles.root, { backgroundColor: themeColors.background }]} behavior={Platform.OS === "ios" ? "padding" : undefined} keyboardVerticalOffset={Platform.OS === "ios" ? 4 : 0}>
  <View style={[styles.header, { backgroundColor: themeColors.background, borderBottomColor: themeColors.border }]}>{searchOpen ? <><Pressable onPress={() => { setSearchOpen(false); setSearchQuery(""); }} style={styles.headerButton} hitSlop={6}><Icon name="arrowBack" size={22} color={themeColors.foreground} /></Pressable><View style={[styles.searchHeaderInput, { backgroundColor: themeColors.surface }]}><Icon name="search" size={18} color={themeColors.muted} /><TextInput value={searchQuery} onChangeText={setSearchQuery} placeholder="Поиск сообщений" placeholderTextColor={themeColors.muted} style={[styles.searchInput, { color: themeColors.foreground }]} autoFocus /></View>{searchQuery.trim() ? <Text style={[styles.matchCount, { color: themeColors.primary }]}>{visibleMessages.length}</Text> : null}</> : <><Pressable onPress={onBack} style={styles.headerButton} hitSlop={6}><Icon name="arrowBack" size={22} color={themeColors.foreground} /></Pressable><ConversationAvatar conversation={conversation} size={44} /><View style={styles.headerCopy}><Text style={[styles.headerName, { color: themeColors.foreground }]} numberOfLines={1}>{conversation.name}</Text><Text style={[styles.headerSub, { color: themeColors.muted }]} numberOfLines={1}>{presenceLabel(conversation)}</Text></View><View style={styles.headerActions}><Pressable style={styles.headerButton} onPress={() => setSearchOpen(true)}><Icon name="search" size={20} color={themeColors.muted} /></Pressable></View></> }</View>
    {visibleMessages.length ? <View style={styles.messageArea}>
      {selectedIds.length > 0 && <View style={styles.selectionBar}><Text style={styles.selectionText}>Выбрано: {selectedIds.length}</Text><Pressable onPress={() => setSelectedIds([])} style={styles.selectionClose} hitSlop={8}><Icon name="close" size={17} color={colors.foreground} /></Pressable></View>}
      <FlatList
        ref={listRef}
        data={visibleMessages}
        keyExtractor={(item) => item.id}
        style={styles.messageList}
        contentContainerStyle={[styles.messageListContent, density === "compact" && styles.compactMessageList]}
        bounces={false}
        showsVerticalScrollIndicator={false}
        onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: false })}
        ListHeaderComponent={<Text style={[styles.day, { color: themeColors.muted }]}>{searchQuery.trim() ? "РЕЗУЛЬТАТЫ ПОИСКА" : "СЕГОДНЯ"}</Text>}
        renderItem={({ item, index }) => <MessageBubble themeColors={themeColors} profile={profile} message={item} previous={visibleMessages[index - 1]} next={visibleMessages[index + 1]} messageTextSize={messageTextSize} bubbleRadius={bubbleRadius} mediaSettings={mediaSettings} energySavingActive={energySavingActive} selected={selectedIds.includes(item.id)} onToggleSelection={() => toggleSelection(item.id)} onReply={onReply} onStartEdit={startEditing} onPin={onPin} onSave={onSave} onDelete={onDelete} onReact={onReact} onForward={onForward} />}
      />
    </View> : <View style={styles.emptyChat}><View style={styles.emptyChatIcon}><Icon name={searchQuery.trim() ? "search" : conversation.canWrite === false ? "info" : "chat"} size={28} color={colors.primary} /></View><Text style={styles.emptyChatTitle}>{searchQuery.trim() ? "Ничего не найдено" : "Нет сообщений"}</Text><Text style={styles.emptyChatText}>{searchQuery.trim() ? "Попробуйте изменить запрос." : conversation.canWrite === false ? "Обновления появятся здесь." : "Начните общение"}</Text></View>}
    {error ? <Text style={[styles.error, { color: themeColors.danger }]}>{error}</Text> : null}
    {conversation.canWrite === false ? <View style={styles.readOnly}><Text style={styles.readOnlyText}>Этот чат доступен только для чтения</Text></View> : <View style={styles.composerWrap}>{(replyTo || activeEditingMessage) && <Animated.View style={{ opacity: contextMotion, transform: [{ translateX: contextMotion.interpolate({ inputRange: [0, 1], outputRange: [6, 0] }) }] }}><View style={styles.context}><View style={styles.contextAccent} /><View style={styles.contextCopy}><Text style={styles.contextTitle}>{activeEditingMessage ? "Редактирование сообщения" : "Ответ на сообщение"}</Text><Text style={styles.contextText} numberOfLines={1}>{activeEditingMessage?.text ?? replyTo?.text}</Text></View><Pressable onPress={() => { setText(""); setLocalEditingMessage(null); setInputHeight(MIN_MESSAGE_INPUT_HEIGHT); setInputScrollable(false); onCancelContext(); }} hitSlop={10}><Icon name="close" size={18} color={colors.muted} /></Pressable></View></Animated.View>}{uploadProgress !== null && <View style={styles.uploadProgress}><View style={styles.uploadProgressHeader}><Text style={styles.uploadProgressLabel}>{uploadProgress < 1 ? "Подготовка вложения…" : "Отправка вложения…"}</Text><Text style={styles.uploadProgressValue}>{uploadProgress}%</Text></View><View style={styles.uploadTrack}><View style={[styles.uploadFill, { width: `${uploadProgress}%` }]} /></View></View>}{pendingMedia.length > 0 && <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.pendingList}>{pendingMedia.map((item, index) => { const source = "source" in item ? item.source : undefined; const attachment = "encrypted" in item ? item.encrypted.attachment : undefined; const name = source?.name ?? attachment?.name ?? "Вложение"; const mimeType = source?.mimeType ?? attachment?.mimeType ?? "application/octet-stream"; const size = source?.size ?? attachment?.size; return <View key={`${name}-${index}`} style={styles.pendingItem}>{source && mimeType.startsWith("image/") ? <Image source={{ uri: source.uri }} style={styles.pendingThumb} /> : <View style={styles.pendingIcon}><Icon name={mimeType.startsWith("video/") ? "videocam" : "attach"} size={16} color={colors.primary} /></View>}<View style={styles.pendingCopy}><Text style={styles.pendingName} numberOfLines={1}>{name}</Text><Text style={styles.pendingSize}>{formatFileSize(size)}</Text></View><Pressable onPress={() => setPendingMedia((current) => current.filter((_, itemIndex) => itemIndex !== index))} hitSlop={8}><Icon name="close" size={15} color={colors.muted} /></Pressable></View>; })}</ScrollView>}<View style={[styles.composer, inputHeight > MIN_MESSAGE_INPUT_HEIGHT && styles.composerExpanded]}><Pressable style={[styles.composerButton, activeEditingMessage && styles.disabledAction]} onPress={() => setAttachmentMenuVisible(true)} disabled={Boolean(activeEditingMessage) || uploadProgress !== null}><Icon name="attach" size={20} color={colors.muted} /></Pressable><TextInput value={text} onChangeText={handleInputTextChange} placeholder="Написать сообщение…" placeholderTextColor={colors.muted} multiline maxLength={4000} scrollEnabled={inputScrollable} onContentSizeChange={handleInputContentSizeChange} style={[styles.messageInput, { height: inputHeight }]} onSubmitEditing={(event) => { if (Platform.OS !== "ios" && !event.nativeEvent.text.includes("\n")) submit(); }} blurOnSubmit={false} /><Pressable style={[styles.send, (uploadProgress !== null || (!text.trim() && pendingMedia.length === 0)) && styles.sendDisabled]} onPress={submit} disabled={uploadProgress !== null || (!text.trim() && pendingMedia.length === 0)}><Icon name="send" size={18} color={colors.primaryText} /></Pressable></View><Modal visible={attachmentMenuVisible} transparent animationType="slide" onRequestClose={() => setAttachmentMenuVisible(false)}><SafeAreaSheet onClose={() => setAttachmentMenuVisible(false)} sheetStyle={styles.attachmentSheet}><View style={styles.handle} /><Text style={styles.sheetTitle}>Добавить контент</Text><Pressable style={styles.attachmentOption} onPress={() => void pickGallery()}><View style={styles.attachmentIcon}><Icon name="videocam" size={20} color={colors.primary} /></View><View><Text style={styles.attachmentTitle}>Фото и видео</Text><Text style={styles.attachmentSubtitle}>Выбрать из галереи</Text></View></Pressable><Pressable style={styles.attachmentOption} onPress={() => void pickFiles()}><View style={styles.attachmentIcon}><Icon name="attach" size={20} color={colors.primary} /></View><View><Text style={styles.attachmentTitle}>Файл</Text><Text style={styles.attachmentSubtitle}>Открыть файловый менеджер</Text></View></Pressable></SafeAreaSheet></Modal></View>}
  </KeyboardAvoidingView>;
}

export function MessageBubble({ themeColors = colors, profile, message, previous, next, messageTextSize, bubbleRadius, mediaSettings, energySavingActive = false, selected = false, onToggleSelection, onReply, onStartEdit, onPin, onSave, onDelete, onReact, onForward }: { themeColors?: ThemeColors; profile: Profile; message: Message; previous?: Message; next?: Message; messageTextSize: number; bubbleRadius: number; mediaSettings?: MobileSettings["media"]; energySavingActive?: boolean; selected?: boolean; onToggleSelection: () => void; onReply: (message: Message) => void; onStartEdit: (message: Message) => void; onPin: (message: Message) => void; onSave: (message: Message) => void; onDelete: (message: Message) => void; onReact: (message: Message, reaction: string) => void; onForward: (message: Message) => void }) {
  const samePrevious = sameMessageStack(previous, message);
  const sameNext = sameMessageStack(message, next);
  const bubblePosition = samePrevious
    ? sameNext
      ? (message.author === "me" ? styles.groupMiddleOut : styles.groupMiddleIn)
      : (message.author === "me" ? styles.groupBottomOut : styles.groupBottomIn)
      : styles.groupTop;
  const visualAttachments = message.attachments?.filter((attachment) => attachment.kind === "image" || attachment.kind === "video") ?? [];
  const otherAttachments = message.attachments?.filter((attachment) => attachment.kind !== "image" && attachment.kind !== "video") ?? [];
  const mediaOnly = Boolean(visualAttachments.length && !otherAttachments.length && !message.text && !message.replyTo && !message.reaction);
  const mediaCaption = Boolean(visualAttachments.length && (message.text || message.reaction));
  const mediaOverlay = mediaOnly && !sameNext ? <View style={styles.mediaMetaOverlay}><Text style={styles.mediaMetaOverlayText}>{message.time}{message.edited ? " · изменено" : ""}{message.deliveryStatus === "pending" ? " · отправляется" : message.deliveryStatus === "failed" ? " · не отправлено" : ""}</Text>{message.author === "me" && (message.deliveryStatus ? <Text style={styles.mediaMetaOverlayText}>{message.deliveryStatus === "failed" ? "!" : "…"}</Text> : <Icon name={message.readAt || message.deliveredAt ? "checkAll" : "check"} size={12} color="#fff" />)}</View> : undefined;
  const messageMeta = !sameNext && !mediaOnly ? <View style={styles.messageMeta}><Text style={message.author === "me" ? styles.outMeta : styles.inMeta}>{message.time}{message.edited ? " · изменено" : ""}{message.deliveryStatus === "pending" ? " · отправляется" : message.deliveryStatus === "failed" ? " · не отправлено" : ""}</Text>{message.author === "me" && message.deliveryStatus === undefined && <Icon name={message.readAt || message.deliveredAt ? "checkAll" : "check"} size={13} color="#54458f" />}</View> : null;
  const messageTextAndReaction = <>{message.text ? <Text style={[styles.messageText, { color: message.author === "me" ? themeColors.primaryText : themeColors.foreground, fontSize: messageTextSize, lineHeight: Math.round(messageTextSize * 1.4) }]}>{message.text}</Text> : null}{message.reaction && <Text style={styles.reaction}>{message.reaction}</Text>}</>;
  const [actionsVisible, setActionsVisible] = useState(false);
  const [contextAttachment, setContextAttachment] = useState<{ attachment: MessageAttachment; save: () => void } | null>(null);
  const fileList = otherAttachments.length > 0 ? <View style={[styles.fileList, visualAttachments.length > 0 && styles.fileListSpaced, Boolean(message.text) && styles.fileListBeforeText]}>{otherAttachments.map((attachment) => <MediaBubble key={attachment.id} profile={profile} attachment={attachment} mediaSettings={mediaSettings} energySavingActive={energySavingActive} outgoing={message.author === "me"} onAttachmentLongPress={(selectedAttachment, save) => { setContextAttachment({ attachment: selectedAttachment, save }); setActionsVisible(true); }} />)}</View> : null;
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
    setContextAttachment(null);
    action();
  }

  return <Animated.View {...swipeResponder.panHandlers} style={[styles.messageLine, message.author === "me" ? styles.outgoing : styles.incoming, !samePrevious ? styles.messageGap : styles.groupGap, { transform: [{ translateX: swipeX }] }]}><Animated.View pointerEvents="none" style={[styles.swipeReply, { backgroundColor: themeColors.accent, opacity: swipeX.interpolate({ inputRange: [0, 52], outputRange: [0.15, 1] }), transform: [{ scale: swipeX.interpolate({ inputRange: [0, 52], outputRange: [0.7, 1] }) }] }]}><Icon name="reply" size={14} color={themeColors.primary} /></Animated.View><Pressable onLongPress={() => { setContextAttachment(null); setActionsVisible(true); }} delayLongPress={260} style={[styles.bubble, { borderRadius: bubbleRadius }, message.author === "me" ? [styles.outBubble, { backgroundColor: themeColors.primary }] : [styles.inBubble, { backgroundColor: themeColors.surfaceRaised }], bubblePosition, visualAttachments.length > 0 && styles.mediaOnlyBubble, visualAttachments.length > 0 && otherAttachments.length > 0 && (message.author === "me" ? [styles.outBubble, { backgroundColor: themeColors.primary }] : [styles.inBubble, { backgroundColor: themeColors.surfaceRaised }]), visualAttachments.length > 1 && styles.mediaGridBubble, message.pinned && [styles.pinned, { borderColor: themeColors.primary }], selected && [styles.selected, { borderColor: themeColors.primary }]]}>
    {message.replyTo && <View style={[styles.replyQuote, { borderLeftColor: themeColors.primary }]}><Text style={[styles.replyQuoteLabel, { color: themeColors.primary }, message.author === "me" && { color: themeColors.primaryText }]}>Ответ</Text><Text style={[styles.replyQuoteText, { color: themeColors.muted }, message.author === "me" && { color: themeColors.primaryText }]} numberOfLines={1}>{message.replyTo.text}</Text></View>}
    {visualAttachments.length ? <MediaGroup profile={profile} attachments={visualAttachments} mediaSettings={mediaSettings} energySavingActive={energySavingActive} overlay={mediaOverlay} captioned={mediaCaption} outgoing={message.author === "me"} onAttachmentLongPress={(selectedAttachment, save) => { setContextAttachment({ attachment: selectedAttachment, save }); setActionsVisible(true); }} /> : null}{fileList}{mediaCaption ? <View style={[styles.mediaCaption, message.author === "me" ? styles.outBubble : styles.inBubble]}>{messageTextAndReaction}{messageMeta}</View> : <>{messageTextAndReaction}{messageMeta}</>}
  </Pressable><Modal visible={actionsVisible} transparent animationType="slide" onRequestClose={() => { setActionsVisible(false); setContextAttachment(null); }}><SafeAreaSheet onClose={() => { setActionsVisible(false); setContextAttachment(null); }} sheetStyle={styles.actionSheet}><View style={styles.handle} /><Text style={styles.actionTitle}>Сообщение</Text><ScrollView bounces={false} horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.reactionList}>{reactions.map((reaction) => <Pressable key={reaction} style={styles.reactionButton} onPress={() => run(() => onReact(message, reaction))}><Text style={styles.reactionButtonText}>{reaction}</Text></Pressable>)}</ScrollView><View style={styles.actionList}>{contextAttachment && <ActionRow icon="share" label="Сохранить в загрузки" onPress={() => run(contextAttachment.save)} />}<ActionRow icon="reply" label="Ответить" onPress={() => run(() => onReply(message))} />{message.author === "me" && <ActionRow icon="edit" label="Изменить" onPress={() => run(() => onStartEdit(message))} />}<ActionRow icon="pin" label={message.pinned ? "Открепить" : "Закрепить"} onPress={() => run(() => onPin(message))} /><ActionRow icon="bookmark" label="Сохранить в Избранное" onPress={() => run(() => onSave(message))} /><ActionRow icon="copy" label="Копировать текст" onPress={() => run(() => Clipboard.setString(message.text))} /><ActionRow icon="forward" label="Переслать" onPress={() => run(() => onForward(message))} /><ActionRow icon="share" label="Поделиться" onPress={() => run(() => void Share.share({ message: message.text }))} /><ActionRow icon="delete" label="Удалить" destructive onPress={() => run(() => onDelete(message))} /><ActionRow icon="checkCircle" label={selected ? "Снять выделение" : "Выделить"} onPress={() => run(onToggleSelection)} /></View></SafeAreaSheet></Modal></Animated.View>;
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
  headerName: { color: colors.foreground, fontFamily: fonts.bodySemibold, fontSize: 15 },
  headerSub: { color: colors.muted, fontFamily: fonts.bodyMedium, fontSize: 14 },
  headerActions: { flexDirection: "row", gap: 0, flexShrink: 0 },
  disabledAction: { opacity: 0.4 },
  searchHeaderInput: { flex: 1, minHeight: 42, borderRadius: 21, backgroundColor: colors.surface, paddingHorizontal: 12, flexDirection: "row", alignItems: "center", gap: 7 },
  searchInput: { flex: 1, color: colors.foreground, fontFamily: fonts.body, fontSize: 15, paddingVertical: 0 },
  matchCount: { minWidth: 22, color: colors.primary, fontFamily: fonts.body, fontSize: 12, textAlign: "right" },
  messageArea: { flex: 1 },
  messageList: { flex: 1 },
  messageListContent: { paddingHorizontal: 14, paddingVertical: 18 },
  compactMessageList: { paddingHorizontal: 8, paddingVertical: 10 },
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
  mediaOnlyBubble: { paddingHorizontal: 0, paddingVertical: 0, backgroundColor: "transparent", overflow: "hidden" },
  mediaCaption: { marginTop: 0, paddingHorizontal: 14, paddingVertical: 10, borderTopLeftRadius: 0, borderTopRightRadius: 0, borderBottomLeftRadius: 19, borderBottomRightRadius: 19 },
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
  mediaMetaOverlay: { position: "absolute", right: 6, bottom: 6, borderRadius: 12, backgroundColor: "rgba(0,0,0,0.56)", paddingHorizontal: 8, paddingVertical: 4, alignItems: "center", flexDirection: "row", gap: 4 },
  mediaMetaOverlayText: { color: "#fff", fontFamily: fonts.body, fontSize: 10 },
  fileList: { gap: 6 },
  fileListSpaced: { marginTop: 8 },
  fileListBeforeText: { marginBottom: 8 },
  mediaGridBubble: { width: "90%", maxWidth: "90%" },
  outMeta: { color: "#635b8d", fontFamily: fonts.body, fontSize: 10 },
  inMeta: { color: colors.muted, fontFamily: fonts.body, fontSize: 10 },
  reaction: { alignSelf: "flex-start", marginTop: 4, backgroundColor: "rgba(0,0,0,0.12)", borderRadius: 12, paddingHorizontal: 6, paddingVertical: 2, fontSize: 15 },
  replyQuote: { borderLeftWidth: 2, borderLeftColor: colors.primary, paddingLeft: 8, marginBottom: 6, gap: 2 },
  replyQuoteLabel: { color: colors.primary, fontFamily: fonts.bodyBold, fontSize: 10 },
  replyQuoteText: { color: colors.muted, fontFamily: fonts.body, fontSize: 11 },
  outReplyQuoteText: { color: colors.primaryText },
  emptyChat: { flex: 1, alignItems: "center", justifyContent: "center", paddingHorizontal: 34, gap: 10 },
  emptyChatIcon: { width: 64, height: 64, borderRadius: 32, backgroundColor: "#29224d", alignItems: "center", justifyContent: "center", marginBottom: 2 },
  emptyChatTitle: { color: colors.foreground, fontFamily: fonts.headingBold, fontSize: 18 },
  emptyChatText: { color: colors.muted, fontFamily: fonts.body, textAlign: "center", fontSize: 14, lineHeight: 21 },
  error: { color: "#ffaaa6", backgroundColor: "#321d20", fontFamily: fonts.body, paddingHorizontal: 14, paddingVertical: 8, fontSize: 12 },
  readOnly: { minHeight: 56, borderTopWidth: 1, borderTopColor: colors.border, alignItems: "center", justifyContent: "center", flexDirection: "row", gap: 8 },
  readOnlyText: { color: colors.muted, fontFamily: fonts.body, fontSize: 12 },
  composerWrap: { borderTopWidth: 1, borderTopColor: colors.border, paddingHorizontal: 12, paddingVertical: 10, gap: 8 },
  uploadProgress: { gap: 5 },
  uploadProgressHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  uploadProgressLabel: { color: colors.foreground, fontFamily: fonts.body, fontSize: 11 },
  uploadProgressValue: { color: colors.muted, fontFamily: fonts.bodySemibold, fontSize: 11 },
  uploadTrack: { height: 5, borderRadius: 3, backgroundColor: colors.surfaceRaised, overflow: "hidden" },
  uploadFill: { height: "100%", borderRadius: 3, backgroundColor: colors.primary },
  pendingList: { gap: 7, paddingHorizontal: 2 },
  pendingItem: { maxWidth: 250, minHeight: 48, borderRadius: radii.sm, backgroundColor: colors.surfaceRaised, paddingHorizontal: 7, paddingVertical: 5, flexDirection: "row", alignItems: "center", gap: 7 },
  pendingThumb: { width: 38, height: 38, borderRadius: 8 },
  pendingIcon: { width: 38, height: 38, borderRadius: 8, backgroundColor: "rgba(179,164,255,0.14)", alignItems: "center", justifyContent: "center" },
  pendingCopy: { maxWidth: 160, gap: 2 },
  pendingName: { color: colors.foreground, fontFamily: fonts.bodySemibold, fontSize: 12 },
  pendingSize: { color: colors.muted, fontFamily: fonts.body, fontSize: 10 },
  composer: { minHeight: 48, borderWidth: 1, borderColor: colors.border, borderRadius: 24, backgroundColor: colors.surface, flexDirection: "row", alignItems: "center", padding: 5, gap: 4 },
  composerExpanded: { alignItems: "flex-end" },
  composerButton: { width: 36, height: 36, borderRadius: 18, backgroundColor: "rgba(240,240,240,0.08)", alignItems: "center", justifyContent: "center" },
  messageInput: { flex: 1, color: "#ffffff", fontFamily: fonts.body, fontSize: 15, lineHeight: 21, minHeight: MIN_MESSAGE_INPUT_HEIGHT, maxHeight: MAX_MESSAGE_INPUT_HEIGHT, paddingHorizontal: 6, paddingVertical: 0, textAlignVertical: "top" },
  send: { width: 38, height: 38, borderRadius: 19, backgroundColor: colors.primary, alignItems: "center", justifyContent: "center" },
  sendDisabled: { opacity: 0.42 },
  context: { minHeight: 48, backgroundColor: colors.surfaceRaised, borderRadius: radii.sm, padding: 8, flexDirection: "row", alignItems: "center", gap: 8 },
  contextAccent: { width: 3, alignSelf: "stretch", borderRadius: 2, backgroundColor: colors.primary },
  contextCopy: { flex: 1, gap: 3 },
  contextTitle: { color: colors.primary, fontFamily: fonts.bodyBold, fontSize: 11 },
  contextText: { color: colors.muted, fontFamily: fonts.body, fontSize: 12 },
  attachmentSheet: { backgroundColor: colors.surface, borderTopLeftRadius: 26, borderTopRightRadius: 26, padding: 18, paddingBottom: 28, borderWidth: 1, borderColor: colors.border },
  attachmentOption: { minHeight: 64, borderBottomWidth: 1, borderBottomColor: colors.border, flexDirection: "row", alignItems: "center", gap: 12 },
  attachmentIcon: { width: 42, height: 42, borderRadius: 13, backgroundColor: "rgba(179,164,255,0.14)", alignItems: "center", justifyContent: "center" },
  attachmentTitle: { color: colors.foreground, fontFamily: fonts.bodySemibold, fontSize: 14 },
  attachmentSubtitle: { color: colors.muted, fontFamily: fonts.body, fontSize: 12, marginTop: 3 },
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
