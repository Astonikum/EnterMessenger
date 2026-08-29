import { normalizeServerAddress } from "./server-address";
import { parseEnterAddress as parseCommonEnterAddress } from "../../../common/src/address.ts";

export { ENTER_PROTOCOL, ENTER_PROTOCOL_VERSION } from "../../../common/src/protocol.ts";
export type { EncryptedMessage } from "../../../common/src/protocol.ts";
export type { EnterAddress } from "../../../common/src/address.ts";
export { formatEnterAddress } from "../../../common/src/address.ts";

export function parseEnterAddress(raw: string, fallbackServer?: string) {
  return parseCommonEnterAddress(raw, fallbackServer, normalizeServerAddress);
}
