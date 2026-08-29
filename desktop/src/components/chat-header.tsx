import type { Conversation } from "../types";
import { formatLastSeen } from "../lib/utils";
import { ConversationAvatar } from "./ui/avatar";
import { Icon } from "./ui/icon";

// #preview ChatHeader {"conversation":{"id":"maria","name":"Мария","avatar":"maria","lastMessage":"Привет","time":"12:48","online":true}}
type ChatHeaderProps = {
  conversation?: Conversation;
  searchOpen?: boolean;
  searchQuery?: string;
  searchResultsCount?: number;
  onSearchOpen?: () => void;
  onSearchClose?: () => void;
  onSearchQueryChange?: (value: string) => void;
};

export function ChatHeader({ conversation, searchOpen = false, searchQuery = "", searchResultsCount = 0, onSearchOpen = () => undefined, onSearchClose = () => undefined, onSearchQueryChange = () => undefined }: ChatHeaderProps) {
  if (!conversation) return null;
  if (searchOpen) {
    return (
      <header className="chat-header flex h-[4.375rem] shrink-0 items-center gap-2 px-5">
        <button className="icon-button" type="button" onClick={onSearchClose} title="Закрыть поиск" aria-label="Закрыть поиск"><Icon name="arrow_back" className="size-4" /></button>
        <div className="flex min-w-0 flex-1 items-center gap-2 rounded-full border border-border bg-surface px-3 py-2">
          <Icon name="search" className="size-4 shrink-0 text-muted-foreground" />
          <input value={searchQuery} onChange={(event) => onSearchQueryChange(event.target.value)} autoFocus placeholder="Поиск сообщений" aria-label="Поиск сообщений" className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground" />
        </div>
        {searchQuery.trim() && <span className="min-w-5 text-right text-xs text-primary">{searchResultsCount}</span>}
      </header>
    );
  }
  const isSystemConversation = conversation.handle === "official" || conversation.handle === "favorites";
  const status = isSystemConversation ? conversation.subtitle : conversation.online ? "В сети" : formatLastSeen(conversation.lastSeenAt);

  return (
    <header className="chat-header flex h-[4.375rem] shrink-0 items-center gap-3 px-5">
      <ConversationAvatar id={conversation.id} handle={conversation.handle} avatar={conversation.name} size={42} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold">{conversation.name}</p>
        <p className="mt-0.5 flex items-center gap-1.5 text-sm text-muted-foreground">
          {conversation.online && <span className="size-1.5 rounded-full bg-primary" aria-label="В сети" />}
          {status}
        </p>
      </div>
      <div className="flex items-center gap-1">
        <button className="icon-button" type="button" onClick={onSearchOpen} title="Поиск в чате" aria-label="Поиск в чате"><Icon name="search" className="size-4" /></button>
        <button className="icon-button opacity-40" title="Аудиозвонки пока недоступны" disabled aria-label="Аудиозвонок"><Icon name="phone" className="size-4" /></button>
        <button className="icon-button opacity-40" title="Видеозвонки пока недоступны" disabled aria-label="Видеозвонок"><Icon name="videocam" className="size-4" /></button>
        <button className="icon-button opacity-40" title="Информация пока недоступна" disabled aria-label="Информация"><Icon name="info" className="size-4" /></button>
        <button className="icon-button opacity-40" title="Дополнительные действия пока недоступны" disabled aria-label="Дополнительные действия"><Icon name="more_horiz" className="size-4" /></button>
      </div>
    </header>
  );
}
