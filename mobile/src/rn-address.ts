import { formatEnterAddress, parseEnterAddress as parseCommonEnterAddress, type EnterAddress } from "../../common/src/address.ts";
import { getServerHostname, migrateLocalServerAddress, normalizeServerAddress, resolveServerResource } from "../../common/src/server-address.ts";

export type { EnterAddress } from "../../common/src/address.ts";

export function parseEnterAddress(raw: string, fallbackServer?: string): EnterAddress | null {
  return parseCommonEnterAddress(raw, fallbackServer, normalizeServerAddress);
}

export { formatEnterAddress };

export function getSuggestedServerAddress(hostname = runtimeHostname()) {
  const host = hostname.trim();
  return host && host !== "0.0.0.0" ? `${host}:50121` : "";
}

export { getServerHostname, migrateLocalServerAddress, normalizeServerAddress, resolveServerResource };

function runtimeHostname() {
  if (typeof globalThis === "undefined") return "";
  const location = (globalThis as typeof globalThis & { location?: { hostname?: unknown } }).location;
  return typeof location?.hostname === "string" ? location.hostname : "";
}
