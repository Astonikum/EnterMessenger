import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { Button } from "./ui/button";
import { cn, formatMessageTime, makeId } from "../lib/utils";
import type { Message } from "../types";
import { Icon } from "./ui/icon";
import type { EncryptedMedia } from "../lib/media";

// #preview MessageComposer {}
type MessageComposerProps = {
  onSend?: (message: Message, pendingMedia?: PendingMedia[]) => void;
  error?: string;
  uploadProgress?: number | null;
  replyTo?: Message | null;
  editingMessage?: Message | null;
  onEdit?: (message: Message) => void;
  onCancelContext?: () => void;
};

export type PendingMedia = { file: File } | { encrypted: EncryptedMedia };

function formatFileSize(size: number) {
  if (size < 1024) return `${size} Б`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} КБ`;
  return `${(size / (1024 * 1024)).toFixed(size > 10 * 1024 * 1024 ? 0 : 1)} МБ`;
}

function PendingMediaPreview({ file, onRemove }: { file: File; onRemove: () => void }) {
  const [previewUrl, setPreviewUrl] = useState<string>();
  const previewable = file.type.startsWith("image/") || file.type.startsWith("video/");

  useEffect(() => {
    if (!previewable) return;
    const url = URL.createObjectURL(file);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file, previewable]);

  return <div className="flex min-w-0 max-w-72 items-center gap-2 rounded-xl border border-border bg-accent/60 p-1.5 text-xs"><div className="grid size-12 shrink-0 place-items-center overflow-hidden rounded-lg bg-background/40">{previewUrl && file.type.startsWith("image/") ? <img src={previewUrl} alt="" className="size-full object-cover" /> : previewUrl && file.type.startsWith("video/") ? <video src={previewUrl} muted playsInline preload="metadata" className="size-full object-cover" /> : <Icon name="attach_file" className="size-5 text-primary" />}</div><div className="min-w-0 flex-1"><p className="truncate font-medium">{file.name}</p><p className="text-muted-foreground">{file.type || "Файл"} · {formatFileSize(file.size)}</p></div><button type="button" className="icon-button size-6 shrink-0" title="Убрать файл" aria-label={`Убрать ${file.name}`} onClick={onRemove}><Icon name="close" className="size-3" /></button></div>;
}

export function MessageComposer({ onSend = () => undefined, error = "", uploadProgress = null, replyTo, editingMessage, onEdit = () => undefined, onCancelContext = () => undefined }: MessageComposerProps) {
  const [text, setText] = useState("");
  const [pendingMedia, setPendingMedia] = useState<PendingMedia[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setText(editingMessage?.text ?? "");
  }, [editingMessage?.id]);

  useLayoutEffect(() => {
    const textarea = document.querySelector<HTMLTextAreaElement>(".message-composer textarea");
    if (!textarea) return;
    if (!text.trim()) {
      textarea.style.height = "2.25rem";
      return;
    }
    textarea.style.height = "0";
    const rootFontSize = Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    textarea.style.height = `${Math.min(textarea.scrollHeight, rootFontSize * 8)}px`;
  }, [text]);

  function submit(event: FormEvent) {
    event.preventDefault();
    const value = text.trim();
    if (uploadProgress !== null || (!value && pendingMedia.length === 0)) return;
    if (editingMessage) {
      onEdit({ ...editingMessage, text: value, edited: true });
    } else {
      onSend({ id: makeId(), author: "me", text: value, time: formatMessageTime(), replyTo: replyTo ? { id: replyTo.id, text: replyTo.text } : undefined }, pendingMedia);
    }
    setText("");
    setPendingMedia([]);
    if (fileInputRef.current) fileInputRef.current.value = "";
    onCancelContext();
  }

  function addFiles(files: FileList | File[]) {
    if (editingMessage) return;
    setPendingMedia((current) => [...current, ...Array.from(files).map((file) => ({ file }))].slice(0, 10));
  }

  return (
    <form onSubmit={submit} className="message-composer px-5 py-4">
      {error && <p className="mb-2 text-xs text-destructive" role="alert">{error}</p>}
      {uploadProgress !== null && <div className="mb-2 rounded-xl border border-border bg-accent/50 px-3 py-2"><div className="mb-1 flex items-center justify-between text-xs"><span>{uploadProgress < 1 ? "Подготовка вложения…" : "Отправка вложения…"}</span><span className="text-muted-foreground">{uploadProgress}%</span></div><div className="h-1.5 overflow-hidden rounded-full bg-background/60"><div className="h-full rounded-full bg-primary transition-[width] duration-150" style={{ width: `${uploadProgress}%` }} /></div></div>}
      {(replyTo || editingMessage) && <div className="mb-2 flex items-center gap-2 rounded-xl bg-accent/70 px-3 py-2 text-xs"><span className="min-w-0 flex-1 truncate">{editingMessage ? "Редактирование сообщения" : `Ответ на: ${replyTo?.text}`}</span><button type="button" className="icon-button size-6" title="Отменить" aria-label="Отменить" onClick={() => { setText(""); onCancelContext(); }}><Icon name="close" className="size-3.5" /></button></div>}
      {pendingMedia.length > 0 && <div className="mb-2 flex flex-wrap gap-2">{pendingMedia.map((item, index) => "file" in item ? <PendingMediaPreview key={`${item.file.name}-${index}`} file={item.file} onRemove={() => setPendingMedia((current) => current.filter((_, itemIndex) => itemIndex !== index))} /> : <div key={`${item.encrypted.attachment.name}-${index}`} className="rounded-xl border border-border bg-accent/60 p-2 text-xs">{item.encrypted.attachment.name}</div>)}</div>}
      <div className="flex items-end gap-2 rounded-2xl border border-border bg-surface p-2 focus-within:border-primary/50">
        <input ref={fileInputRef} type="file" multiple className="hidden" onChange={(event) => { if (event.target.files) addFiles(event.target.files); event.target.value = ""; }} />
        <Button type="button" size="icon" variant="ghost" className="message-composer-attach rounded-full" title="Прикрепить файл" aria-label="Прикрепить файл" onClick={() => fileInputRef.current?.click()} disabled={Boolean(editingMessage) || uploadProgress !== null}><Icon name="attach_file" className="size-4" /></Button>
        <textarea value={text} onChange={(event) => setText(event.target.value)} onPaste={(event) => { if (event.clipboardData.files.length > 0) { event.preventDefault(); addFiles(event.clipboardData.files); } }} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); submit(event); } }} placeholder="Написать сообщение..." rows={1} className="message-composer-input max-h-32 min-h-9 flex-1 resize-none bg-transparent px-1 py-2 text-sm outline-none placeholder:text-muted-foreground" />
        <Button type="submit" size="icon" className={cn((uploadProgress !== null || (!text.trim() && pendingMedia.length === 0)) && "opacity-50")} title="Отправить" disabled={uploadProgress !== null || (!text.trim() && pendingMedia.length === 0)}><Icon name="send" className="size-4" /></Button>
      </div>
    </form>
  );
}
