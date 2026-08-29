import { appendLogEntry, mergeLogEntries, normalizeStoredLogs, type LogCategory, type LogEntry, type LogLevel } from "../../../common/src/logs.ts";

export type { LogCategory, LogEntry, LogLevel } from "../../../common/src/logs.ts";

const STORAGE_KEY = "enter-diagnostic-logs";
let entries: LogEntry[] = [];
const listeners = new Set<() => void>();
let loaded = false;

function readStoredLogs() {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
    return normalizeStoredLogs(value);
  } catch {
    return [];
  }
}

function persist() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(entries)); } catch { /* Diagnostics must never block the app. */ }
}

function notify() {
  listeners.forEach((listener) => listener());
}

export function loadLogs() {
  if (!loaded) { entries = mergeLogEntries(readStoredLogs(), entries); loaded = true; }
  return entries;
}

export function getLogs() {
  return entries;
}

export function logEvent(category: LogCategory, message: string, details?: string, level: LogLevel = "info") {
  if (!loaded) loadLogs();
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
