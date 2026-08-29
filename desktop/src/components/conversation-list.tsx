import { useRef, useState, useEffect } from "react";
import type { SearchUser } from "../lib/enter-api";
import type { Conversation } from "../types";
import { ChatListEmptyState } from "./chat-list-empty-state";
import { Input } from "./ui/input";
import { ConversationAvatar, ProfileAvatar } from "./ui/avatar";
import { Skeleton } from "./ui/skeleton";
import { ContextMenu } from "./ui/context-menu";
import { cn, formatLastSeen } from "../lib/utils";
import { Icon } from "./ui/icon";
import { folderContains, type ChatFolder } from "../lib/folders";

type ConversationListProps = {
  conversations: Conversation[];
  activeId: string | null;
  activeFolder?: string;
  listLayout?: "two-line" | "three-line";
  folders?: ChatFolder[];
  onSelect?: (id: string) => void;
  className?: string;
  isLoading?: boolean;
  isConnected?: boolean;
  searchUser?: SearchUser | null;
  searchBusy?: boolean;
  searchError?: string;
  onSearchUser?: (query: string) => void | Promise<void>;
  onOpenSearchUser?: (user: SearchUser) => void | Promise<void>;
  onTogglePinned?: (id: string) => void;
  onToggleMuted?: (id: string) => void;
  onMarkUnread?: (id: string) => void;
  onArchive?: (id: string) => void;
  onManageFolders?: (id: string) => void;
  onDelete?: (id: string) => void;
  onReorder?: (sourceId: string, targetId: string) => void;
};

function previewText(value: string) {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > 48 ? `${compact.slice(0, 48).trimEnd()}…` : compact;
}

// #preview ConversationList {"conversations":[{"id":"maria","name":"Мария","avatar":"maria","lastMessage":"Привет!","time":"12:48","online":true,"unread":2,"pinned":true}],"activeId":"maria"}
export function ConversationList({ conversations, activeId, activeFolder = "all", listLayout = "two-line", folders = [], onSelect = () => undefined, className, isLoading = false, isConnected = false, searchUser = null, searchBusy = false, searchError = "", onSearchUser = () => undefined, onOpenSearchUser = () => undefined, onTogglePinned = () => undefined, onToggleMuted = () => undefined, onMarkUnread = () => undefined, onArchive = () => undefined, onManageFolders = () => undefined, onDelete = () => undefined, onReorder = () => undefined }: ConversationListProps) {
  const [query, setQuery] = useState("");
  const searchTimer = useRef<number | null>(null);
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  useEffect(() => () => { if (searchTimer.current !== null) window.clearTimeout(searchTimer.current); }, []);
  const visibleConversations = conversations
    .filter((conversation) => !conversation.archived && !conversation.deleted && (activeFolder === "all" || folders.some((folder) => folder.id === activeFolder && folderContains(folder, conversation))) && `${conversation.name} ${conversation.handle ?? ""} ${conversation.lastMessage}`.toLowerCase().includes(query.toLowerCase()))
    .sort((left, right) => Number(Boolean(right.pinned)) - Number(Boolean(left.pinned)));

  return (
    <section className={cn("app-conversations-panel flex min-h-0 shrink-0 flex-col border-r border-border/70 bg-surface/35", className)}>
      <div className="flex h-[4.375rem] items-center justify-between px-4">
        <h1 className="font-heading text-[1.1875rem] font-semibold tracking-tight">{isConnected ? "Сообщения" : "Подключение…"}</h1>
      </div>
      <div className="mx-4 mb-3">
        <label className="relative block"><Icon name="search" className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" /><Input value={query} onChange={(event) => { const nextQuery = event.target.value; setQuery(nextQuery); if (searchTimer.current !== null) window.clearTimeout(searchTimer.current); searchTimer.current = window.setTimeout(() => void onSearchUser(nextQuery.trim()), 360); }} className="h-9 pl-9" placeholder="Поиск" aria-label="Поиск по диалогам" /></label>
      </div>
      <div className="scrollbar-none flex-1 overflow-y-auto px-2 pb-2">
        {searchBusy && <div className="mx-1 mb-2 flex items-center gap-2 rounded-2xl bg-accent/60 px-3 py-2 text-sm text-muted-foreground"><Icon name="progress_activity" className="size-4 animate-spin" />Ищем пользователя…</div>}
        {searchError && <div className="mx-1 mb-2 flex items-start gap-2 rounded-2xl bg-destructive/10 px-3 py-2 text-xs text-destructive" role="alert"><Icon name="error" className="mt-0.5 size-4 shrink-0" />{searchError}</div>}
        {searchUser && <button type="button" className="conversation-item group mb-2 flex w-full items-center gap-3 rounded-2xl bg-accent/70 p-2.5 text-left transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-60" onClick={() => { setQuery(""); void onOpenSearchUser(searchUser); }} disabled={searchBusy || searchUser.deviceCount === 0} title={searchUser.deviceCount === 0 ? "Нет активного устройства" : "Открыть чат"}>
          <ProfileAvatar name={searchUser.name} size={42} />
          <span className="min-w-0 flex-1"><span className="block truncate text-sm font-semibold">{searchUser.name}</span><span className="mt-0.5 block truncate text-xs text-muted-foreground">@{searchUser.handle} · {searchUser.server.replace(/^https?:\/\//, "")}</span></span>
          <Icon name="person" className="size-4 text-muted-foreground" />
        </button>}
        {isLoading ? <div className="space-y-2 px-1">{[0, 1, 2, 3, 4].map((item) => <div key={item} className="flex items-center gap-3 rounded-2xl p-2.5"><Skeleton className="size-10 rounded-full" /><span className="min-w-0 flex-1 space-y-2"><Skeleton className="h-3.5 w-3/5" /><Skeleton className="h-3 w-4/5" /></span></div>)}</div> : visibleConversations.length === 0 && !searchUser ? <ChatListEmptyState /> : visibleConversations.map((conversation) => (
          <ContextMenu
            key={conversation.id}
            items={[
              { label: "Архивировать", icon: <Icon name="archive" className="size-4" />, onSelect: () => onArchive(conversation.id) },
              { label: conversation.pinned ? "Открепить" : "Закрепить", icon: <Icon name="push_pin" className="size-4" />, onSelect: () => onTogglePinned(conversation.id) },
              { label: conversation.muted ? "Включить уведомления" : "Выключить уведомления", icon: conversation.muted ? <Icon name="notifications" className="size-4" /> : <Icon name="notifications_off" className="size-4" />, onSelect: () => onToggleMuted(conversation.id) },
              { label: "Пометить как непрочитанное", icon: <Icon name="chat_bubble" className="size-4" />, onSelect: () => onMarkUnread(conversation.id) },
              { label: "Настроить папки", icon: <Icon name="folder" className="size-4" />, onSelect: () => onManageFolders(conversation.id) },
              { label: "Удалить чат", icon: <Icon name="delete" className="size-4" />, destructive: true, onSelect: () => onDelete(conversation.id) },
            ]}
          >
            <button
              draggable
              onDragStart={(event) => {
                event.dataTransfer.effectAllowed = "move";
                event.dataTransfer.setData("text/plain", conversation.id);
                setDraggedId(conversation.id);
              }}
              onDragOver={(event) => {
                const draggedConversation = conversations.find((item) => item.id === draggedId);
                if (!draggedConversation || draggedConversation.pinned !== conversation.pinned) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = "move";
                setDragOverId(conversation.id);
              }}
              onDrop={(event) => {
                event.preventDefault();
                const sourceId = event.dataTransfer.getData("text/plain") || draggedId;
                const sourceConversation = conversations.find((item) => item.id === sourceId);
                if (sourceId && sourceId !== conversation.id && sourceConversation?.pinned === conversation.pinned) onReorder(sourceId, conversation.id);
                setDraggedId(null);
                setDragOverId(null);
              }}
              onDragEnd={() => {
                setDraggedId(null);
                setDragOverId(null);
              }}
              onClick={() => onSelect(conversation.id)}
              className={cn("conversation-item group mb-1 flex w-full items-center gap-3 rounded-2xl p-2.5 text-left", activeId === conversation.id ? "bg-accent" : "hover:bg-accent/70", draggedId === conversation.id && "opacity-50", dragOverId === conversation.id && "ring-2 ring-primary/50")}
            >
              <div className="relative" title={conversation.online ? "В сети" : formatLastSeen(conversation.lastSeenAt)}>
                <ConversationAvatar id={conversation.id} handle={conversation.handle} avatar={conversation.name} size={42} />
                {conversation.online && <span className="absolute bottom-0 right-0 size-2.5 rounded-full border-2 border-surface bg-[#30d158]" aria-label="В сети" />}
              </div>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5">
                  <span className="truncate text-sm font-semibold">{conversation.name}</span>
                  {conversation.pinned && <Icon name="push_pin" className="size-3 text-muted-foreground" />}
                  {conversation.muted && <Icon name="notifications_off" className="size-3 text-muted-foreground" />}
                  {folders.some((folder) => folderContains(folder, conversation)) ? <Icon name="folder" className="size-3 text-muted-foreground" aria-label="Есть папка" /> : null}
                </span>
                <span className="mt-0.5 flex min-w-0 items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{previewText(conversation.lastMessage)}</span>
                  {conversation.time && <span className="shrink-0 text-[0.625rem] text-muted-foreground">{conversation.time}</span>}
                </span>
                {listLayout === "three-line" && <span className="mt-0.5 block truncate text-[0.625rem] text-muted-foreground">{conversation.handle ? `@${conversation.handle.replace(/^@/, "")}` : conversation.online ? "В сети" : "Не в сети"}</span>}
              </span>
              {conversation.unread ? <span className="grid shrink-0 min-w-5 place-items-center rounded-full bg-primary px-1.5 py-0.5 text-[0.625rem] font-bold text-primary-foreground">{conversation.unread}</span> : null}
            </button>
          </ContextMenu>
        ))}
      </div>
    </section>
  );
}
