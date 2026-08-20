import { useEffect, useLayoutEffect, useState, type FormEvent } from "react";
import { Button } from "./ui/button";
import { cn, formatMessageTime, makeId } from "../lib/utils";
import type { Message } from "../types";
import { Icon } from "./ui/icon";

// #preview MessageComposer {}
type MessageComposerProps = {
  onSend?: (message: Message) => void;
  error?: string;
  replyTo?: Message | null;
  editingMessage?: Message | null;
  onEdit?: (message: Message) => void;
  onCancelContext?: () => void;
};

export function MessageComposer({ onSend = () => undefined, error = "", replyTo, editingMessage, onEdit = () => undefined, onCancelContext = () => undefined }: MessageComposerProps) {
  const [text, setText] = useState("");

  useEffect(() => {
    setText(editingMessage?.text ?? "");
  }, [editingMessage?.id]);

  useLayoutEffect(() => {
    const textarea = document.querySelector<HTMLTextAreaElement>(".message-composer textarea");
    if (!textarea) return;
    textarea.style.height = "0";
    const rootFontSize = Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    textarea.style.height = `${Math.min(textarea.scrollHeight, rootFontSize * 8)}px`;
  }, [text]);

  function submit(event: FormEvent) {
    event.preventDefault();
    const value = text.trim();
    if (!value) return;
    if (editingMessage) {
      onEdit({ ...editingMessage, text: value, edited: true });
    } else {
      onSend({ id: makeId(), author: "me", text: value, time: formatMessageTime(), replyTo: replyTo ? { id: replyTo.id, text: replyTo.text } : undefined });
    }
    setText("");
    onCancelContext();
  }

  return (
    <form onSubmit={submit} className="message-composer px-5 py-4">
      {error && <p className="mb-2 text-xs text-destructive" role="alert">{error}</p>}
      {(replyTo || editingMessage) && <div className="mb-2 flex items-center gap-2 rounded-xl bg-accent/70 px-3 py-2 text-xs"><span className="min-w-0 flex-1 truncate">{editingMessage ? "Редактирование сообщения" : `Ответ на: ${replyTo?.text}`}</span><button type="button" className="icon-button size-6" title="Отменить" aria-label="Отменить" onClick={() => { setText(""); onCancelContext(); }}><Icon name="close" className="size-3.5" /></button></div>}
      <div className="flex items-end gap-2 rounded-2xl border border-border bg-surface p-2 focus-within:border-primary/50">
        <Button type="button" size="icon" variant="ghost" title="Вложения пока недоступны" disabled className="opacity-40"><Icon name="add" className="size-4" /></Button>
        <textarea value={text} onChange={(event) => setText(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); submit(event); } }} placeholder="Написать сообщение..." rows={1} className="max-h-32 min-h-9 flex-1 resize-none bg-transparent px-1 py-2 text-sm outline-none placeholder:text-muted-foreground" />
        <div className="flex items-center gap-1">
          <Button type="button" size="icon" variant="ghost" title="Файлы пока недоступны" disabled className="opacity-40"><Icon name="attach_file" className="size-4" /></Button>
          <Button type="button" size="icon" variant="ghost" title="Эмодзи пока недоступны" disabled className="opacity-40"><Icon name="mood" className="size-4" /></Button>
          <Button type="button" size="icon" variant="ghost" title="Голосовые сообщения пока недоступны" disabled className="opacity-40"><Icon name="mic" className="size-4" /></Button>
        </div>
        <Button type="submit" size="icon" className={cn(!text.trim() && "opacity-50")} title="Отправить"><Icon name="send" className="size-4" /></Button>
      </div>
    </form>
  );
}
