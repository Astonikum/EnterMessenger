export function normalizeServerAddress(raw: string) {
  const input = raw.trim();
  if (!input) return null;

  const hasScheme = /^[a-z][a-z\d+.-]*:\/\//i.test(input);
  try {
    const url = new URL(hasScheme ? input : `http://${input}`);
    if (isLocalHost(url.hostname) && !url.port) url.port = "50121";
    if (!["http:", "https:"].includes(url.protocol) || !url.hostname) return null;
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
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

export function resolveServerResource(server: string, resource: string) {
  const value = resource.trim();
  if (!value) return undefined;
  try {
    const url = new URL(value, `${server.replace(/\/+$/, "")}/`);
    if (!["http:", "https:"].includes(url.protocol)) return undefined;
    url.hash = "";
    return url.toString();
  } catch {
    return undefined;
  }
}

function isLocalHost(hostname: string) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host === "::1" || host === "0.0.0.0") return true;
  const octets = host.split(".").map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  return octets[0] === 10 || octets[0] === 127 || octets[0] === 169 && octets[1] === 254 || octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31 || octets[0] === 192 && octets[1] === 168;
}
