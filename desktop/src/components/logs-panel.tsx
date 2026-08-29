import { useEffect, useMemo, useState } from "react";
import { clearLogs, getLogs, loadLogs, subscribeLogs, type LogCategory, type LogEntry, type LogLevel } from "../lib/logs";
import { Button } from "./ui/button";
import { Icon } from "./ui/icon";

type Props = { onClose: () => void };
type LogFilter = "all" | LogCategory;

const filters: Array<{ id: LogFilter; label: string }> = [
  { id: "all", label: "Все" },
  { id: "sync", label: "Синхронизация" },
  { id: "send", label: "Отправка" },
  { id: "realtime", label: "Realtime" },
  { id: "auth", label: "Авторизация" },
  { id: "network", label: "Сеть" },
  { id: "crypto", label: "Шифрование" },
  { id: "media", label: "Медиа" },
  { id: "system", label: "Система" },
];

const categoryLabels: Record<LogCategory, string> = {
  auth: "Auth",
  network: "Network",
  sync: "Sync",
  realtime: "Realtime",
  send: "Send",
  media: "Media",
  crypto: "Crypto",
  system: "System",
};

const levelLabels: Record<LogLevel, string> = { info: "INFO", success: "OK", warn: "WARN", error: "ERROR" };

function formatLogDate(value: number) {
  return new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date(value));
}

function formatLogLine(entry: LogEntry) {
  return `${formatLogDate(entry.at)} [${levelLabels[entry.level]}] [${categoryLabels[entry.category]}] ${entry.message}${entry.details ? ` — ${entry.details}` : ""}`;
}

export function LogsPanel({ onClose }: Props) {
  const [logs, setLogs] = useState<LogEntry[]>(() => [...loadLogs()].reverse());
  const [filter, setFilter] = useState<LogFilter>("all");
  const [query, setQuery] = useState("");
  useEffect(() => subscribeLogs(() => setLogs([...getLogs()].reverse())), []);
  const visibleLogs = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    return logs.filter((entry) => (filter === "all" || entry.category === filter) && (!normalizedQuery || formatLogLine(entry).toLocaleLowerCase().includes(normalizedQuery)));
  }, [filter, logs, query]);

  return <section className="logs-workspace" aria-labelledby="logs-title">
    <header className="logs-panel-header"><h1 id="logs-title">Логи</h1><div className="flex items-center gap-2"><Button variant="outline" size="sm" disabled={logs.length === 0} onClick={clearLogs}><Icon name="delete" className="size-4" />Очистить</Button><button type="button" className="icon-button" title="Закрыть логи" aria-label="Закрыть логи" onClick={onClose}><Icon name="close" className="size-4" /></button></div></header>
    <div className="logs-panel-body">
      <label className="logs-search"><Icon name="search" className="size-4" /><span className="sr-only">Поиск по логам</span><input aria-label="Поиск по логам" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Поиск по логам" /></label>
      <div className="logs-filters" role="tablist" aria-label="Фильтр логов">{filters.map((item) => <button key={item.id} type="button" role="tab" aria-selected={filter === item.id} className={filter === item.id ? "logs-filter logs-filter-active" : "logs-filter"} onClick={() => setFilter(item.id)}>{item.label}</button>)}</div>
      <div className="logs-list" role="log" aria-live="polite">{visibleLogs.length === 0 ? <p className="logs-empty">{logs.length === 0 ? "Логов пока нет. Выполните действие в приложении." : "Поиск не дал результатов."}</p> : visibleLogs.map((entry) => <p key={entry.id} className={`logs-line logs-line-${entry.level}`}>{formatLogLine(entry)}</p>)}</div>
    </div>
  </section>;
}
