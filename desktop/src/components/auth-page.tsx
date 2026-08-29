import { useState, type FormEvent } from "react";
import type { Profile } from "../types";
import { normalizeServerAddress, resolveServerResource } from "../lib/server-address";
import { ENTER_PROTOCOL_VERSION } from "../lib/enter-protocol";
import { clientDeviceMetadata } from "../lib/enter-api";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Icon } from "./ui/icon";
import { LogsPanel } from "./logs-panel";
import { logEvent } from "../lib/logs";
import { friendlyError } from "../lib/client-errors";
import { isAuthDraftValid, isAuthHealthResponse, isAuthResponse, type AuthMode } from "../../../common/src/auth.ts";

type AuthPageProps = {
  onAuthenticated: (profile: Profile, password: string) => void | Promise<void>;
  onCancel?: () => void;
};

type StepDirection = "forward" | "backward";
const SERVER_CHECK_TIMEOUT_MS = 5000;

// #preview AuthPage {}
export function AuthPage({ onAuthenticated = () => undefined, onCancel }: AuthPageProps) {
  const [step, setStep] = useState<"server" | "auth">("server");
  const [stepDirection, setStepDirection] = useState<StepDirection>();
  const [mode, setMode] = useState<AuthMode>("login");
  const [serverInput, setServerInput] = useState("");
  const [serverUrl, setServerUrl] = useState("");
  const [serverName, setServerName] = useState("Enter");
  const [serverLogo, setServerLogo] = useState<string | undefined>();
  const [name, setName] = useState("");
  const [handle, setHandle] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [showLogs, setShowLogs] = useState(false);

  async function checkServer(event: FormEvent) {
    event.preventDefault();
    const url = normalizeServerAddress(serverInput);
    if (!url) {
      logEvent("auth", "Server address rejected", serverInput, "error");
      setError("Введите localhost, IP, домен или полный URL сервера");
      return;
    }
    setBusy(true);
    setError("");
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), SERVER_CHECK_TIMEOUT_MS);
    try {
      const response = await fetch(`${url}/health`, { signal: controller.signal });
      if (!response.ok) throw new Error("unavailable");
      const health: unknown = await response.json();
      if (!isAuthHealthResponse(health)) throw new Error("unavailable");
      if (health.protocol !== ENTER_PROTOCOL_VERSION) throw new Error("unsupported_protocol");
      setServerUrl(url);
      setServerName(health.serverName || "Enter");
      setServerLogo(health.logo ? resolveServerResource(url, health.logo) : undefined);
      logEvent("auth", "Server is available", url, "success");
      setStepDirection("forward");
      setStep("auth");
    } catch (reason) {
      logEvent("auth", "Server check failed", reason instanceof Error ? reason.message : "Server unavailable", "error");
      setError(reason instanceof Error && reason.message === "unsupported_protocol"
        ? `Сервер использует другую версию Enter API (нужна ${ENTER_PROTOCOL_VERSION})`
        : reason instanceof Error && reason.name === "AbortError"
          ? "Сервер не отвечает в течение 5 секунд"
          : "Сервер недоступен или не поддерживает Enter API");
    } finally {
      window.clearTimeout(timeout);
      setBusy(false);
    }
  }

  async function submitAuth(event: FormEvent) {
    event.preventDefault();
    if (!isAuthDraftValid({ mode, name, handle, password })) {
      setError(mode === "register" ? "Заполните имя, логин и пароль от 8 символов" : "Введите логин и пароль от 8 символов");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`${serverUrl}/auth/${mode}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: mode === "register" ? name : undefined, handle, password, ...clientDeviceMetadata() }),
      });
      const data: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        const serverError = data && typeof data === "object" && "error" in data && typeof data.error === "string" ? data.error : "auth_failed";
        throw new Error(serverError);
      }
      if (!isAuthResponse(data)) throw new Error("auth_failed");
      logEvent("auth", mode === "login" ? "Signed in" : "Account registered", serverUrl, "success");
      await onAuthenticated({
        id: data.profile.id,
        serverId: data.profile.serverId,
        name: data.profile.name,
        handle: data.profile.handle,
        server: serverUrl,
        color: "#a98bff",
        token: data.token,
        serverName,
        serverLogo,
      }, password);
    } catch (reason) {
      logEvent("auth", mode === "login" ? "Sign-in failed" : "Registration failed", reason instanceof Error ? reason.message : "Authorization request failed", "error");
      setError(friendlyError(reason, mode === "login" ? "Не удалось войти. Проверьте данные и попробуйте снова." : "Не удалось зарегистрироваться. Проверьте данные и попробуйте снова."));
    } finally {
      setBusy(false);
    }
  }

  function goBack() {
    if (onCancel) {
      onCancel();
      return;
    }
    setStepDirection("backward");
    setStep("server");
    setError("");
  }

  if (showLogs) return <main className="auth-page relative flex min-h-[100dvh] w-full min-w-0 items-center justify-center overflow-y-auto bg-background px-6 py-10 text-foreground"><div className="h-[min(80dvh,52rem)] w-full max-w-[56rem]"><LogsPanel onClose={() => setShowLogs(false)} /></div></main>;

  return (
    <main className="auth-page relative flex min-h-[100dvh] w-full min-w-0 items-center justify-center overflow-y-auto bg-background px-6 py-10 pb-16 text-foreground">
      {(onCancel || step === "auth") && <Button type="button" variant="ghost" size="sm" className="absolute left-6 top-6" onClick={goBack}><Icon name="arrow_back" className="size-4" />Назад</Button>}
      <div className="w-full max-w-[26.25rem]">
        <div className="mb-10 flex justify-center"><img src="/enter_logo.png" alt="Enter" className="h-8 w-32 object-contain brightness-0 invert" /></div>
        <div className={`auth-step ${stepDirection ? `auth-step-${stepDirection}` : ""} space-y-6`}>
          <StepIndicator step={step} />
          {step === "server" ? (
            <form onSubmit={checkServer} className="space-y-6">
              <div><h1 className="text-2xl font-semibold tracking-tight">Найдём ваш сервер</h1><p className="mt-2 text-sm leading-relaxed text-muted-foreground">Enter не использует встроенный сервер. Укажите адрес своего сервера — сначала проверим его доступность.</p></div>
              <label className="field-label">Адрес сервера<div className="relative"><Icon name="language" className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" /><Input value={serverInput} onChange={(event) => setServerInput(event.target.value)} className="h-12 pl-10" placeholder="Адрес сервера" autoFocus /></div></label>
              {error && <ErrorMessage text={error} />}
              <Button type="submit" className="h-12 w-full" disabled={busy}>{busy ? <Icon name="progress_activity" className="size-4 animate-spin" /> : <Icon name="check_circle" className="size-4" />}Проверить сервер</Button>
            </form>
          ) : (
            <form onSubmit={submitAuth} className="space-y-6">
              <div className="flex items-center justify-between gap-3 rounded-2xl bg-surface/70 p-3"><div className="flex min-w-0 items-center gap-3">{serverLogo ? <img src={serverLogo} alt="" className="size-9 rounded-xl object-cover" /> : <div className="grid size-9 place-items-center rounded-xl bg-primary/15 text-sm font-semibold text-primary">{serverName.slice(0, 1)}</div>}<span className="min-w-0 truncate text-sm font-medium">{serverName}</span></div><span className="flex shrink-0 items-center gap-1.5 text-xs text-primary"><span className="max-w-[11.25rem] truncate">{serverUrl.replace(/^https?:\/\//, "")}</span><Icon name="check_circle" className="size-3.5" /></span></div>
              <div className="grid grid-cols-2 gap-1 rounded-xl bg-muted p-1"><button type="button" onClick={() => { setMode("login"); setError(""); }} className={mode === "login" ? "auth-tab auth-tab-active" : "auth-tab"}><Icon name="login" className="size-3.5" />Войти</button><button type="button" onClick={() => { setMode("register"); setError(""); }} className={mode === "register" ? "auth-tab auth-tab-active" : "auth-tab"}><Icon name="person_add" className="size-3.5" />Регистрация</button></div>
              {mode === "register" && <label className="field-label">Имя<Input value={name} onChange={(event) => setName(event.target.value)} placeholder="Алексей" autoFocus /></label>}
              <label className="field-label">Логин<Input value={handle} onChange={(event) => setHandle(event.target.value)} placeholder="@alex" autoFocus={mode === "login"} /></label>
              <label className="field-label">Пароль<Input value={password} onChange={(event) => setPassword(event.target.value)} type="password" minLength={8} placeholder="Минимум 8 символов" /></label>
              {error && <ErrorMessage text={error} />}
              <Button type="submit" className="h-12 w-full" disabled={busy}>{busy ? <Icon name="progress_activity" className="size-4 animate-spin" /> : mode === "login" ? <Icon name="login" className="size-4" /> : <Icon name="person_add" className="size-4" />}{mode === "login" ? "Войти" : "Зарегистрироваться"}</Button>
            </form>
          )}
        </div>
      </div>
      <button type="button" className="auth-logs-link" onClick={() => setShowLogs(true)}><Icon name="logs" className="size-3.5" />Логи диагностики</button>
    </main>
  );
}

function StepIndicator({ step }: { step: "server" | "auth" }) {
  return <div className="flex items-center justify-center gap-1.5" role="status" aria-label={step === "server" ? "Шаг 1 из 2" : "Шаг 2 из 2"}><span className={`auth-step-dot ${step === "server" ? "auth-step-dot-active" : ""}`} /><span className={`auth-step-dot ${step === "auth" ? "auth-step-dot-active" : ""}`} /></div>;
}

// #preview ErrorMessage {"text":"Server is unavailable"}
export function ErrorMessage({ text }: { text: string }) {
  return <p role="alert" className="flex items-start gap-2 rounded-xl border border-destructive/30 bg-destructive/10 p-3 text-xs leading-relaxed text-red-200"><Icon name="error" className="mt-0.5 size-4 shrink-0" />{text}</p>;
}
