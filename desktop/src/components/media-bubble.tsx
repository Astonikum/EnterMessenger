import { useEffect, useRef, useState } from "react";
import type { ReactNode, WheelEvent } from "react";
import { downloadMedia } from "../lib/enter-api";
import { decryptMedia, isAudioAttachment } from "../lib/media";
import type { MessageAttachment, Profile } from "../types";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "./ui/dialog";
import { Icon } from "./ui/icon";
import { formatDuration, formatFileSize } from "../../../common/src/format.ts";

const formatTime = formatDuration;

const speedOptions = [
  { value: 0.5, label: "Медленно" },
  { value: 0.75, label: "Чуть медленнее" },
  { value: 1, label: "Стандартно" },
  { value: 1.5, label: "Быстро" },
  { value: 2, label: "Очень быстро" },
];

const audioWaveform = [8, 13, 6, 17, 10, 20, 12, 7, 15, 22, 11, 18, 9, 14, 6, 19, 12, 8, 16, 10, 21, 13, 7, 15];

function downloadObjectUrl(url: string, name: string) {
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
}

type SaveFilePicker = () => Promise<{ createWritable: () => Promise<{ write: (value: Blob) => Promise<void>; close: () => Promise<void> }> }>;

async function saveAs(url: string, attachment: MessageAttachment) {
  const picker = (window as Window & { showSaveFilePicker?: SaveFilePicker }).showSaveFilePicker;
  if (!picker) {
    downloadObjectUrl(url, attachment.name);
    return;
  }
  try {
    const handle = await picker();
    const writer = await handle.createWritable();
    await writer.write(await (await fetch(url)).blob());
    await writer.close();
  } catch (reason) {
    if (!(reason instanceof DOMException && reason.name === "AbortError")) downloadObjectUrl(url, attachment.name);
  }
}

function MediaViewer({ url, attachment, onClose, autoplay = false }: { url: string; attachment: MessageAttachment; onClose: () => void; autoplay?: boolean }) {
  const mediaRef = useRef<HTMLMediaElement | null>(null);
  const [rotation, setRotation] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [maxZoom, setMaxZoom] = useState(1);
  const [mediaSize, setMediaSize] = useState<{ width: number; height: number }>();
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [speed, setSpeed] = useState(1);
  const [speedOpen, setSpeedOpen] = useState(false);
  const [volume, setVolume] = useState(1);
  const [playbackError, setPlaybackError] = useState(false);
  const speedMenuRef = useRef<HTMLDivElement>(null);
  const zoomable = attachment.kind === "image" || attachment.kind === "video";
  const playable = attachment.kind === "video" || attachment.kind === "audio";

  useEffect(() => {
    setPlaying(false);
    setCurrentTime(0);
    setDuration(0);
    setPlaybackError(false);
  }, [url]);

  useEffect(() => () => { mediaRef.current?.pause(); }, []);

  function playMedia(media: HTMLMediaElement) {
    setPlaybackError(false);
    void media.play().catch(() => {
      setPlaying(false);
      setPlaybackError(true);
    });
  }

  useEffect(() => {
    if (!mediaSize) return;
    const updateMaxZoom = () => {
      const rotated = Math.abs(rotation % 180) === 90;
      const width = rotated ? mediaSize.height : mediaSize.width;
      const height = rotated ? mediaSize.width : mediaSize.height;
      const availableWidth = Math.max(1, window.innerWidth - 64);
      const availableHeight = Math.max(1, window.innerHeight - 64);
      const baseScale = Math.min(1, availableWidth / width, availableHeight / height);
      const nextMaxZoom = Math.max(1, Number((1 / baseScale).toFixed(2)));
      setMaxZoom(nextMaxZoom);
      setZoom((value) => Math.min(value, nextMaxZoom));
    };
    updateMaxZoom();
    window.addEventListener("resize", updateMaxZoom);
    return () => window.removeEventListener("resize", updateMaxZoom);
  }, [mediaSize, rotation]);

  useEffect(() => {
    if (!mediaRef.current) return;
    mediaRef.current.playbackRate = speed;
    mediaRef.current.volume = volume;
  }, [speed, volume]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  useEffect(() => {
    if (!speedOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!speedMenuRef.current?.contains(event.target as Node)) setSpeedOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [speedOpen]);

  const handleWheel = (event: WheelEvent<HTMLDivElement>) => {
    if (!zoomable) return;
    event.preventDefault();
    setZoom((value) => Math.min(maxZoom, Math.max(0.2, Number((value + (event.deltaY < 0 ? 0.1 : -0.1)).toFixed(2)))));
  };

  const togglePlayback = () => {
    if (!mediaRef.current) return;
    if (mediaRef.current.paused) playMedia(mediaRef.current);
    else mediaRef.current.pause();
  };

  const seek = (value: number) => {
    if (!mediaRef.current) return;
    mediaRef.current.currentTime = value;
    setCurrentTime(value);
  };

  const content = attachment.kind === "image"
      ? <img src={url} alt={attachment.name} onLoad={(event) => setMediaSize({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })} className="block max-h-[calc(100vh-2rem)] max-w-[calc(100vw-2rem)] object-contain transition-transform duration-200" style={{ transform: `rotate(${rotation}deg) scale(${zoom})` }} />
      : attachment.kind === "video"
      ? <video ref={(node) => { mediaRef.current = node; }} src={url} playsInline onPlay={() => { setPlaybackError(false); setPlaying(true); }} onPause={() => setPlaying(false)} onEnded={() => { setPlaying(false); setCurrentTime(0); }} onError={() => { setPlaying(false); setPlaybackError(true); }} onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)} onLoadedMetadata={(event) => { setDuration(event.currentTarget.duration); setMediaSize({ width: event.currentTarget.videoWidth, height: event.currentTarget.videoHeight }); if (autoplay) playMedia(event.currentTarget); }} className="block max-h-[calc(100vh-2rem)] max-w-[calc(100vw-2rem)] object-contain transition-transform duration-200" style={{ transform: `rotate(${rotation}deg) scale(${zoom})` }} />
      : <div className="flex w-[min(36rem,80vw)] flex-col items-center gap-3 rounded-3xl bg-white/10 px-8 py-10 text-center backdrop-blur-xl"><div className="grid size-16 place-items-center rounded-2xl bg-white/10"><Icon name="mic" className="size-8 text-white/80" /></div><p className="max-w-full truncate text-sm font-medium text-white">{attachment.name}</p><audio ref={(node) => { mediaRef.current = node; }} src={url} onPlay={() => { setPlaybackError(false); setPlaying(true); }} onPause={() => setPlaying(false)} onEnded={() => { setPlaying(false); setCurrentTime(0); }} onError={() => { setPlaying(false); setPlaybackError(true); }} onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)} onLoadedMetadata={(event) => { setDuration(event.currentTarget.duration); playMedia(event.currentTarget); }} className="sr-only" /></div>;
  const mediaKind = attachment.kind === "image" ? "Фото" : attachment.kind === "video" ? "Видео" : "Аудио";
  return <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
    <DialogContent aria-label={`Просмотр: ${attachment.name}`} onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <DialogTitle className="sr-only">Просмотр: {attachment.name}</DialogTitle>
      <DialogDescription className="sr-only">{formatFileSize(attachment.size)}</DialogDescription>
      <div className="relative flex h-full w-full items-center justify-center overflow-hidden p-4 text-white md:p-8" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }} onWheel={handleWheel}>
        {content}
        {playable && <div className="absolute bottom-4 left-1/2 z-10 flex w-[min(52rem,calc(100vw-2rem))] -translate-x-1/2 flex-col gap-2 rounded-2xl bg-black/65 px-3 py-2.5 shadow-2xl shadow-black/30 backdrop-blur-xl" onWheel={(event) => event.stopPropagation()}>
          <input aria-label="Позиция воспроизведения" title="Позиция воспроизведения" type="range" min="0" max={duration || 0} step="0.1" value={Math.min(currentTime, duration || 0)} onChange={(event) => seek(Number(event.target.value))} className="h-1.5 w-full cursor-pointer accent-[#b3a4ff]" />
          {playbackError && <span role="status" className="text-xs text-red-200">Не удалось воспроизвести файл. Нажмите ▶ для повтора.</span>}
          <div className="flex items-center gap-2">
            <Button type="button" variant="ghost" size="icon" className="size-8 shrink-0 rounded-xl text-white/85 hover:bg-white/15 hover:text-white" title={playing ? "Пауза" : "Воспроизвести"} aria-label={playing ? "Пауза" : "Воспроизвести"} onClick={togglePlayback}><Icon name={playing ? "pause" : "play"} className="size-4" /></Button>
            <span className="min-w-20 text-xs tabular-nums text-white/70">{formatTime(currentTime)} / {formatTime(duration)}</span>
            <Button type="button" variant="ghost" size="icon" className="size-8 shrink-0 rounded-xl text-white/85 hover:bg-white/15 hover:text-white" title={volume ? "Выключить звук" : "Включить звук"} aria-label={volume ? "Выключить звук" : "Включить звук"} onClick={() => setVolume((value) => value ? 0 : 1)}><Icon name={volume ? "volume" : "volume_off"} className="size-4" /></Button>
            <input aria-label="Громкость" title="Громкость" type="range" min="0" max="1" step="0.05" value={volume} onChange={(event) => setVolume(Number(event.target.value))} className="w-20 cursor-pointer accent-[#b3a4ff]" />
            <div ref={speedMenuRef} className="relative ml-auto shrink-0">
              <Button type="button" variant="ghost" size="icon" className="size-8 rounded-xl text-white/85 hover:bg-white/15 hover:text-white" title={`Скорость: ${speed}×`} aria-label={`Скорость: ${speed}×`} aria-haspopup="menu" aria-expanded={speedOpen} onClick={() => setSpeedOpen((value) => !value)}><Icon name="speed" className="size-4" /></Button>
              {speedOpen && <div role="menu" className="absolute bottom-full right-0 mb-2 w-56 overflow-hidden rounded-2xl border border-white/10 bg-[#19151f]/95 p-1.5 text-white shadow-2xl shadow-black/50 backdrop-blur-xl">
                <p className="px-3 py-2 text-xs font-semibold text-white/60">Скорость</p>
                {speedOptions.map((option) => <button key={option.value} type="button" role="menuitemradio" aria-checked={option.value === speed} className={`flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left text-sm transition-colors ${option.value === speed ? "bg-[#b3a4ff]/20 text-[#d9d2ff]" : "text-white/85 hover:bg-white/10"}`} onClick={() => { setSpeed(option.value); setSpeedOpen(false); }}><span className="w-10 shrink-0 font-medium tabular-nums">{option.value}×</span><span className="truncate">{option.label}</span>{option.value === speed && <span className="ml-auto text-[#b3a4ff]">✓</span>}</button>)}
              </div>}
            </div>
          </div>
        </div>}
      </div>
    <aside className="absolute right-4 top-4 z-10 flex max-w-[calc(100vw-2rem)] flex-row items-center gap-1.5 overflow-x-auto rounded-2xl bg-black/60 p-2 shadow-2xl shadow-black/40 backdrop-blur-xl">
      <div className="min-w-0 max-w-[min(18rem,35vw)] shrink px-2 py-1 text-right"><p className="truncate text-xs font-semibold">{attachment.name} <span className="font-normal text-white/55">· {mediaKind} · {formatFileSize(attachment.size)}</span></p></div>
      <div className="flex shrink-0 items-center justify-end gap-0.5">
        {(attachment.kind === "image" || attachment.kind === "video") && <Button type="button" variant="ghost" size="icon" className="size-9 rounded-xl text-white/80 hover:bg-white/15 hover:text-white" title="Повернуть налево" aria-label="Повернуть налево" onClick={() => setRotation((value) => value - 90)}><Icon name="rotate_left" className="size-4" /></Button>}
        <Button type="button" variant="ghost" size="icon" className="size-9 rounded-xl text-white/80 hover:bg-white/15 hover:text-white" title="Сохранить в загрузки" aria-label="Сохранить в загрузки" onClick={() => downloadObjectUrl(url, attachment.name)}><Icon name="download" className="size-4" /></Button><Button type="button" variant="ghost" size="icon" className="size-9 rounded-xl text-white/80 hover:bg-white/15 hover:text-white" title="Сохранить как" aria-label="Сохранить как" onClick={() => void saveAs(url, attachment)}><Icon name="save" className="size-4" /></Button><Button type="button" variant="ghost" size="icon" className="size-9 rounded-xl bg-white/10 text-white hover:bg-white/20" title="Закрыть просмотр" aria-label="Закрыть просмотр" onClick={onClose}><Icon name="close" className="size-4" /></Button>
      </div>
    </aside>
    </DialogContent>
  </Dialog>;
}

export type MediaContextActions = {
  save: () => void;
  saveAs: () => void;
};

type MediaContextProps = {
  "data-attachment-context": string;
  onContextMenu: () => void;
};

function AudioBubble({ attachment, url, grouped, className, contextProps }: { attachment: MessageAttachment; url: string; grouped: boolean; className?: string; contextProps: MediaContextProps }) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const initialDuration = Math.max(0, (attachment.durationMs ?? 0) / 1000);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(initialDuration);
  const [playbackError, setPlaybackError] = useState(false);

  useEffect(() => {
    setPlaying(false);
    setCurrentTime(0);
    setDuration(initialDuration);
    setPlaybackError(false);
  }, [initialDuration, url]);

  useEffect(() => () => { audioRef.current?.pause(); }, []);

  function togglePlayback() {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) {
      setPlaybackError(false);
      void audio.play().catch(() => { setPlaying(false); setPlaybackError(true); });
    }
    else audio.pause();
  }

  function seek(value: number) {
    const audio = audioRef.current;
    if (!audio) return;
    audio.currentTime = value;
    setCurrentTime(value);
  }

  const progress = duration > 0 ? Math.min(1, currentTime / duration) : 0;
  return <div {...contextProps} className={cn("flex min-w-60 items-center gap-2.5 rounded-xl bg-background/15 px-3 py-2.5 text-left transition-colors hover:bg-background/25", grouped && "h-full min-w-0 px-2", className)}>
    <audio ref={audioRef} src={url} preload="metadata" className="sr-only" onPlay={() => { setPlaybackError(false); setPlaying(true); }} onPause={() => setPlaying(false)} onError={() => { setPlaying(false); setPlaybackError(true); }} onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)} onLoadedMetadata={(event) => setDuration(Number.isFinite(event.currentTarget.duration) ? event.currentTarget.duration : initialDuration)} onEnded={() => { setPlaying(false); setCurrentTime(0); }} aria-label={attachment.name} />
    <Button type="button" variant="ghost" size="icon" className="size-9 shrink-0 rounded-full bg-foreground/10 text-current hover:bg-foreground/20" title={playing ? "Пауза" : "Воспроизвести"} aria-label={playing ? `Поставить на паузу: ${attachment.name}` : `Воспроизвести: ${attachment.name}`} onClick={togglePlayback}><Icon name={playing ? "pause" : "play"} className="size-4" /></Button>
    <div className="min-w-0 flex-1">
      <div className="flex items-center gap-2 text-xs"><span className="min-w-0 flex-1 truncate font-medium">{attachment.name}</span><span className="shrink-0 tabular-nums opacity-70">{formatTime(currentTime)} / {formatTime(duration)}</span></div>
      <div className="relative mt-1.5 h-5">
        <div className="pointer-events-none absolute inset-0 flex items-center gap-0.5 overflow-hidden opacity-45">{audioWaveform.map((height, index) => <span key={index} className="w-0.5 shrink-0 rounded-full bg-current" style={{ height }} />)}</div>
        <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center gap-0.5 overflow-hidden" style={{ width: `${progress * 100}%` }}>{audioWaveform.map((height, index) => <span key={index} className="w-0.5 shrink-0 rounded-full bg-current" style={{ height }} />)}</div>
        <input aria-label={`Позиция аудио: ${attachment.name}`} title="Позиция аудио" type="range" min="0" max={duration || 0} step="0.1" value={Math.min(currentTime, duration || 0)} onChange={(event) => seek(Number(event.target.value))} className="absolute inset-0 h-full w-full cursor-pointer opacity-0" />
      </div>
      {playbackError && <span role="status" className="block text-[0.6875rem] text-red-200">Не удалось воспроизвести</span>}
      <span className="block text-[0.6875rem] opacity-60">Аудио · {formatFileSize(attachment.size)}</span>
    </div>
    <Button type="button" variant="ghost" size="icon" className="size-8 shrink-0 rounded-lg text-current/65 hover:bg-foreground/10 hover:text-current" title="Сохранить аудио" aria-label={`Сохранить ${attachment.name}`} onClick={() => downloadObjectUrl(url, attachment.name)}><Icon name="download" className="size-4" /></Button>
  </div>;
}

export function MediaBubble({ profile, attachment, grouped = false, className, autoDownload = true, autoplayVideo = false, onAttachmentContextMenu }: { profile?: Profile; attachment: MessageAttachment; grouped?: boolean; className?: string; autoDownload?: boolean; autoplayVideo?: boolean; onAttachmentContextMenu?: (attachment: MessageAttachment, actions: MediaContextActions) => void }) {
  const [url, setUrl] = useState<string>();
  const [error, setError] = useState(false);
  const [viewerOpen, setViewerOpen] = useState(false);
  const [manualDownload, setManualDownload] = useState(false);
  const profileKey = profile ? `${profile.id}:${profile.server}:${profile.token}` : "";

  useEffect(() => {
    let disposed = false;
    const controller = new AbortController();
    let objectUrl: string | undefined;
    setUrl(undefined);
    setError(false);
    if (!autoDownload && !manualDownload) return () => undefined;
    if (!profile) return () => undefined;
    void downloadMedia(profile, attachment.id, controller.signal)
      .then((ciphertext) => decryptMedia(ciphertext, attachment))
      .then((plaintext) => {
        if (disposed) return;
        objectUrl = URL.createObjectURL(new Blob([plaintext.slice().buffer as ArrayBuffer], { type: attachment.mimeType }));
        setUrl(objectUrl);
      })
      .catch(() => { if (!disposed) setError(true); });
    return () => { disposed = true; controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [attachment.id, attachment.key, attachment.nonce, attachment.sha256, attachment.mimeType, autoDownload, manualDownload, profileKey]);

  if (error) return <div className={cn("rounded-xl border border-destructive/30 bg-background/20 px-3 py-2 text-xs", className)}>Не удалось загрузить вложение</div>;
  if (!url && !autoDownload && !manualDownload) return <Button type="button" variant="ghost" className={cn("min-h-16 min-w-44 rounded-xl bg-background/15 px-3 py-2 text-xs text-current/80 hover:bg-background/25", grouped && "h-full min-w-0", className)} onClick={() => setManualDownload(true)}><Icon name="download" className="size-4" />Загрузить медиа</Button>;
  if (!url) return <div className={cn("flex min-h-16 min-w-44 items-center gap-2 rounded-xl bg-background/15 px-3 py-2 text-xs text-current/70", grouped && "h-full min-w-0 justify-center", className)}><Icon name="progress_activity" className="size-4 animate-spin" />{!grouped && "Загрузка вложения…"}</div>;
  const contextProps = { "data-attachment-context": "true", onContextMenu: () => onAttachmentContextMenu?.(attachment, { save: () => downloadObjectUrl(url, attachment.name), saveAs: () => void saveAs(url, attachment) }) };
  if (attachment.kind === "image") return <><button type="button" {...contextProps} className={cn("block overflow-hidden rounded-xl p-0", grouped && "h-full", className)} onClick={() => setViewerOpen(true)} aria-label={`Открыть ${attachment.name}`}><img src={url} alt={attachment.name} className={grouped ? "size-full object-cover" : "max-h-80 max-w-full object-cover"} /></button>{viewerOpen && <MediaViewer url={url} attachment={attachment} onClose={() => setViewerOpen(false)} />}</>;
  if (attachment.kind === "video") return <><button type="button" {...contextProps} className={cn("relative block overflow-hidden rounded-xl bg-black p-0", grouped && "h-full", className)} onClick={() => setViewerOpen(true)} aria-label={`Открыть ${attachment.name}`}><video src={url} muted playsInline preload="metadata" autoPlay={autoplayVideo} className={cn("pointer-events-none", grouped ? "size-full object-cover" : "max-h-80 max-w-full object-contain")} /><span className="pointer-events-none absolute inset-0 grid place-items-center text-3xl text-white/90 drop-shadow">▶</span></button>{viewerOpen && <MediaViewer url={url} attachment={attachment} autoplay={autoplayVideo} onClose={() => setViewerOpen(false)} />}</>;
  if (isAudioAttachment(attachment)) return <AudioBubble attachment={attachment} url={url} grouped={grouped} className={className} contextProps={contextProps} />;
  return <a href={url} download={attachment.name} {...contextProps} className={cn("flex min-w-52 items-center gap-3 rounded-xl bg-background/15 px-3 py-2.5 transition-colors hover:bg-background/25", grouped && "h-full min-w-0 px-2", className)}><span className="grid size-9 shrink-0 place-items-center rounded-lg bg-background/20"><Icon name="attach_file" className="size-4" /></span><span className="min-w-0"><span className="block truncate text-sm font-medium">{attachment.name}</span><span className="block text-xs opacity-65">{formatFileSize(attachment.size)}</span></span></a>;
}

function mediaGridClass(count: number) {
  if (count === 3) return "grid-cols-2 grid-rows-2";
  if (count >= 6) return "grid-cols-3";
  return "grid-cols-2";
}

export function MediaGroup({ profile, attachments, overlay, captioned = false, autoDownload = true, autoplayVideo = false, onAttachmentContextMenu }: { profile?: Profile; attachments: MessageAttachment[]; overlay?: ReactNode; captioned?: boolean; autoDownload?: boolean; autoplayVideo?: boolean; onAttachmentContextMenu?: (attachment: MessageAttachment, actions: MediaContextActions) => void }) {
  const rounding = captioned ? "rounded-t-xl rounded-b-none" : "rounded-xl";
  const content = attachments.length === 1
    ? <MediaBubble profile={profile} attachment={attachments[0]} autoDownload={autoDownload} autoplayVideo={autoplayVideo} className={rounding} onAttachmentContextMenu={onAttachmentContextMenu} />
    : <div className={cn("grid min-w-0 gap-0.5 overflow-hidden", rounding, mediaGridClass(attachments.length), attachments.length === 3 ? "auto-rows-[5.5rem]" : "auto-rows-[7rem]")}>{attachments.map((attachment, index) => <MediaBubble key={attachment.id} profile={profile} attachment={attachment} autoDownload={autoDownload} autoplayVideo={autoplayVideo} grouped className={cn("rounded-none", attachments.length === 3 && index === 0 ? "row-span-2" : undefined)} onAttachmentContextMenu={onAttachmentContextMenu} />)}</div>;
  return <div className="relative min-w-0">{content}{overlay}</div>;
}
