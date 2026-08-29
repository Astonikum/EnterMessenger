import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { clearLogs, getLogs, loadLogs, subscribeLogs, type LogCategory, type LogEntry, type LogLevel } from "../logs";
import { colors, fonts, radii } from "../theme";
import { Icon } from "./Icon";

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

export function LogsScreen({ onClose }: Props) {
  const [logs, setLogs] = useState<LogEntry[]>(() => [...getLogs()].reverse());
  const [filter, setFilter] = useState<LogFilter>("all");
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let mounted = true;
    void loadLogs().then(() => { if (mounted) { setLogs([...getLogs()].reverse()); setLoading(false); } });
    return () => { mounted = false; };
  }, []);
  useEffect(() => subscribeLogs(() => setLogs([...getLogs()].reverse())), []);
  const visibleLogs = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    return logs.filter((entry) => (filter === "all" || entry.category === filter) && (!normalizedQuery || formatLogLine(entry).toLocaleLowerCase().includes(normalizedQuery)));
  }, [filter, logs, query]);

  return <View style={styles.root}>
    <View style={styles.header}><Pressable onPress={onClose} style={styles.back} accessibilityRole="button" accessibilityLabel="Назад"><Icon name="arrowBack" size={21} color={colors.foreground} /></Pressable><View style={styles.centeredHeaderTitle}><Text style={styles.headerTitle}>Логи</Text></View><Pressable onPress={clearLogs} disabled={logs.length === 0} style={styles.clearButton} accessibilityRole="button" accessibilityLabel="Очистить логи"><Icon name="delete" size={17} color={logs.length ? colors.muted : colors.border} /><Text style={[styles.clearText, !logs.length && styles.disabledText]}>Очистить</Text></Pressable></View>
    <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
      <Text style={styles.meta}>Журнал устройства · локально · записей: {logs.length} · содержимое сообщений не записывается</Text>
      <View style={styles.search}><Icon name="search" size={17} color={colors.muted} /><TextInput value={query} onChangeText={setQuery} placeholder="Поиск по логам" placeholderTextColor={colors.muted} accessibilityLabel="Поиск по логам" style={styles.searchInput} autoCapitalize="none" /></View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.filters}>{filters.map((item) => <Pressable key={item.id} onPress={() => setFilter(item.id)} style={[styles.filter, filter === item.id && styles.filterActive]} accessibilityRole="tab" accessibilityState={{ selected: filter === item.id }}><Text style={[styles.filterText, filter === item.id && styles.filterTextActive]}>{item.label}</Text></Pressable>)}</ScrollView>
      {loading ? <View style={styles.empty}><ActivityIndicator size="small" color={colors.primary} /><Text style={styles.emptyText}>Загрузка логов…</Text></View> : visibleLogs.length === 0 ? <Text style={styles.emptyText}>{logs.length === 0 ? "Логов пока нет. Выполните действие в приложении." : "Поиск не дал результатов."}</Text> : <View style={styles.list} accessibilityRole="none">{visibleLogs.map((entry) => <Text key={entry.id} style={[styles.line, entry.level === "error" && styles.lineError, entry.level === "warn" && styles.lineWarn, entry.level === "success" && styles.lineSuccess]}>{formatLogLine(entry)}</Text>)}</View>}
    </ScrollView>
  </View>;
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  header: { minHeight: 70, paddingHorizontal: 16, borderBottomWidth: 1, borderBottomColor: colors.border, flexDirection: "row", alignItems: "center" },
  back: { zIndex: 2, width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center" },
  centeredHeaderTitle: { position: "absolute", left: 0, right: 0, alignItems: "center" },
  headerTitle: { color: colors.foreground, fontFamily: fonts.headingBold, fontSize: 19 },
  clearButton: { marginLeft: "auto", minHeight: 38, paddingHorizontal: 8, flexDirection: "row", alignItems: "center", gap: 5 },
  clearText: { color: colors.muted, fontFamily: fonts.bodySemibold, fontSize: 12 },
  disabledText: { color: colors.border },
  content: { padding: 16, paddingBottom: 30, gap: 12 },
  meta: { color: colors.muted, fontFamily: fonts.body, fontSize: 11, lineHeight: 16 },
  search: { minHeight: 42, borderRadius: radii.md, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface, flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 12 },
  searchInput: { flex: 1, color: colors.foreground, fontFamily: fonts.body, fontSize: 13, paddingVertical: 0 },
  filters: { gap: 7, paddingVertical: 2 },
  filter: { borderRadius: radii.pill, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface, paddingHorizontal: 11, paddingVertical: 7 },
  filterActive: { borderColor: "#6e60bb", backgroundColor: "#302960" },
  filterText: { color: colors.muted, fontFamily: fonts.bodySemibold, fontSize: 11 },
  filterTextActive: { color: colors.foreground },
  list: { gap: 5 },
  line: { color: colors.foreground, fontFamily: fonts.body, fontSize: 12, lineHeight: 18 },
  lineError: { color: colors.danger },
  lineWarn: { color: "#f5b942" },
  lineSuccess: { color: colors.success },
  empty: { minHeight: 80, alignItems: "center", justifyContent: "center", gap: 8, padding: 20 },
  emptyText: { color: colors.muted, fontFamily: fonts.body, fontSize: 13, textAlign: "center" },
});
