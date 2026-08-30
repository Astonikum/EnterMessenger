export type PresenceLifecycleHooks = {
  onForeground: () => void;
  onBackground: () => void;
};

export function createPresenceLifecycle(initialForeground: boolean, hooks: PresenceLifecycleHooks) {
  let foreground = initialForeground;
  let stopped = false;

  return {
    start() {
      if (!stopped && foreground) hooks.onForeground();
    },
    setForeground(nextForeground: boolean) {
      if (stopped || nextForeground === foreground) return;
      foreground = nextForeground;
      if (foreground) hooks.onForeground();
      else hooks.onBackground();
    },
    stop() {
      if (stopped) return;
      stopped = true;
      hooks.onBackground();
    },
    isForeground() {
      return foreground && !stopped;
    },
  };
}
