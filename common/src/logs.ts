export type LogCategory = "auth" | "network" | "sync" | "realtime" | "send" | "media" | "crypto" | "system";
export type LogLevel = "info" | "success" | "warn" | "error";

export type LogEntry = {
  id: string;
  at: number;
  category: LogCategory;
  level: LogLevel;
  message: string;
  details?: string;
};

export const MAX_LOGS = 300;

export const LOG_CATEGORY_LABELS: Record<LogCategory, string> = {
  auth: "Auth",
  network: "Network",
  sync: "Sync",
  realtime: "Realtime",
  send: "Send",
  media: "Media",
  crypto: "Crypto",
  system: "System",
};

export const LOG_LEVEL_LABELS: Record<LogLevel, string> = { info: "INFO", success: "OK", warn: "WARN", error: "ERROR" };

export function formatLogDate(value: number) {
  return new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date(value));
}

export function formatLogLine(entry: LogEntry) {
  return `${formatLogDate(entry.at)} [${LOG_LEVEL_LABELS[entry.level]}] [${LOG_CATEGORY_LABELS[entry.category]}] ${entry.message}${entry.details ? ` — ${entry.details}` : ""}`;
}

const legacyMessages: Record<string, string> = {
  "Ключи устройства готовы": "Device keys ready",
  "Собственный ключ устройства загружен": "Own device key loaded",
  "Не удалось подготовить ключи устройства": "Failed to prepare device keys",
  "Пакет синхронизации получен": "Sync package received",
  "Не удалось расшифровать сообщение": "Message decryption failed",
  "Расшифровка синхронизации завершена": "Sync decryption completed",
  "Синхронизация не удалась": "Sync failed",
  "Не удалось расшифровать realtime-сообщение": "Realtime message decryption failed",
  "Realtime-соединение закрыто": "Realtime connection closed",
  "Realtime-соединение установлено": "Realtime connection established",
  "Realtime вернул ошибку": "Realtime returned an error",
  "Realtime не удалось запустить": "Failed to start Realtime",
  "Повторная отправка сообщения": "Retrying message send",
  "Подготовка сообщения": "Preparing message",
  "Сообщение зашифровано": "Message encrypted",
  "Сообщение отправлено": "Message sent",
  "Очередь отправки переполнена": "Send queue is full",
  "Сессия истекла во время отправки": "Session expired during send",
  "Отправка сообщения не удалась": "Message send failed",
  "Повтор из очереди отправки": "Retrying queued message",
  "Сервер доступен": "Server is available",
  "Проверка сервера не удалась": "Server check failed",
  "Вход выполнен": "Signed in",
  "Регистрация выполнена": "Account registered",
  "Ошибка входа": "Sign-in failed",
  "Ошибка регистрации": "Registration failed",
  "Запрос синхронизации": "Sync request",
  "Синхронизация получена": "Sync completed",
  "Отправка сообщения": "Sending message",
  "Сообщение принято сервером": "Message accepted by server",
  "Загрузка вложения начата": "Attachment upload started",
  "Вложение загружено": "Attachment uploaded",
  "Ошибка загрузки вложения": "Attachment upload failed",
  "Загрузка вложения отменена": "Attachment upload canceled",
  "Загрузка вложения превысила тайм-аут": "Attachment upload timed out",
};

export function migrateLogText(value: string | undefined) {
  if (!value) return value;
  const direct = legacyMessages[value];
  if (direct) return direct;
  return value
    .replace("после входа", "after sign-in")
    .replace("проверка локальных ключей", "local key check")
    .replace(/^чатов (\d+), сообщений (\d+), курсор (\d+)$/, "chats $1, messages $2, cursor $3")
    .replace(/^сообщений (\d+), чатов (\d+), курсор (\d+)$/, "messages $1, chats $2, cursor $3")
    .replace(/^успешно (\d+), повторов (\d+), пропущено (\d+)$/, "success $1, retries $2, skipped $3")
    .replace(/^переход на повторное подключение$/, "switching to reconnect")
    .replace(/^соединение закрывается$/, "closing connection")
    .replace(/^вложений (\d+)$/, "attachments $1")
    .replace(/^получателей (\d+)$/, "recipients $1")
    .replace(/^курсор (\d+)$/, "cursor $1")
    .replace(/^попытка (\d+)$/, "attempt $1")
    .replace(/^размер (\d+) байт$/, "size $1 bytes")
    .replace(/^Сетевой сбой$/, "Network error")
    .replace(/^Некорректный ответ сервера$/, "Invalid server response");
}

export function isLogEntry(value: unknown): value is LogEntry {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<LogEntry>;
  return typeof item.id === "string"
    && typeof item.at === "number"
    && typeof item.category === "string"
    && typeof item.level === "string"
    && typeof item.message === "string"
    && (item.details === undefined || typeof item.details === "string");
}

export function migrateLogEntry(entry: LogEntry): LogEntry {
  return { ...entry, message: migrateLogText(entry.message) ?? "Event", details: migrateLogText(entry.details) };
}

export function normalizeStoredLogs(value: unknown) {
  return Array.isArray(value) ? value.filter(isLogEntry).map(migrateLogEntry).slice(-MAX_LOGS) : [];
}

export function sanitizeLogText(value: string | undefined, max = 320) {
  return value?.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/Bearer\s+\S+/gi, "Bearer …").replace(/(password|token|secret|authorization|privateKey|encryptionKey|apiKey|accessToken|refreshToken|sessionToken)(\s*[=:]\s*)([^\s,&;}"]+)/gi, "$1$2…").slice(0, max);
}

export function appendLogEntry(entries: LogEntry[], category: LogCategory, message: string, details?: string, level: LogLevel = "info") {
  return [...entries, { id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, at: Date.now(), category, level, message: sanitizeLogText(message, 160) ?? "Event", details: sanitizeLogText(details) }].slice(-MAX_LOGS);
}

export function mergeLogEntries(stored: LogEntry[], current: LogEntry[]) {
  return [...stored, ...current].filter((entry, index, all) => all.findIndex((item) => item.id === entry.id) === index).map(migrateLogEntry).slice(-MAX_LOGS);
}
