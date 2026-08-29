export type ApiResponse = {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
};

export function apiUrl(server: string, path: string) {
  return `${server.replace(/\/+$/, "")}${path}`;
}

export function authHeaders(token: string) {
  return { authorization: `Bearer ${token}`, "content-type": "application/json" };
}

export async function readJson<T>(response: ApiResponse, validate?: (value: unknown) => value is T): Promise<T> {
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { error?: unknown } | null;
    const detail = payload && typeof payload.error === "string" ? `: ${payload.error}` : "";
    throw new Error(`Enter API request failed: ${response.status}${detail}`);
  }
  const payload = await response.json().catch(() => undefined);
  if (validate && !validate(payload)) throw new Error("Enter API вернул некорректный ответ");
  return payload as T;
}
