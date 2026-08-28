const TAB_STATE_KEY = "enter-tab-state";

export type TabState = {
  activeProfileId?: string | null;
  activeConversationByProfile?: Record<string, string | null>;
  activeFolderByProfile?: Record<string, string>;
  showProfile?: boolean;
};

function storage() {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

export function readTabState(): TabState {
  try {
    const raw = storage()?.getItem(TAB_STATE_KEY);
    if (!raw) return {};
    const value = JSON.parse(raw) as TabState;
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}

export function writeTabState(value: TabState) {
  try {
    storage()?.setItem(TAB_STATE_KEY, JSON.stringify(value));
  } catch {
    // Navigation state is optional and must never block the application.
  }
}
