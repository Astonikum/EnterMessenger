import { useEffect, useState, type FormEvent } from "react";
import { folderContains, FOLDER_ICONS, FOLDER_TEMPLATES, type ChatFolder, type FolderIcon, type FolderTemplate } from "../lib/folders";
import type { Conversation } from "../types";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "./ui/dialog";
import { Icon } from "./ui/icon";
import { Input } from "./ui/input";

export type FolderDraft = Pick<ChatFolder, "name" | "template" | "icon">;

const EMPTY_DRAFT: FolderDraft = { name: "", template: "custom", icon: "folder" };

export function FolderDialog({ open, folder, onClose, onSave }: { open: boolean; folder?: ChatFolder | null; onClose: () => void; onSave: (draft: FolderDraft) => void }) {
  const [draft, setDraft] = useState<FolderDraft>(EMPTY_DRAFT);

  useEffect(() => {
    setDraft(folder ? { name: folder.name, template: folder.template, icon: folder.icon } : EMPTY_DRAFT);
  }, [folder, open]);

  function submit(event: FormEvent) {
    event.preventDefault();
    const name = draft.name.trim();
    if (!name) return;
    onSave({ ...draft, name });
  }

  return <Dialog open={open} onOpenChange={(nextOpen) => { if (!nextOpen) onClose(); }}>
    <DialogContent className="grid place-items-center p-4">
      <form onSubmit={submit} className="w-full max-w-lg rounded-2xl border border-border bg-surface p-5 shadow-2xl shadow-black/50">
        <DialogTitle className="font-heading text-xl font-semibold">{folder ? "Настройки папки" : "Новая папка"}</DialogTitle>
        <DialogDescription className="sr-only">Настройте название, шаблон и значок папки.</DialogDescription>
        <div className="mt-5 space-y-5">
          <Input aria-label="Название папки" value={draft.name} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} placeholder="Например, Работа" maxLength={40} autoFocus />
          <fieldset aria-label="Шаблон" className="space-y-2">
            <div className="grid gap-2">
              {FOLDER_TEMPLATES.map((option) => <button key={option.id} type="button" className={`rounded-xl border p-3 text-left transition-colors ${draft.template === option.id ? "border-primary bg-primary/10" : "border-border hover:bg-accent"}`} onClick={() => setDraft((current) => ({ ...current, template: option.id }))} aria-pressed={draft.template === option.id}>
                <span className="block text-sm font-medium">{option.label}</span>
              </button>)}
            </div>
          </fieldset>
          <fieldset aria-label="Иконка" className="space-y-2">
            <div className="flex flex-wrap gap-2">
              {FOLDER_ICONS.map((option) => <button key={option.id} type="button" title={option.label} aria-label={option.label} className={`grid size-10 place-items-center rounded-xl border transition-colors ${draft.icon === option.id ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground hover:bg-accent hover:text-foreground"}`} onClick={() => setDraft((current) => ({ ...current, icon: option.id }))} aria-pressed={draft.icon === option.id}><Icon name={option.id} className="size-5" /></button>)}
            </div>
          </fieldset>
        </div>
        <div className="mt-6 flex justify-end gap-2"><Button type="button" variant="ghost" onClick={onClose}>Отмена</Button><Button type="submit">Сохранить</Button></div>
      </form>
    </DialogContent>
  </Dialog>;
}

export function FolderPickerDialog({ open, conversation, folders, onClose, onToggle }: { open: boolean; conversation?: Conversation; folders: ChatFolder[]; onClose: () => void; onToggle: (folderId: string, included: boolean) => void }) {
  return <Dialog open={open} onOpenChange={(nextOpen) => { if (!nextOpen) onClose(); }}>
    <DialogContent className="grid place-items-center p-4">
      <div className="w-full max-w-md rounded-2xl border border-border bg-surface p-5 shadow-2xl shadow-black/50">
        <DialogTitle className="truncate font-heading text-xl font-semibold">{conversation?.name ? `Папки: ${conversation.name}` : "Папки чата"}</DialogTitle>
        <DialogDescription className="sr-only">Выбор папок для чата.</DialogDescription>
        <div className="mt-5 divide-y divide-border rounded-xl border border-border">
          {folders.length === 0 ? <p className="p-4 text-sm text-muted-foreground">Сначала создайте папку.</p> : folders.map((folder) => {
            const included = conversation ? folderContains(folder, conversation) : false;
            const automatic = folder.template !== "custom";
            return <button key={folder.id} type="button" className="flex w-full items-center gap-3 p-3 text-left transition-colors first:rounded-t-xl last:rounded-b-xl hover:bg-accent disabled:cursor-default" onClick={() => { if (!automatic) onToggle(folder.id, !included); }} disabled={automatic}>
              <span className={`grid size-9 place-items-center rounded-lg ${included ? "bg-primary/15 text-primary" : "bg-background text-muted-foreground"}`}><Icon name={folder.icon} className="size-4" /></span>
              <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{folder.name}</span></span>
              <span className={`grid size-5 place-items-center rounded-md border ${included ? "border-primary bg-primary text-primary-foreground" : "border-border"}`}>{included && <Icon name="check" className="size-3.5" />}</span>
            </button>;
          })}
        </div>
        <div className="mt-6 flex justify-end"><Button onClick={onClose}>Готово</Button></div>
      </div>
    </DialogContent>
  </Dialog>;
}

export type { FolderIcon, FolderTemplate };
