import AsyncStorage from "@react-native-async-storage/async-storage";
import { appendLogEntry, mergeLogEntries, normalizeStoredLogs, type LogCategory, type LogEntry, type LogLevel } from "../../common/src/logs.ts";

export type { LogCategory, LogEntry, LogLevel } from "../../common/src/logs.ts";

const STORAGE_KEY = "enter-diagnostic-logs";
let entries: LogEntry[] = [];
const listeners = new Set<() => void>();
let loaded = false;

function persist() {
  void AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(entries)).catch(() => undefined);
}

function notify() {
  listeners.forEach((listener) => listener());
}

export async function loadLogs() {
  if (!loaded) {
    try {
      const raw = await AsyncStorage.getItem(STORAGE_KEY);
      if (loaded) return entries;
      const stored: unknown = raw ? JSON.parse(raw) : [];
      entries = mergeLogEntries(normalizeStoredLogs(stored), entries);
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
  entries = appendLogEntry(entries, category, message, details, level);
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
