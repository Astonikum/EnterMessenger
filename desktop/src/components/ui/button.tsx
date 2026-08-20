import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cn } from "../../lib/utils";

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "default" | "ghost" | "outline" | "soft";
  size?: "default" | "sm" | "icon";
};

// #preview Button {"children":"Продолжить"}
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = "default", size = "default", ...props }, ref) => (
    <button
      ref={ref}
      className={cn(
        "inline-flex items-center justify-center gap-2 rounded-xl text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50",
        {
          "bg-primary text-primary-foreground hover:bg-primary/90": variant === "default",
          "hover:bg-accent hover:text-accent-foreground": variant === "ghost",
          "border border-border bg-transparent hover:bg-accent": variant === "outline",
          "bg-primary/10 text-primary hover:bg-primary/15": variant === "soft",
          "h-10 px-4": size === "default",
          "h-8 px-3 text-xs": size === "sm",
          "h-9 w-9": size === "icon",
        },
        className,
      )}
      {...props}
    />
  ),
);

Button.displayName = "Button";
