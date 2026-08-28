export type EnterAddress = { handle: string; server: string };

export function parseEnterAddress(raw: string, fallbackServer?: string): EnterAddress | null {
  const value = raw.trim().replace(/^@/, "");
  if (!value) return null;
  const separator = value.lastIndexOf("@");
  if (separator < 0) {
    const server = normalizeServerAddress(fallbackServer ?? "");
    return /^[a-z0-9._-]{1,64}$/i.test(value) && server ? { handle: value.toLowerCase(), server } : null;
  }
  const handle = value.slice(0, separator).trim().toLowerCase();
  const server = normalizeServerAddress(value.slice(separator + 1));
  return /^[a-z0-9._-]{1,64}$/.test(handle) && Boolean(server) ? { handle, server: server! } : null;
}

export function formatEnterAddress(address: EnterAddress) {
  return `${address.handle}@${address.server.replace(/^https?:\/\//, "")}`;
}

export function getSuggestedServerAddress(hostname = runtimeHostname()) {
  const host = hostname.trim();
  return host && host !== "0.0.0.0" ? `${host}:50121` : "";
}

export function normalizeServerAddress(raw: string) {
  const value = raw.trim();
  if (!value) return null;
  const hasScheme = /^[a-z][a-z\d+.-]*:\/\//i.test(value);
  const candidate = hasScheme ? value : `http://${value}`;
  try {
    const url = new URL(candidate);
    if (isLocalHost(url.hostname) && !url.port) url.port = "50121";
    if (!["http:", "https:"].includes(url.protocol) || !url.hostname) return null;
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch { return null; }
}

export function migrateLocalServerAddress(raw: string) {
  try {
    const url = new URL(raw);
    if (isLocalHost(url.hostname) && ["8080", "8081"].includes(url.port)) {
      url.port = "50121";
      return url.toString().replace(/\/$/, "");
    }
  } catch {
    // Keep malformed or remote profile addresses unchanged.
  }
  return raw;
}

function isLocalHost(hostname: string) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (["localhost", "::1", "0.0.0.0"].includes(host)) return true;
  const octets = host.split(".").map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  return octets[0] === 10 || octets[0] === 127 || octets[0] === 169 && octets[1] === 254 || octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31 || octets[0] === 192 && octets[1] === 168;
}

function runtimeHostname() {
  if (typeof globalThis === "undefined") return "";
  const location = (globalThis as typeof globalThis & { location?: { hostname?: unknown } }).location;
  return typeof location?.hostname === "string" ? location.hostname : "";
}
