import { forwardRef, type InputHTMLAttributes, type LabelHTMLAttributes, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import { translate, translateNode } from '@/lib/i18n';

const field =
  'w-full rounded-md border border-border-strong bg-surface px-2.5 text-[13px] text-foreground placeholder:text-subtle shadow-xs transition-colors focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20 disabled:cursor-not-allowed disabled:opacity-60 aria-[invalid=true]:border-danger';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(({ className, placeholder, ...props }, ref) => (
  <input ref={ref} className={cn(field, 'h-8', className)} placeholder={placeholder && translate(placeholder)} {...props} />
));
Input.displayName = 'Input';

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(({ className, rows = 4, placeholder, ...props }, ref) => (
  <textarea ref={ref} rows={rows} className={cn(field, 'py-1.5 leading-relaxed resize-y min-h-16', className)} placeholder={placeholder && translate(placeholder)} {...props} />
));
Textarea.displayName = 'Textarea';

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  placeholder?: string;
  options?: { value: string | number; label: string; disabled?: boolean }[];
}

/** Native select (fast, accessible, keyboard friendly) styled like the other inputs. */
export const Select = forwardRef<HTMLSelectElement, SelectProps>(({ className, placeholder, options, children, ...props }, ref) => (
  <div className="relative w-full">
    <select ref={ref} className={cn(field, 'h-8 appearance-none pr-7', className)} {...props}>
      {placeholder !== undefined && <option value="">{translate(placeholder)}</option>}
      {options?.map((o) => (
        <option key={o.value} value={o.value} disabled={o.disabled}>
          {o.label}
        </option>
      ))}
      {children}
    </select>
    <ChevronDown className="pointer-events-none absolute right-2 top-1/2 size-3.5 -translate-y-1/2 text-muted" />
  </div>
));
Select.displayName = 'Select';

export const Checkbox = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { label?: string }>(({ className, label, ...props }, ref) => (
  <label className={cn('inline-flex cursor-pointer items-center gap-2 text-[13px]', className)}>
    <input ref={ref} type="checkbox" className="size-3.5 cursor-pointer rounded border-border-strong accent-[var(--primary)]" {...props} />
    {label && <span>{translate(label)}</span>}
  </label>
));
Checkbox.displayName = 'Checkbox';

export function Label({ className, children, ...props }: LabelHTMLAttributes<HTMLLabelElement>) {
  return (
    <label className={cn('mb-1 block text-xs font-medium text-muted', className)} {...props}>
      {translateNode(children)}
    </label>
  );
}
