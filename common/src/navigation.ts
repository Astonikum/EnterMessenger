export type NavigationScreen = "inbox" | "chat" | "profile" | "settings" | "logs";

export type BackAction = () => boolean | void;

export type BackActionRegistry = {
  register: (action: BackAction) => () => void;
  handle: () => boolean;
};

export function createBackActionRegistry(): BackActionRegistry {
  const actions: BackAction[] = [];
  return {
    register(action) {
      actions.push(action);
      let registered = true;
      return () => {
        if (!registered) return;
        registered = false;
        const index = actions.lastIndexOf(action);
        if (index >= 0) actions.splice(index, 1);
      };
    },
    handle() {
      for (let index = actions.length - 1; index >= 0; index -= 1) {
        if (actions[index]?.()) return true;
      }
      return false;
    },
  };
}
