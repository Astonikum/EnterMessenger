import { useMemo, useState } from "react";
import type { Conversation, Message } from "../types";
import { cn } from "../lib/utils";
import { ConversationAvatar } from "./ui/avatar";
import { Icon } from "./ui/icon";
import { Input } from "./ui/input";

type ForwardMessageDialogProps = {
  message: Message;
  conversations: Conversation[];
  currentConversationId?: string | null;
  onClose: () => void;
  onForward: (conversationId: string) => void | Promise<void>;
};

// #preview ForwardMessageDialog {"message":{"id":"1","author":"them","text":"Привет!","time":"12:48"},"conversations":[]}
export function ForwardMessageDialog({ message, conversations, currentConversationId, onClose, onForward }: ForwardMessageDialogProps) {
  const [query, setQuery] = useState("");
  const targets = useMemo(() => conversations.filter((conversation) => (
    conversation.id !== currentConversationId
      && !conversation.archived
      && conversation.canWrite !== false
      && `${conversation.name} ${conversation.handle ?? ""}`.toLowerCase().includes(query.trim().toLowerCase())
  )), [conversations, currentConversationId, query]);

  return (
    <div className="forward-dialog-overlay" role="dialog" aria-modal="true" aria-labelledby="forward-message-title" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="forward-dialog">
        <header className="forward-dialog-header">
          <div className="min-w-0"><h2 id="forward-message-title" className="font-heading text-lg font-semibold">Переслать сообщение</h2><p className="mt-1 truncate text-xs text-muted-foreground">{message.text}</p></div>
          <button type="button" className="icon-button shrink-0" title="Закрыть" aria-label="Закрыть" onClick={onClose}><Icon name="close" className="size-4" /></button>
        </header>
        <div className="forward-dialog-search"><Icon name="search" className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" /><Input value={query} onChange={(event) => setQuery(event.target.value)} className="h-10 pl-9" placeholder="Поиск чата" aria-label="Поиск чата" autoFocus /></div>
        <div className="forward-dialog-list">
          {targets.length > 0 ? targets.map((conversation) => (
            <button key={conversation.id} type="button" className={cn("forward-target", conversation.pinned && "forward-target-pinned")} onClick={() => void onForward(conversation.id)}>
              <ConversationAvatar id={conversation.id} handle={conversation.handle} avatar={conversation.name} size={38} />
              <span className="min-w-0 flex-1 truncate text-left text-sm font-medium">{conversation.name}</span>
              <Icon name="forward" className="size-4 text-muted-foreground" />
            </button>
          )) : <p className="px-3 py-8 text-center text-sm text-muted-foreground">Нет доступных чатов</p>}
        </div>
      </section>
    </div>
  );
}
