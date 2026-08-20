import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Message } from "../types";
import { copyText, cn } from "../lib/utils";
import { ContextMenu } from "./ui/context-menu";
import { Icon } from "./ui/icon";

type MessageListProps = {
  messages: Message[];
  onReply?: (message: Message) => void;
  onEdit?: (message: Message) => void;
  onTogglePinned?: (message: Message) => void;
  onSave?: (message: Message) => void;
  onDelete?: (message: Message) => void;
  onReact?: (message: Message, reaction: string) => void;
  onForward?: (message: Message) => void;
  searching?: boolean;
  readOnly?: boolean;
};

const AUTO_SCROLL_THRESHOLD = 32;

// #preview MessageList {"messages":[{"id":"1","author":"them","text":"Привет!","time":"12:48"},{"id":"2","author":"me","text":"На связи.","time":"12:49"}]}
export function MessageList({ messages, onReply = () => undefined, onEdit = () => undefined, onTogglePinned = () => undefined, onSave = () => undefined, onDelete = () => undefined, onReact = () => undefined, onForward = () => undefined, searching = false, readOnly = false }: MessageListProps) {
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const listRef = useRef<HTMLDivElement>(null);
  const shouldAutoScrollRef = useRef(true);
  const lastMessageId = messages[messages.length - 1]?.id;

  function scrollToBottom() {
    const list = listRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }

  function handleScroll() {
    const list = listRef.current;
    if (list) shouldAutoScrollRef.current = list.scrollHeight - list.scrollTop - list.clientHeight <= AUTO_SCROLL_THRESHOLD;
  }
  const reactions = ["❤️", "💥", "👌", "👍", "👎", "🔥", "🥰", "👋"];

  useEffect(() => {
    setSelectedIds((current) => current.filter((id) => messages.some((message) => message.id === id)));
  }, [messages]);

  useLayoutEffect(() => {
    if (shouldAutoScrollRef.current) scrollToBottom();
  }, [lastMessageId]);

  return (
    <div ref={listRef} onScroll={handleScroll} className="scrollbar-none flex-1 space-y-0.5 overflow-y-auto px-5 py-6">
      {selectedIds.length > 0 && <div className="message-selection-bar sticky top-0 z-10 mx-auto flex max-w-[min(70%,28.75rem)] items-center justify-between gap-3 rounded-xl px-3 py-2 text-xs"><span>Выбрано: {selectedIds.length}</span><button type="button" className="icon-button size-7" title="Снять выделение" aria-label="Снять выделение" onClick={() => setSelectedIds([])}><Icon name="close" className="size-4" /></button></div>}
      {searching && messages.length === 0 ? <div className="flex flex-1 flex-col items-center justify-center gap-2 py-16 text-center"><Icon name="search" className="size-7 text-muted-foreground" /><p className="text-sm font-semibold">Ничего не найдено</p><p className="text-xs text-muted-foreground">Попробуйте изменить запрос.</p></div> : <>{messages.length > 0 && <div className="py-1 text-center text-[0.625rem] uppercase tracking-[0.18em] text-muted-foreground">{searching ? "Результаты поиска" : "Сегодня"}</div>}
      {!searching && messages.length === 0 ? <div className="chat-empty-state flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center"><div className="mb-0.5 flex size-16 items-center justify-center rounded-full bg-[#29224d]"><Icon name={readOnly ? "info" : "chat"} className="size-7 text-primary" /></div><h2 className="m-0 text-lg font-bold tracking-tight">Нет сообщений</h2><p className="m-0 text-sm leading-[1.3125rem] text-muted-foreground">{readOnly ? "Обновления появятся здесь." : "Начните общение"}</p></div> : messages.map((message, index) => {
        const previous = messages[index - 1];
        const next = messages[index + 1];
        const sameAsPrevious = previous?.author === message.author && previous.time === message.time;
        const sameAsNext = next?.author === message.author && next.time === message.time;
        const bubblePosition = sameAsPrevious ? (sameAsNext ? "chat-bubble-middle" : "chat-bubble-bottom") : (sameAsNext ? "chat-bubble-top" : "chat-bubble-single");

        return (
          <div key={message.id} className={cn("chat-message", message.author === "me" ? "chat-message-out" : "chat-message-in", "flex", sameAsPrevious ? "" : "pt-2", message.author === "me" ? "justify-end" : "justify-start")}>
            <ContextMenu
              header={(close) => <div className="-mx-1.5 -mt-1.5 mb-1.5 flex items-center justify-between gap-0.5 rounded-t-xl bg-accent/70 px-2 py-1.5">{reactions.map((reaction) => <button key={reaction} type="button" className="grid size-7 place-items-center rounded-full text-base transition-transform hover:scale-125 hover:bg-background/30" title={`Реакция ${reaction}`} aria-label={`Реакция ${reaction}`} onClick={() => { onReact(message, reaction); close(); }}>{reaction}</button>)}</div>}
              footer={<div className="-mx-1.5 -mb-1.5 mt-1.5 flex items-center gap-1.5 rounded-b-xl border-t border-border/70 px-3 py-2 text-[0.6875rem] text-muted-foreground"><Icon name={message.deliveryStatus ? "schedule" : message.author === "me" && message.readAt ? "done_all" : "check"} className="size-3.5" />{message.deliveryStatus === "pending" ? "отправляется" : message.deliveryStatus === "failed" ? "не отправлено · повторю" : message.author === "me" ? (message.readAt ? "прочитано" : "доставлено") : "доставлено"}</div>}
              items={[
                { label: "Ответить", icon: <Icon name="reply" className="size-4" />, onSelect: () => onReply(message) },
                { label: "Изменить", icon: <Icon name="edit" className="size-4" />, disabled: message.author !== "me", onSelect: () => onEdit(message) },
                { label: message.pinned ? "Открепить" : "Закрепить", icon: <Icon name="push_pin" className="size-4" />, onSelect: () => onTogglePinned(message) },
                { label: "Сохранить в Избранное", icon: <Icon name="bookmark" className="size-4" />, onSelect: () => onSave(message) },
                { label: "Копировать текст", icon: <Icon name="content_copy" className="size-4" />, onSelect: () => copyText(message.text) },
                { label: "Переслать", icon: <Icon name="forward" className="size-4" />, onSelect: () => onForward(message) },
                { label: "Удалить", icon: <Icon name="delete" className="size-4" />, destructive: true, onSelect: () => onDelete(message) },
                { label: selectedIds.includes(message.id) ? "Снять выделение" : "Выделить", icon: <Icon name="select" className="size-4" />, onSelect: () => setSelectedIds((current) => current.includes(message.id) ? current.filter((id) => id !== message.id) : [...current, message.id]) },
              ]}
            >
              <div className={cn(
                "chat-bubble max-w-[min(70%,28.75rem)] px-3.5 py-2.5",
                bubblePosition,
                selectedIds.includes(message.id) && "ring-2 ring-primary/80 ring-offset-2 ring-offset-background",
                message.author === "me" ? "bg-primary text-primary-foreground chat-bubble-out" : "bg-accent chat-bubble-in",
              )}>
                <p className="whitespace-pre-wrap text-sm leading-relaxed">{message.text}</p>
                {message.reaction && <span className="mt-1 inline-flex rounded-full bg-background/25 px-1.5 py-0.5 text-sm">{message.reaction}</span>}
                {!sameAsNext && <div className={cn("mt-1 flex items-center justify-end gap-1 text-[0.625rem]", message.author === "me" ? "text-primary-foreground/65" : "text-muted-foreground")}>
                  {message.time}
                  {message.author === "me" && (message.deliveryStatus ? <span title={message.deliveryStatus === "failed" ? "Не отправлено, будет повтор" : "Отправляется"}>{message.deliveryStatus === "failed" ? "!" : "…"}</span> : <span title={message.readAt ? "Прочитано" : "Доставлено"}><Icon name={message.readAt ? "done_all" : "check"} className="size-3" /></span>)}
                  {message.edited && <span>изменено</span>}
                </div>}
              </div>
            </ContextMenu>
          </div>
        );
      })}</>}
    </div>
  );
}
