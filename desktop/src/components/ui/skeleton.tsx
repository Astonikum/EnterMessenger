import { cn } from "../../lib/utils";

// #preview Skeleton {"className":"h-4 w-32"}
export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden="true" className={cn("animate-pulse rounded-lg bg-muted/80", className)} />;
}
