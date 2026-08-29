export type AuthMode = "login" | "register";

export type AuthDraft = {
  mode: AuthMode;
  name: string;
  handle: string;
  password: string;
};

export type AuthHealthResponse = {
  status: "ok";
  protocol: string;
  serverName?: string;
  logo?: string | null;
};

export type AuthProfile = {
  id: string;
  name: string;
  handle: string;
  serverId: string;
};

export type AuthResponse = {
  token: string;
  profile: AuthProfile;
  error?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function isAuthDraftValid(draft: AuthDraft) {
  return Boolean(draft.handle.trim())
    && draft.password.length >= 8
    && (draft.mode === "login" || Boolean(draft.name.trim()));
}

export function isAuthHealthResponse(value: unknown): value is AuthHealthResponse {
  return isRecord(value)
    && value.status === "ok"
    && typeof value.protocol === "string"
    && (value.serverName === undefined || typeof value.serverName === "string")
    && (value.logo === undefined || value.logo === null || typeof value.logo === "string");
}

export function isAuthResponse(value: unknown): value is AuthResponse {
  if (!isRecord(value) || typeof value.token !== "string" || !value.token || !isRecord(value.profile)) return false;
  return typeof value.profile.id === "string"
    && typeof value.profile.name === "string"
    && typeof value.profile.handle === "string"
    && typeof value.profile.serverId === "string"
    && (value.error === undefined || typeof value.error === "string");
}
