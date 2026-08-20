import * as ContextMenuPrimitive from "@radix-ui/react-context-menu";
import { useState, type ReactNode } from "react";
import { cn } from "../../lib/utils";
import { Icon } from "./icon";

export type ContextMenuItem = {
  label: string;
  onSelect: () => void | Promise<void>;
  disabled?: boolean;
  destructive?: boolean;
  icon?: ReactNode;
  chevron?: boolean;
};

type ContextMenuProps = {
  items: ContextMenuItem[];
  children: ReactNode;
  className?: string;
  header?: (close: () => void) => ReactNode;
  footer?: ReactNode;
};

// #preview ContextMenu {"items":[]}
export function ContextMenu({ items, children, className, header, footer }: ContextMenuProps) {
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);

  return (
    <ContextMenuPrimitive.Root open={open} onOpenChange={setOpen}>
      <ContextMenuPrimitive.Trigger asChild className={className}>
        {children}
      </ContextMenuPrimitive.Trigger>
      <ContextMenuPrimitive.Portal>
        <ContextMenuPrimitive.Content className="context-menu z-[1000] min-w-64 rounded-xl border border-border bg-surface p-1.5 text-foreground shadow-2xl shadow-black/40 outline-none">
          {header?.(close)}
          {items.map((item) => (
            <ContextMenuPrimitive.Item
              key={item.label}
              disabled={item.disabled}
              className={cn(
                "relative flex h-9 w-full select-none items-center gap-3 rounded-lg px-3 text-left text-sm outline-none transition-colors data-[disabled]:pointer-events-none data-[disabled]:opacity-40 focus:bg-accent",
                item.destructive && "text-destructive focus:bg-destructive/10",
              )}
              onSelect={() => void item.onSelect()}
            >
              <span className={cn("grid size-4 shrink-0 place-items-center text-muted-foreground", item.destructive && "text-destructive")}>{item.icon}</span>
              <span className="min-w-0 flex-1 truncate">{item.label}</span>
              {item.chevron && <Icon name="chevron_right" className="size-4 text-muted-foreground" />}
            </ContextMenuPrimitive.Item>
          ))}
          {footer}
        </ContextMenuPrimitive.Content>
      </ContextMenuPrimitive.Portal>
    </ContextMenuPrimitive.Root>
  );
}
