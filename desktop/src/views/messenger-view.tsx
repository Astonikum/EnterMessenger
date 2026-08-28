import { useEffect, useMemo, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { ChatHeader } from "../components/chat-header";
import { ChatLoadingState } from "../components/chat-loading-state";
import { ChatEmptyState } from "../components/chat-empty-state";
import { ChatReadOnlyState } from "../components/chat-read-only-state";
import { AppRail } from "../components/app-rail";
import { ConversationList } from "../components/conversation-list";
import { ForwardMessageDialog } from "../components/forward-message-dialog";
import { MessageComposer, type PendingMedia } from "../components/message-composer";
import { MessageList } from "../components/message-list";
import { ProfilePanel } from "../components/profile-panel";
import type { SearchUser } from "../lib/enter-api";
import type { Conversation, Message, Profile } from "../types";

const RAIL_WIDTH = 68;
const MIN_CONVERSATIONS_WIDTH = 320;
const CONVERSATIONS_WIDTH_KEY = "enter-desktop-conversations-width";
const BASE_VIEWPORT_HEIGHT = 1080;

function uiScale() {
  return Math.min(1.5, Math.max(0.8, window.innerHeight / BASE_VIEWPORT_HEIGHT));
}

function maxConversationsWidth() {
  return Math.max(MIN_CONVERSATIONS_WIDTH, Math.floor(window.innerWidth / uiScale() / 2));
}

function clampConversationsWidth(width: number) {
  return Math.min(maxConversationsWidth(), Math.max(MIN_CONVERSATIONS_WIDTH, Math.round(width)));
}

function initialConversationsWidth() {
  const max = maxConversationsWidth();
  try {
    const saved = Number(localStorage.getItem(CONVERSATIONS_WIDTH_KEY));
    if (Number.isFinite(saved)) return clampConversationsWidth(saved);
  } catch {
    // Use the calculated default when storage is unavailable.
  }
  return Math.round((MIN_CONVERSATIONS_WIDTH + max) / 2);
}

type MessengerViewProps = {
  profiles?: Profile[];
  activeProfile?: Profile;
  folders?: string[];
  activeFolder?: string;
  conversations?: Conversation[];
  conversationsLoading?: boolean;
  syncConnected?: boolean;
  activeConversationId?: string | null;
  activeConversation?: Conversation;
  messages?: Message[];
  onStartEditMessage?: (message: Message) => void;
  messageToForward?: Message | null;
  replyTo?: Message | null;
  editingMessage?: Message | null;
  messagesLoading?: boolean;
  showProfile?: boolean;
  showSettings?: boolean;
  settingsPanel?: ReactNode;
  messageError?: string;
  searchUser?: SearchUser | null;
  searchBusy?: boolean;
  searchError?: string;
  onSelectProfile?: (profile: Profile) => void;
  onRemoveProfile?: (profile: Profile) => void | Promise<void>;
  onAddProfile?: () => void;
  onSelectConversation?: (id: string) => void;
  onSelectFolder?: (folder: string) => void;
  onTogglePinned?: (id: string) => void;
  onToggleMuted?: (id: string) => void;
  onMarkUnread?: (id: string) => void;
  onArchive?: (id: string) => void;
  onAddToFolder?: (id: string) => void;
  onDelete?: (id: string) => void;
  onReorder?: (sourceId: string, targetId: string) => void;
  onBack?: () => void;
  onToggleProfile?: () => void;
  onOpenSettings?: () => void;
  onCloseProfile?: () => void;
  onSearchUser?: (query: string) => void | Promise<void>;
  onOpenSearchUser?: (user: SearchUser) => void | Promise<void>;
  onSendMessage?: (message: Message, pendingMedia?: PendingMedia[]) => void;
  mediaUploadProgress?: number | null;
  onReply?: (message: Message) => void;
  onEditMessage?: (message: Message) => void;
  onToggleMessagePinned?: (message: Message) => void;
  onSaveMessage?: (message: Message) => void;
  onDeleteMessage?: (message: Message) => void;
  onReactToMessage?: (message: Message, reaction: string) => void;
  onForwardMessage?: (message: Message) => void;
  onSendForwardedMessage?: (message: Message, conversationId: string) => void | Promise<void>;
  onCloseForward?: () => void;
  onCancelMessageContext?: () => void;
};

// #preview MessengerView {}
export function MessengerView({
  profiles = [],
  activeProfile,
  folders = [],
  activeFolder = "all",
  conversations = [],
  conversationsLoading = false,
  syncConnected = false,
  activeConversationId = null,
  activeConversation,
  messages = [],
  onStartEditMessage = () => undefined,
  messageToForward = null,
  replyTo = null,
  editingMessage = null,
  messagesLoading = false,
  showProfile = false,
  showSettings = false,
  settingsPanel,
  messageError = "",
  mediaUploadProgress = null,
  searchUser = null,
  searchBusy = false,
  searchError = "",
  onSelectProfile = () => undefined,
  onRemoveProfile = () => undefined,
  onAddProfile = () => undefined,
  onSelectConversation = () => undefined,
  onSelectFolder = () => undefined,
  onTogglePinned = () => undefined,
  onToggleMuted = () => undefined,
  onMarkUnread = () => undefined,
  onArchive = () => undefined,
  onAddToFolder = () => undefined,
  onDelete = () => undefined,
  onReorder = () => undefined,
  onBack = () => undefined,
  onToggleProfile = () => undefined,
  onOpenSettings = () => undefined,
  onCloseProfile = () => undefined,
  onSearchUser = () => undefined,
  onOpenSearchUser = () => undefined,
  onSendMessage = () => undefined,
  onReply = () => undefined,
  onEditMessage = () => undefined,
  onToggleMessagePinned = () => undefined,
  onSaveMessage = () => undefined,
  onDeleteMessage = () => undefined,
  onReactToMessage = () => undefined,
  onForwardMessage = () => undefined,
  onSendForwardedMessage = () => undefined,
  onCloseForward = () => undefined,
  onCancelMessageContext = () => undefined,
}: MessengerViewProps) {
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [conversationsWidth, setConversationsWidth] = useState(initialConversationsWidth);
  const [layoutScale, setLayoutScale] = useState(uiScale);
  const [isResizing, setIsResizing] = useState(false);
  const visibleMessages = useMemo(() => {
    const value = searchQuery.trim().toLowerCase();
    return value ? messages.filter((message) => message.text.toLowerCase().includes(value)) : messages;
  }, [messages, searchQuery]);

  useEffect(() => {
    setSearchOpen(false);
    setSearchQuery("");
  }, [activeConversationId]);

  useEffect(() => {
    try {
      localStorage.setItem(CONVERSATIONS_WIDTH_KEY, String(conversationsWidth));
    } catch {
      // Keep the width for the current session when storage is unavailable.
    }
  }, [conversationsWidth]);

  useEffect(() => {
    const handleViewportResize = () => {
      setLayoutScale(uiScale());
      setConversationsWidth((current) => clampConversationsWidth(current));
    };
    window.addEventListener("resize", handleViewportResize);
    return () => window.removeEventListener("resize", handleViewportResize);
  }, []);

  function resizeConversations(clientX: number) {
    setConversationsWidth(clampConversationsWidth(clientX / uiScale() - RAIL_WIDTH));
  }

  function beginConversationsResize(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    setIsResizing(true);
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    const handlePointerMove = (moveEvent: PointerEvent) => resizeConversations(moveEvent.clientX);
    const stopResizing = () => {
      window.removeEventListener("pointermove", handlePointerMove);
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
      setIsResizing(false);
    };
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", stopResizing, { once: true });
  }

  function handleConversationsResizeKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    const step = event.shiftKey ? 64 : 16;
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      setConversationsWidth((current) => clampConversationsWidth(current + (event.key === "ArrowRight" ? step : -step)));
    } else if (event.key === "Home") {
      event.preventDefault();
      setConversationsWidth(MIN_CONVERSATIONS_WIDTH);
    } else if (event.key === "End") {
      event.preventDefault();
      setConversationsWidth(maxConversationsWidth());
    }
  }

  return (
    <main className="app-shell bg-background text-foreground" data-resizing={isResizing} data-settings={showSettings ? "true" : "false"} style={{ "--list-width": `${conversationsWidth * layoutScale}px` } as CSSProperties}>
      <AppRail profiles={profiles} activeProfile={activeProfile} folders={folders} activeFolder={activeFolder} showProfile={showProfile} showSettings={showSettings} onSelectProfile={onSelectProfile} onRemoveProfile={onRemoveProfile} onAddProfile={onAddProfile} onBack={onBack} onSelectFolder={onSelectFolder} onToggleProfile={onToggleProfile} onOpenSettings={onOpenSettings} />
      <div className="app-conversations-shell">
        <ConversationList className="app-conversations" conversations={conversations} activeFolder={activeFolder} isLoading={conversationsLoading} isConnected={syncConnected} activeId={activeConversationId} onSelect={onSelectConversation} onTogglePinned={onTogglePinned} onToggleMuted={onToggleMuted} onMarkUnread={onMarkUnread} onArchive={onArchive} onAddToFolder={onAddToFolder} onDelete={onDelete} onReorder={onReorder} searchUser={searchUser} searchBusy={searchBusy} searchError={searchError} onSearchUser={onSearchUser} onOpenSearchUser={onOpenSearchUser} />
        <div className="app-conversations-resizer" role="separator" aria-label="Изменить ширину списка чатов" aria-orientation="vertical" aria-valuemin={MIN_CONVERSATIONS_WIDTH} aria-valuemax={maxConversationsWidth()} aria-valuenow={conversationsWidth} tabIndex={0} onPointerDown={beginConversationsResize} onKeyDown={handleConversationsResizeKeyDown} title="Изменить ширину списка чатов" />
      </div>
      <section className={`app-chat chat-tab flex min-w-0 flex-col overflow-hidden${showSettings ? " chat-tab-settings" : ""}`}>
        {showSettings && settingsPanel ? settingsPanel : <>
          <ChatHeader conversation={activeConversation} searchOpen={searchOpen} searchQuery={searchQuery} searchResultsCount={visibleMessages.length} onSearchOpen={() => setSearchOpen(true)} onSearchClose={() => { setSearchOpen(false); setSearchQuery(""); }} onSearchQueryChange={setSearchQuery} />
          {activeConversation ? messagesLoading ? <ChatLoadingState /> : <><MessageList key={activeConversationId} messages={visibleMessages} profile={activeProfile} searching={Boolean(searchQuery.trim())} readOnly={activeConversation.canWrite === false} onReply={onReply} onEdit={onStartEditMessage} onTogglePinned={onToggleMessagePinned} onSave={onSaveMessage} onDelete={onDeleteMessage} onReact={onReactToMessage} onForward={onForwardMessage} />{activeConversation.canWrite !== false ? <MessageComposer error={messageError} uploadProgress={mediaUploadProgress} onSend={onSendMessage} replyTo={replyTo} editingMessage={editingMessage} onEdit={onEditMessage} onCancelContext={onCancelMessageContext} /> : <ChatReadOnlyState />}</> : <ChatEmptyState />}
        </>}
      </section>
      {showProfile && <ProfilePanel profile={activeProfile} onClose={onCloseProfile} onAddProfile={onAddProfile} />}
      {!showSettings && messageToForward && <ForwardMessageDialog message={messageToForward} conversations={conversations} currentConversationId={activeConversationId} onClose={onCloseForward} onForward={(conversationId) => onSendForwardedMessage(messageToForward, conversationId)} />}
    </main>
  );
}
