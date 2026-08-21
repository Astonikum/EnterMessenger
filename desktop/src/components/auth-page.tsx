import { useState, type FormEvent } from "react";
import type { Profile } from "../types";
import { normalizeServerAddress } from "../lib/server-address";
import { ENTER_PROTOCOL_VERSION } from "../lib/enter-protocol";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Icon } from "./ui/icon";

type AuthPageProps = {
  onAuthenticated: (profile: Profile, password: string) => void | Promise<void>;
  onCancel?: () => void;
};

type AuthMode = "login" | "register";
type StepDirection = "forward" | "backward";
const SERVER_CHECK_TIMEOUT_MS = 5000;

type AuthResponse = {
  token: string;
  profile: { id: string; name: string; handle: string; serverId: string };
};

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

  async function checkServer(event: FormEvent) {
    event.preventDefault();
    const url = normalizeServerAddress(serverInput);
    if (!url) {
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
      const health = await response.json() as { status?: string; protocol?: string; serverName?: string; logo?: string };
      if (health.status !== "ok") throw new Error("unavailable");
      if (health.protocol !== ENTER_PROTOCOL_VERSION) throw new Error("unsupported_protocol");
      setServerUrl(url);
      setServerName(health.serverName || "Enter");
      setServerLogo(health.logo);
      setStepDirection("forward");
      setStep("auth");
    } catch (reason) {
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
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`${serverUrl}/auth/${mode}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: mode === "register" ? name : undefined, handle, password }),
      });
      const data = await response.json() as AuthResponse | { error?: string };
      if (!response.ok || !("token" in data)) throw new Error("Не удалось войти");
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
      setError(reason instanceof Error ? reason.message : "Не удалось выполнить запрос");
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

  return (
    <main className="auth-page relative flex min-h-[100dvh] w-full min-w-0 items-center justify-center overflow-y-auto bg-background px-6 py-10 text-foreground">
      {(onCancel || step === "auth") && <Button type="button" variant="ghost" size="sm" className="absolute left-6 top-6" onClick={goBack}><Icon name="arrow_back" className="size-4" />Назад</Button>}
      <div className="w-full max-w-[26.25rem]">
        <div className="mb-10 flex justify-center"><img src="/enter_logo.png" alt="Enter" className="h-8 w-32 object-contain brightness-0 invert" /></div>
        <div className={`auth-step ${stepDirection ? `auth-step-${stepDirection}` : ""} space-y-6`}>
          <StepIndicator step={step} />
          {step === "server" ? (
            <form onSubmit={checkServer} className="space-y-6">
              <div><h1 className="text-2xl font-semibold tracking-tight">Найдём ваш сервер</h1><p className="mt-2 text-sm leading-relaxed text-muted-foreground">Enter не использует встроенный сервер. Укажите адрес своего сервера — сначала проверим его доступность.</p></div>
              <label className="field-label">Адрес сервера<div className="relative"><Icon name="language" className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" /><Input value={serverInput} onChange={(event) => setServerInput(event.target.value)} className="h-12 pl-10" placeholder="localhost:50121" autoFocus /></div></label>
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
