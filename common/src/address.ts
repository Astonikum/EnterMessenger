export type EnterAddress = {
  handle: string;
  server: string;
};

export function parseEnterAddress(raw: string, fallbackServer: string | undefined, normalizeServerAddress: (value: string) => string | null): EnterAddress | null {
  const value = raw.trim().replace(/^@/, "");
  if (!value) return null;

  const separator = value.lastIndexOf("@");
  if (separator === -1) {
    const server = normalizeServerAddress(fallbackServer ?? "");
    return /^[a-z0-9._-]{1,64}$/i.test(value) && server ? { handle: value.toLowerCase(), server } : null;
  }

  const handle = value.slice(0, separator).trim().toLowerCase();
  const server = normalizeServerAddress(value.slice(separator + 1));
  if (!/^[a-z0-9._-]{1,64}$/.test(handle) || !server) return null;
  return { handle, server };
}

export function formatEnterAddress(address: EnterAddress) {
  return `${address.handle}@${address.server.replace(/^https?:\/\//, "")}`;
}

export function formatProfileAddress(handle: string, server: string) {
  return formatEnterAddress({ handle: handle.replace(/^@+/, ""), server });
}
