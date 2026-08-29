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
  const parsed = parseServerUrl(raw);
  return parsed ? formatServerUrl(parsed) : null;
}

export function migrateLocalServerAddress(raw: string) {
  const parsed = parseServerUrl(raw);
  if (parsed && isLocalHost(parsed.hostname) && ["8080", "8081"].includes(parsed.port)) {
    return formatServerUrl({ ...parsed, port: "50121" });
  }
  return raw;
}

export function getServerHostname(raw: string) {
  return parseServerUrl(raw)?.hostname ?? "";
}

export function resolveServerResource(server: string, resource: string) {
  const value = resource.trim();
  if (!value) return undefined;
  if (/^https?:\/\//i.test(value)) return value.replace(/#.*$/, "");
  return `${server.replace(/\/+$/, "")}/${value.replace(/^\/+/, "")}`;
}

type ServerUrl = { protocol: "http:" | "https:"; hostname: string; port: string; pathname: string; search: string };

function parseServerUrl(raw: string): ServerUrl | null {
  const value = raw.trim();
  if (!value) return null;
  const candidate = /^[a-z][a-z\d+.-]*:\/\//i.test(value) ? value : `http://${value}`;
  const match = candidate.match(/^(https?):\/\/([^/?#]*)([^?#]*)(?:\?([^#]*))?(?:#.*)?$/i);
  if (!match) return null;

  const authority = match[2];
  if (!authority || /[\s\u0000-\u001f\u007f@]/.test(authority)) return null;
  let hostname = "";
  let port = "";

  if (authority.startsWith("[")) {
    const closingBracket = authority.indexOf("]");
    if (closingBracket < 0) return null;
    hostname = authority.slice(1, closingBracket);
    const suffix = authority.slice(closingBracket + 1);
    if (suffix && !/^:\d+$/.test(suffix)) return null;
    port = suffix.slice(1);
  } else {
    const firstColon = authority.indexOf(":");
    if (firstColon >= 0) {
      if (authority.indexOf(":", firstColon + 1) >= 0) return null;
      hostname = authority.slice(0, firstColon);
      port = authority.slice(firstColon + 1);
      if (!/^\d+$/.test(port)) return null;
    } else {
      hostname = authority;
    }
  }

  if (!hostname || !isValidHostname(hostname)) return null;
  if (port && (Number(port) < 1 || Number(port) > 65535)) return null;
  if (!port && isLocalHost(hostname)) port = "50121";
  return { protocol: `${match[1].toLowerCase()}:` as "http:" | "https:", hostname, port, pathname: match[3] || "", search: match[4] === undefined ? "" : `?${match[4]}` };
}

function formatServerUrl(url: ServerUrl) {
  const hostname = url.hostname.includes(":") ? `[${url.hostname}]` : url.hostname;
  const pathname = url.pathname.replace(/\/+$/, "");
  return `${url.protocol}//${hostname}${url.port ? `:${url.port}` : ""}${pathname}${url.search}`;
}

function isValidHostname(hostname: string) {
  return /^[a-z\d._-]+$/i.test(hostname) || /^[a-f\d:.%]+$/i.test(hostname);
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
