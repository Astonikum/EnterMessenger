import appJson from "../app.json";
import { fetchLatestRelease as fetchCommonLatestRelease, GITHUB_REPO_URL, isNewerVersion as isCommonNewerVersion } from "../../common/src/releases.ts";

export const CURRENT_VERSION = appJson.version;
export { GITHUB_REPO_URL };
export type { PlatformRelease } from "../../common/src/releases.ts";

export function isNewerVersion(version: string, currentVersion = CURRENT_VERSION) {
  return isCommonNewerVersion(version, currentVersion);
}

export function fetchLatestRelease(platform: "desktop" | "mobile", signal?: AbortSignal) {
  return fetchCommonLatestRelease(platform, signal);
}
