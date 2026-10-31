import type { ReactNode } from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import * as DropdownPrimitive from '@radix-ui/react-dropdown-menu';
import * as TabsPrimitive from '@radix-ui/react-tabs';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import * as PopoverPrimitive from '@radix-ui/react-popover';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from './button';

/* ------------------------------------------------------------------ dialog */

export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  size = 'md',
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg' | 'xl';
}) {
  const width = { sm: 'max-w-md', md: 'max-w-xl', lg: 'max-w-3xl', xl: 'max-w-5xl' }[size];
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-[1px] data-[state=open]:animate-in" />
        <DialogPrimitive.Content
          className={cn(
            'fixed left-1/2 top-[4dvh] z-50 flex max-h-[92dvh] sm:top-[8dvh] sm:max-h-[84dvh] w-[calc(100vw-2rem)] -translate-x-1/2 flex-col rounded-lg border border-border bg-surface shadow-2xl focus:outline-none',
            width,
          )}
          onOpenAutoFocus={(e) => {
            // Focus the first form field rather than the close button.
            const el = (e.currentTarget as HTMLElement).querySelector<HTMLElement>('input:not([type=hidden]),textarea,select');
            if (el) {
              e.preventDefault();
              el.focus();
            }
          }}
        >
          <div className="flex items-start justify-between gap-4 border-b border-border px-5 py-3">
            <div>
              <DialogPrimitive.Title className="text-[15px] font-semibold">{title}</DialogPrimitive.Title>
              {description ? (
                <DialogPrimitive.Description className="mt-0.5 text-xs text-muted">{description}</DialogPrimitive.Description>
              ) : (
                <DialogPrimitive.Description className="sr-only">{typeof title === 'string' ? title : 'Dialog'}</DialogPrimitive.Description>
              )}
            </div>
            <DialogPrimitive.Close asChild>
              <Button variant="ghost" size="icon-sm" aria-label="Close">
                <X />
              </Button>
            </DialogPrimitive.Close>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
          {footer && <div className="flex justify-end gap-2 border-t border-border bg-surface-2/50 px-5 py-3">{footer}</div>}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = 'Confirm',
  danger,
  loading,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  loading?: boolean;
  onConfirm: () => void;
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      size="sm"
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant={danger ? 'danger' : 'primary'} loading={loading} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="text-[13px] text-muted">{description}</div>
    </Dialog>
  );
}

/* ---------------------------------------------------------------- dropdown */

export const DropdownMenu = DropdownPrimitive.Root;
export const DropdownTrigger = DropdownPrimitive.Trigger;

export function DropdownContent({
  children,
  align = 'end',
  side,
  className,
}: {
  children: ReactNode;
  align?: 'start' | 'end' | 'center';
  side?: 'top' | 'right' | 'bottom' | 'left';
  className?: string;
}) {
  return (
    <DropdownPrimitive.Portal>
      <DropdownPrimitive.Content
        align={align}
        side={side}
        sideOffset={4}
        className={cn('z-50 min-w-44 rounded-md border border-border bg-surface p-1 text-[13px] shadow-lg', className)}
      >
        {children}
      </DropdownPrimitive.Content>
    </DropdownPrimitive.Portal>
  );
}

export function DropdownItem({ children, onSelect, danger, disabled }: { children: ReactNode; onSelect?: (e: Event) => void; danger?: boolean; disabled?: boolean }) {
  return (
    <DropdownPrimitive.Item
      disabled={disabled}
      onSelect={onSelect}
      className={cn(
        'flex cursor-pointer select-none items-center gap-2 rounded px-2 py-1.5 outline-none data-[disabled]:opacity-50 data-[highlighted]:bg-surface-2 [&_svg]:size-3.5 [&_svg]:text-muted',
        danger && 'text-danger [&_svg]:text-danger',
      )}
    >
      {children}
    </DropdownPrimitive.Item>
  );
}

export function DropdownLabel({ children }: { children: ReactNode }) {
  return <DropdownPrimitive.Label className="px-2 py-1 text-[11px] font-medium uppercase tracking-wide text-subtle">{children}</DropdownPrimitive.Label>;
}

export function DropdownSeparator() {
  return <DropdownPrimitive.Separator className="my-1 h-px bg-border" />;
}

/* -------------------------------------------------------------------- tabs */

export const Tabs = TabsPrimitive.Root;
export const TabsContent = TabsPrimitive.Content;

export function TabsList({ children, className }: { children: ReactNode; className?: string }) {
  return <TabsPrimitive.List className={cn('flex items-center gap-0.5 overflow-x-auto border-b border-border scrollbar-thin', className)}>{children}</TabsPrimitive.List>;
}

export function TabsTrigger({ value, children, count }: { value: string; children: ReactNode; count?: number | null }) {
  return (
    <TabsPrimitive.Trigger
      value={value}
      className="-mb-px inline-flex cursor-pointer items-center gap-1.5 whitespace-nowrap border-b-2 border-transparent px-3 py-2 text-[13px] font-medium text-muted transition-colors hover:text-foreground data-[state=active]:border-primary data-[state=active]:text-foreground"
    >
      {children}
      {count !== undefined && count !== null && <span className="rounded bg-surface-2 px-1.5 text-[11px] tabular-nums text-muted">{count}</span>}
    </TabsPrimitive.Trigger>
  );
}

/* ----------------------------------------------------------------- tooltip */

export function Tooltip({ content, children, side = 'top' }: { content: ReactNode; children: ReactNode; side?: 'top' | 'bottom' | 'left' | 'right' }) {
  return (
    <TooltipPrimitive.Root delayDuration={250}>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content side={side} sideOffset={4} className="z-[60] max-w-xs rounded bg-foreground px-2 py-1 text-[11px] text-background shadow">
          {content}
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}

export const TooltipProvider = TooltipPrimitive.Provider;

/* ----------------------------------------------------------------- popover */

export const Popover = PopoverPrimitive.Root;
export const PopoverTrigger = PopoverPrimitive.Trigger;
export const PopoverAnchor = PopoverPrimitive.Anchor;

export function PopoverContent({ children, className, align = 'start' }: { children: ReactNode; className?: string; align?: 'start' | 'end' | 'center' }) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        align={align}
        sideOffset={4}
        onOpenAutoFocus={(e) => e.preventDefault()}
        className={cn('z-50 rounded-md border border-border bg-surface p-1 shadow-lg', className)}
      >
        {children}
      </PopoverPrimitive.Content>
    </PopoverPrimitive.Portal>
  );
}
