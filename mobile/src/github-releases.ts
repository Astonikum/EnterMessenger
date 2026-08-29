import appJson from "../app.json";

export const CURRENT_VERSION = appJson.version;
export const GITHUB_REPO_URL = "https://github.com/Astonikum/EnterMessenger";

const RELEASES_API_URL = "https://api.github.com/repos/Astonikum/EnterMessenger/releases?per_page=100";

export type PlatformRelease = {
  tagName: string;
  version: string;
  name: string;
  body: string;
  htmlUrl: string;
  publishedAt: string | null;
  assets: Array<{ name: string; browserDownloadUrl: string; size: number }>;
};

function compareVersions(left: string, right: string) {
  const leftParts = left.split(/[.+-]/).slice(0, 3).map(Number);
  const rightParts = right.split(/[.+-]/).slice(0, 3).map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = (leftParts[index] || 0) - (rightParts[index] || 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function versionFromTag(tagName: string, platform: "desktop" | "mobile") {
  const prefix = `${platform}-v`;
  if (!tagName.startsWith(prefix)) return null;
  const version = tagName.slice(prefix.length);
  return /^\d+(?:\.\d+){0,2}(?:-[0-9A-Za-z.-]+)?$/.test(version) ? version : null;
}

export function isNewerVersion(version: string, currentVersion = CURRENT_VERSION) {
  return compareVersions(version, currentVersion) > 0;
}

export async function fetchLatestRelease(platform: "desktop" | "mobile", signal?: AbortSignal): Promise<PlatformRelease | null> {
  const response = await fetch(RELEASES_API_URL, {
    headers: { Accept: "application/vnd.github+json" },
    signal,
  });
  if (!response.ok) {
    if (response.status === 403) throw new Error("GitHub временно ограничил проверку обновлений");
    throw new Error(`GitHub вернул ошибку ${response.status}`);
  }

  const releases = await response.json() as Array<Record<string, unknown>>;
  return releases
    .filter((release) => release.draft !== true && release.prerelease !== true)
    .map((release) => {
      const tagName = typeof release.tag_name === "string" ? release.tag_name : "";
      const version = versionFromTag(tagName, platform);
      if (!version || typeof release.name !== "string" || typeof release.html_url !== "string") return null;
      const assets = Array.isArray(release.assets)
        ? release.assets.flatMap((asset) => {
          if (!asset || typeof asset !== "object") return [];
          const value = asset as Record<string, unknown>;
          return typeof value.name === "string" && typeof value.browser_download_url === "string"
            ? [{ name: value.name, browserDownloadUrl: value.browser_download_url, size: typeof value.size === "number" ? value.size : 0 }]
            : [];
        })
        : [];
      return {
        tagName,
        version,
        name: release.name,
        body: typeof release.body === "string" ? release.body : "",
        htmlUrl: release.html_url,
        publishedAt: typeof release.published_at === "string" ? release.published_at : null,
        assets,
      } satisfies PlatformRelease;
    })
    .filter((release): release is PlatformRelease => Boolean(release))
    .sort((left, right) => {
      const versionDifference = compareVersions(right.version, left.version);
      if (versionDifference !== 0) return versionDifference;
      return (right.publishedAt ?? "").localeCompare(left.publishedAt ?? "");
    })[0] ?? null;
}
