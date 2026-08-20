import { AuthPage } from "../components/auth-page";
import type { Profile } from "../types";

type AuthViewProps = {
  onAuthenticated?: (profile: Profile, password: string) => void | Promise<void>;
  onCancel?: () => void;
};

// #preview AuthView {}
export function AuthView({ onAuthenticated = () => undefined, onCancel }: AuthViewProps) {
  return <AuthPage onAuthenticated={onAuthenticated} onCancel={onCancel} />;
}
