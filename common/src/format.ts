export function formatMessageTime(date = new Date()) {
  return new Intl.DateTimeFormat("ru-RU", { hour: "2-digit", minute: "2-digit" }).format(date);
}

export function formatFileSize(size?: number) {
  if (size === undefined || !Number.isFinite(size)) return "";
  if (size < 1024) return `${Math.round(size)} Б`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} КБ`;
  return `${(size / (1024 * 1024)).toFixed(size > 10 * 1024 * 1024 ? 0 : 1)} МБ`;
}

export function formatDuration(seconds: number) {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const total = Math.floor(seconds);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

export function formatPlaybackTime(milliseconds: number) {
  return formatDuration(Math.max(0, milliseconds) / 1000);
}

export function sameMessageStack(left?: { author: string; stackId?: string; time: string }, right?: { author: string; stackId?: string; time: string }) {
  if (!left || !right || left.author !== right.author) return false;
  return Boolean(left.stackId && right.stackId ? left.stackId === right.stackId : !left.stackId && !right.stackId && left.time === right.time);
}

export function formatLastSeen(timestamp?: number) {
  if (!timestamp) return "был(а) давно";
  const date = new Date(timestamp);
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (sameDay) return `был(а) сегодня в ${formatMessageTime(date)}`;
  if (date.toDateString() === yesterday.toDateString()) return `был(а) вчера в ${formatMessageTime(date)}`;
  return `был(а) ${new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long" }).format(date)} в ${formatMessageTime(date)}`;
}

export function presenceLabel(conversation: { online?: boolean; lastSeenAt?: number }) {
  return conversation.online ? "В сети" : formatLastSeen(conversation.lastSeenAt);
}

export function knownValue(value: string | null | undefined) {
  const normalized = value?.trim();
  return normalized && normalized.toLowerCase() !== "unknown" ? normalized : undefined;
}

export function shortId(value: string | null | undefined) {
  return value ? value.slice(0, 8) : "—";
}

export function formatSessionDate(value: number | null | undefined) {
  return value && Number.isFinite(value)
    ? new Intl.DateTimeFormat("ru-RU", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value))
    : "—";
}

export function formatReleaseDate(value: string | null) {
  return value ? new Intl.DateTimeFormat("ru-RU", { dateStyle: "medium" }).format(new Date(value)) : "дата не указана";
}

type DeviceDisplay = { deviceId: string; name?: string | null; platform: string; appVersion?: string | null; createdAt: number; lastSeenAt?: number | null };
type SessionDisplay = { id: string; deviceId?: string | null; deviceName?: string | null; platform: string; appVersion?: string | null; createdAt: number; expiresAt: number; lastSeenAt?: number | null; current: boolean };

export function deviceTitle(device: DeviceDisplay) {
  return knownValue(device.name) || `Устройство ${shortId(device.deviceId)}`;
}

export function deviceDetails(device: DeviceDisplay) {
  return [
    knownValue(device.platform) || "Платформа не указана",
    knownValue(device.appVersion) ? `версия ${knownValue(device.appVersion)}` : undefined,
    `ID ${shortId(device.deviceId)}`,
    `активно ${formatSessionDate(device.lastSeenAt ?? device.createdAt)}`,
  ].filter(Boolean).join(" · ");
}

export function sessionTitle(session: SessionDisplay) {
  return knownValue(session.deviceName) || `Устройство ${shortId(session.deviceId || session.id)}`;
}

export function sessionDetails(session: SessionDisplay) {
  return [
    knownValue(session.platform) || "Платформа не указана",
    knownValue(session.appVersion) ? `версия ${knownValue(session.appVersion)}` : undefined,
    session.deviceId ? `ID ${shortId(session.deviceId)}` : `сессия ${shortId(session.id)}`,
    `создана ${formatSessionDate(session.createdAt)}`,
    `активна ${formatSessionDate(session.lastSeenAt ?? session.createdAt)}`,
    session.current ? "текущая" : `до ${formatSessionDate(session.expiresAt)}`,
  ].filter(Boolean).join(" · ");
}
