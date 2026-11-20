import type { ReactNode } from 'react';
import { toast } from 'sonner';
import { ApiError } from '@/lib/api';
import { cn } from '@/lib/utils';
import { translate, translateNode } from '@/lib/i18n';
import { Label } from './ui/input';

/** Label + control + error message. */
export function FormField({
  label,
  error,
  required,
  hint,
  children,
  className,
}: {
  label: string;
  error?: string;
  required?: boolean;
  hint?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('min-w-0', className)}>
      <Label>
        {label}
        {required && <span className="ml-0.5 text-danger">*</span>}
      </Label>
      {children}
      {error ? <p className="mt-1 text-[11px] text-danger">{translate(error)}</p> : hint ? <p className="mt-1 text-[11px] text-muted">{translateNode(hint)}</p> : null}
    </div>
  );
}

export function FormGrid({ children, cols = 2, className }: { children: ReactNode; cols?: 1 | 2 | 3 | 4; className?: string }) {
  const c = { 1: 'grid-cols-1', 2: 'grid-cols-1 sm:grid-cols-2', 3: 'grid-cols-1 sm:grid-cols-3', 4: 'grid-cols-2 sm:grid-cols-4' }[cols];
  return <div className={cn('grid gap-3', c, className)}>{children}</div>;
}

export function FormSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <fieldset className="space-y-3">
      <legend className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-subtle">{translate(title)}</legend>
      {children}
    </fieldset>
  );
}

/**
 * Applies API validation errors to a react-hook-form instance and shows a
 * toast for anything that is not field-specific.
 */
export function handleFormError(err: unknown, setError?: (name: any, e: { message: string }) => void) {
  if (err instanceof ApiError) {
    const fields = Object.entries(err.fields);
    if (fields.length && setError) {
      for (const [name, message] of fields) setError(name, { message });
      toast.error(err.message === 'Validation failed' ? translate('Please correct the highlighted fields') : translate(err.message));
      return;
    }
    toast.error(translate(err.message));
    return;
  }
  toast.error(translate('Something went wrong'));
}

/** Converts empty strings to null and numeric strings for id fields. */
export function cleanForm<T extends Record<string, unknown>>(values: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(values)) out[k] = v === '' ? null : v;
  return out as T;
}
