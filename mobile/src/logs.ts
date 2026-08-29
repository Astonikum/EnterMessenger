import AsyncStorage from "@react-native-async-storage/async-storage";

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

const STORAGE_KEY = "enter-diagnostic-logs";
const MAX_LOGS = 300;
let entries: LogEntry[] = [];
const listeners = new Set<() => void>();
let loaded = false;

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

function migrateLegacyText(value: string | undefined) {
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

function migrateLegacyEntry(entry: LogEntry): LogEntry {
  return { ...entry, message: migrateLegacyText(entry.message) ?? "Event", details: migrateLegacyText(entry.details) };
}

function isLogEntry(value: unknown): value is LogEntry {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<LogEntry>;
  return typeof item.id === "string"
    && typeof item.at === "number"
    && typeof item.category === "string"
    && typeof item.level === "string"
    && typeof item.message === "string"
    && (item.details === undefined || typeof item.details === "string");
}

function safeText(value: string | undefined, max = 320) {
  return value?.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/Bearer\s+\S+/gi, "Bearer …").replace(/(password|token|secret|authorization|privateKey|encryptionKey|apiKey|accessToken|refreshToken|sessionToken)(\s*[=:]\s*)([^\s,&;}"]+)/gi, "$1$2…").slice(0, max);
}

function notify() {
  listeners.forEach((listener) => listener());
}

function persist() {
  void AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(entries)).catch(() => undefined);
}

export async function loadLogs() {
  if (!loaded) {
    try {
      const raw = await AsyncStorage.getItem(STORAGE_KEY);
      if (loaded) return entries;
      const stored: unknown = raw ? JSON.parse(raw) : [];
      const previous = Array.isArray(stored) ? stored.filter(isLogEntry).map(migrateLegacyEntry).slice(-MAX_LOGS) : [];
      entries = [...previous, ...entries].filter((entry, index, all) => all.findIndex((item) => item.id === entry.id) === index).map(migrateLegacyEntry).slice(-MAX_LOGS);
    } catch {
      // Diagnostics must never block the app.
    }
    loaded = true;
  }
  return entries;
}

export function getLogs() {
  return entries;
}

export function logEvent(category: LogCategory, message: string, details?: string, level: LogLevel = "info") {
  entries = [...entries, { id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, at: Date.now(), category, level, message: safeText(message, 160) ?? "Event", details: safeText(details) }].slice(-MAX_LOGS);
  persist();
  notify();
}

export function clearLogs() {
  loaded = true;
  entries = [];
  persist();
  notify();
}

export function subscribeLogs(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
