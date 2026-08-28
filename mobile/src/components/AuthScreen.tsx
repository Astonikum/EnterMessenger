import { useRef, useState } from "react";
import { ActivityIndicator, Animated, Easing, Image, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { StatusBar } from "expo-status-bar";
import { SafeAreaView } from "react-native-safe-area-context";
import type { Profile } from "../types";
import { colors, fonts, radii } from "../theme";
import { Icon } from "./Icon";
import { getSuggestedServerAddress, normalizeServerAddress } from "../rn-address";
import { ENTER_PROTOCOL_VERSION } from "../protocol";

type Props = { onAuthenticated: (profile: Profile, password: string) => void | Promise<void>; onCancel?: () => void };
type Mode = "login" | "register";
const SERVER_CHECK_TIMEOUT_MS = 5000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isHealthResponse(value: unknown): value is { status: string; protocol: string; serverName?: string; logo?: string } {
  return isRecord(value)
    && value.status === "ok"
    && typeof value.protocol === "string"
    && (value.serverName === undefined || typeof value.serverName === "string")
    && (value.logo === undefined || typeof value.logo === "string");
}

function isAuthResponse(value: unknown): value is { token: string; profile: { id: string; name: string; handle: string; serverId: string }; error?: string } {
  if (!isRecord(value) || typeof value.token !== "string" || !value.token || !isRecord(value.profile)) return false;
  return typeof value.profile.id === "string"
    && typeof value.profile.name === "string"
    && typeof value.profile.handle === "string"
    && typeof value.profile.serverId === "string"
    && (value.error === undefined || typeof value.error === "string");
}

function Field({ label, value, onChangeText, placeholder, secureTextEntry, autoCapitalize = "none", autoFocus, keyboardType = "default", returnKeyType = "next", blurOnSubmit = true, onSubmitEditing, inputRef }: { label: string; value: string; onChangeText: (value: string) => void; placeholder: string; secureTextEntry?: boolean; autoCapitalize?: "none" | "words"; autoFocus?: boolean; keyboardType?: "default" | "url"; returnKeyType?: "next" | "done" | "go"; blurOnSubmit?: boolean; onSubmitEditing?: () => void; inputRef?: (instance: TextInput | null) => void }) {
  return <View style={styles.field}><Text style={styles.label}>{label}</Text><TextInput ref={inputRef} value={value} onChangeText={onChangeText} placeholder={placeholder} placeholderTextColor={colors.muted} secureTextEntry={secureTextEntry} autoCapitalize={autoCapitalize} autoFocus={autoFocus} keyboardType={keyboardType} returnKeyType={returnKeyType} blurOnSubmit={blurOnSubmit} onSubmitEditing={onSubmitEditing} style={styles.input} /></View>;
}

export function AuthScreen({ onAuthenticated, onCancel }: Props) {
  const [step, setStep] = useState<"server" | "auth">("server");
  const [mode, setMode] = useState<Mode>("login");
  const [serverInput, setServerInput] = useState(getSuggestedServerAddress);
  const [serverUrl, setServerUrl] = useState("");
  const [serverName, setServerName] = useState("Enter");
  const [serverLogo, setServerLogo] = useState<string>();
  const [name, setName] = useState("");
  const [handle, setHandle] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const handleInput = useRef<TextInput | null>(null);
  const passwordInput = useRef<TextInput | null>(null);
  const stepOffset = useRef(new Animated.Value(0)).current;
  const stepOpacity = useRef(new Animated.Value(1)).current;

  function transitionToStep(nextStep: "server" | "auth", direction: "forward" | "backward") {
    stepOffset.stopAnimation();
    stepOpacity.stopAnimation();
    stepOffset.setValue(direction === "forward" ? 24 : -24);
    stepOpacity.setValue(0.2);
    setStep(nextStep);
    Animated.parallel([
      Animated.timing(stepOffset, { toValue: 0, duration: 160, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
      Animated.timing(stepOpacity, { toValue: 1, duration: 160, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
    ]).start();
  }

  async function checkServer() {
    const url = normalizeServerAddress(serverInput);
    if (!url) { setError("Введите IP, домен или полный URL сервера"); return; }
    setBusy(true); setError("");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), SERVER_CHECK_TIMEOUT_MS);
    try {
      const response = await fetch(`${url}/health`, { signal: controller.signal });
      if (!response.ok) throw new Error("unavailable");
      const health: unknown = await response.json();
      if (!isHealthResponse(health)) throw new Error("unavailable");
      if (health.protocol !== ENTER_PROTOCOL_VERSION) throw new Error("unsupported_protocol");
      setServerUrl(url); setServerName(health.serverName || "Enter"); setServerLogo(health.logo ? new URL(health.logo, `${url}/`).toString() : undefined); transitionToStep("auth", "forward");
    } catch (reason) {
      setError(reason instanceof Error && reason.message === "unsupported_protocol"
        ? `Сервер использует другую версию Enter API (нужна ${ENTER_PROTOCOL_VERSION})`
        : reason instanceof Error && reason.name === "AbortError"
          ? "Сервер не отвечает в течение 5 секунд"
          : "Сервер недоступен или не поддерживает Enter API");
    } finally { clearTimeout(timeout); setBusy(false); }
  }

  async function submitAuth() {
    if (!handle.trim() || password.length < 8 || (mode === "register" && !name.trim())) {
      setError(mode === "register" ? "Заполните имя, логин и пароль от 8 символов" : "Введите логин и пароль от 8 символов"); return;
    }
    setBusy(true); setError("");
    try {
      const response = await fetch(`${serverUrl}/auth/${mode}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: mode === "register" ? name.trim() : undefined, handle: handle.trim(), password }) });
      const data: unknown = await response.json();
      if (!response.ok || !isAuthResponse(data)) throw new Error(isRecord(data) && typeof data.error === "string" ? data.error : "Не удалось войти");
      await onAuthenticated({ id: data.profile.id, serverId: data.profile.serverId, name: data.profile.name, handle: data.profile.handle, server: serverUrl, color: colors.primary, token: data.token, serverName, serverLogo }, password);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Не удалось выполнить запрос"); }
    finally { setBusy(false); }
  }

  function goBack() {
    if (onCancel) { onCancel(); return; }
    transitionToStep("server", "backward");
    setError("");
  }

  return <SafeAreaView style={styles.safeArea} edges={["top", "bottom"]}><KeyboardAvoidingView style={styles.page} behavior={Platform.OS === "ios" ? "padding" : "height"} keyboardVerticalOffset={Platform.OS === "ios" ? 8 : 0}><StatusBar style="light" /><ScrollView bounces={false} contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag">
    {(onCancel || step === "auth") && <Pressable style={styles.back} onPress={goBack}><Icon name="arrowBack" size={20} color={colors.foreground} /><Text style={styles.backText}>Назад</Text></Pressable>}
    <View style={styles.brand}><Image source={require("../../assets/enter_logo.png")} style={styles.brandLogo} resizeMode="contain" accessibilityLabel="Enter" /></View>
    <Animated.View style={[styles.stepPage, { opacity: stepOpacity, transform: [{ translateX: stepOffset }] }]}>
    <StepIndicator step={step} />
    {step === "server" ? <View style={styles.form}>
      <Text style={styles.title}>Найдём ваш сервер</Text><Text style={styles.description}>Enter не использует встроенный сервер. Укажите адрес своего сервера — сначала проверим его доступность.</Text>
      <Field label="Адрес сервера" value={serverInput} onChangeText={setServerInput} placeholder="IP компьютера:50121" autoFocus keyboardType="url" returnKeyType="go" onSubmitEditing={() => void checkServer()} />
      {!!error && <ErrorMessage text={error} />}
      <PrimaryButton label="Проверить сервер" icon="checkCircle" busy={busy} onPress={checkServer} />
    </View> : <View style={styles.form}>
      <View style={styles.serverCard}><View style={styles.serverLogo}>{serverLogo ? <Image source={{ uri: serverLogo }} style={styles.serverImage} /> : <Icon name="globe" size={20} color={colors.primary} />}</View><View style={styles.serverCopy}><Text style={styles.serverName} numberOfLines={1}>{serverName}</Text><Text style={styles.serverUrl} numberOfLines={1}>{serverUrl.replace(/^https?:\/\//, "")}</Text></View><Icon name="checkCircle" size={20} color={colors.success} /></View>
      <View style={styles.tabs}><Tab active={mode === "login"} icon="login" label="Войти" onPress={() => { setMode("login"); setError(""); }} /><Tab active={mode === "register"} icon="plus" label="Регистрация" onPress={() => { setMode("register"); setError(""); }} /></View>
      {mode === "register" && <Field label="Имя" value={name} onChangeText={setName} placeholder="Алексей" autoCapitalize="words" autoFocus returnKeyType="next" blurOnSubmit={false} onSubmitEditing={() => handleInput.current?.focus()} />}
      <Field label="Логин" value={handle} onChangeText={setHandle} placeholder="@alex" autoFocus={mode === "login"} returnKeyType="next" blurOnSubmit={false} onSubmitEditing={() => passwordInput.current?.focus()} inputRef={(instance) => { handleInput.current = instance; }} />
      <Field label="Пароль" value={password} onChangeText={setPassword} placeholder="Минимум 8 символов" secureTextEntry returnKeyType="done" onSubmitEditing={() => void submitAuth()} inputRef={(instance) => { passwordInput.current = instance; }} />
      {!!error && <ErrorMessage text={error} />}
      <PrimaryButton label={mode === "login" ? "Войти" : "Зарегистрироваться"} icon={mode === "login" ? "login" : "plus"} busy={busy} onPress={submitAuth} />
    </View>}
    </Animated.View>
  </ScrollView></KeyboardAvoidingView></SafeAreaView>;
}

function StepIndicator({ step }: { step: "server" | "auth" }) {
  return <View style={styles.stepIndicator} accessibilityRole="progressbar" accessibilityLabel={step === "server" ? "Шаг 1 из 2" : "Шаг 2 из 2"}><View style={[styles.stepDot, step === "server" && styles.stepDotActive]} /><View style={[styles.stepDot, step === "auth" && styles.stepDotActive]} /></View>;
}

function Tab({ active, icon, label, onPress }: { active: boolean; icon: "login" | "plus"; label: string; onPress: () => void }) {
  return <Pressable onPress={onPress} style={[styles.tab, active && styles.tabActive]}><Icon name={icon} size={16} color={active ? colors.foreground : colors.muted} /><Text style={[styles.tabText, active && styles.tabTextActive]}>{label}</Text></Pressable>;
}

export function ErrorMessage({ text }: { text: string }) {
  return <View style={styles.error}><Icon name="error" size={18} color={colors.danger} /><Text style={styles.errorText}>{text}</Text></View>;
}

export function PrimaryButton({ label, icon, busy, onPress }: { label: string; icon: "checkCircle" | "login" | "plus"; busy?: boolean; onPress: () => void }) {
  return <Pressable disabled={busy} onPress={onPress} style={({ pressed }) => [styles.primary, pressed && styles.pressed, busy && styles.disabled]}>{busy ? <ActivityIndicator color={colors.primaryText} /> : <Icon name={icon} size={19} color={colors.primaryText} />}<Text style={styles.primaryText}>{label}</Text></Pressable>;
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: colors.background },
  page: { flex: 1, backgroundColor: colors.background },
  scroll: { flexGrow: 1, paddingHorizontal: 20, paddingTop: 54, paddingBottom: 32, justifyContent: "flex-start" },
  back: { position: "absolute", top: 20, left: 20, zIndex: 1, flexDirection: "row", alignItems: "center", gap: 6, padding: 8 },
  backText: { color: colors.foreground, fontFamily: fonts.body, fontSize: 14 },
  brand: { alignItems: "center", justifyContent: "center", marginBottom: 30 },
  brandLogo: { width: 154, height: 28 },
  stepPage: { width: "100%", maxWidth: 440, alignSelf: "center", gap: 16 },
  stepIndicator: { height: 6, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6 },
  stepDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: colors.border },
  stepDotActive: { width: 24, backgroundColor: colors.primary },
  form: { width: "100%", gap: 16 },
  title: { color: colors.foreground, fontFamily: fonts.headingBold, fontSize: 25, letterSpacing: -0.5 },
  description: { color: colors.muted, fontFamily: fonts.body, fontSize: 15, lineHeight: 22, marginTop: -6 },
  field: { gap: 8 },
  label: { color: colors.muted, fontFamily: fonts.bodySemibold, fontSize: 13 },
  input: { minHeight: 52, borderRadius: radii.md, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, color: colors.foreground, fontFamily: fonts.body, paddingHorizontal: 16, fontSize: 16 },
  primary: { minHeight: 54, borderRadius: radii.md, backgroundColor: colors.primary, alignItems: "center", justifyContent: "center", flexDirection: "row", gap: 9, marginTop: 4 },
  primaryText: { color: colors.primaryText, fontFamily: fonts.bodyBold, fontSize: 15 },
  pressed: { opacity: 0.82 },
  disabled: { opacity: 0.55 },
  error: { borderWidth: 1, borderColor: "#6b2f31", backgroundColor: "#321d20", borderRadius: radii.sm, padding: 12, flexDirection: "row", gap: 8, alignItems: "flex-start" },
  errorText: { flex: 1, color: "#ffb5b1", fontFamily: fonts.body, fontSize: 13, lineHeight: 18 },
  serverCard: { flexDirection: "row", alignItems: "center", gap: 12, backgroundColor: colors.surface, borderRadius: radii.lg, padding: 14 },
  serverLogo: { width: 42, height: 42, borderRadius: 12, backgroundColor: "#31285c", alignItems: "center", justifyContent: "center" },
  serverImage: { width: 42, height: 42, borderRadius: 12 },
  serverLogoText: { color: colors.primary, fontFamily: fonts.headingBold, fontSize: 18 },
  serverCopy: { flex: 1, flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 },
  serverName: { color: colors.foreground, fontFamily: fonts.bodySemibold, fontSize: 15 },
  serverUrl: { flexShrink: 1, color: colors.muted, fontFamily: fonts.body, fontSize: 12 },
  tabs: { backgroundColor: colors.surface, padding: 4, borderRadius: radii.sm, flexDirection: "row", gap: 4 },
  tab: { flex: 1, minHeight: 40, borderRadius: 8, alignItems: "center", justifyContent: "center", flexDirection: "row", gap: 6 },
  tabActive: { backgroundColor: colors.background },
  tabText: { color: colors.muted, fontFamily: fonts.bodySemibold, fontSize: 13 },
  tabTextActive: { color: colors.foreground },
});
