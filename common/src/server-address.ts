export type ServerUrl = {
  protocol: "http:" | "https:";
  hostname: string;
  port: string;
  pathname: string;
  search: string;
};

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
  if (/^https?:\/\//i.test(value)) {
    const parsed = parseServerUrl(value);
    return parsed ? formatServerUrl(parsed) : undefined;
  }
  const path = value.split("#", 1)[0].replace(/^\/+/, "");
  return path ? `${server.replace(/\/+$/, "")}/${path}` : undefined;
}

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
