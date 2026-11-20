import type { FieldErrors } from 'react-hook-form';
import type { CustomFieldEntity } from '@taskora/shared';
import { useLookups, type CustomFieldDef } from '@/lib/lookups';
import { fmtDate } from '@/lib/utils';
import { Checkbox, Input, Select, Textarea } from './ui/input';
import { Field } from './ui/misc';
import { FormField, FormGrid, FormSection } from './form';

/** Whether a field belongs to 	ab (undefined: any tab; null: fields shown outside tabs). */
export function inTab(d: CustomFieldDef, tab: string | null | undefined) {
  if (tab === undefined) return true;
  return (d.tab?.trim() || null) === tab;
}

/** Distinct tab names of the active custom fields of an entity, in field order. */
export function customFieldTabs(defs: CustomFieldDef[] | undefined, entity: CustomFieldEntity): string[] {
  const tabs: string[] = [];
  for (const d of defs ?? []) {
    const t = d.tab?.trim();
    if (d.entity === entity && d.isActive && t && !tabs.includes(t)) tabs.push(t);
  }
  return tabs;
}

/** Renders inputs for the active custom fields of an entity. */
export function CustomFieldsEditor({
  entity,
  value,
  onChange,
  errors,
  tab,
  title = 'Custom fields',
}: {
  entity: CustomFieldEntity;
  value: Record<string, unknown> | undefined;
  onChange: (v: Record<string, unknown>) => void;
  errors?: FieldErrors;
  /** Only the fields of this tab (null: fields without a tab); all fields when omitted. */
  tab?: string | null;
  title?: string;
}) {
  const lookups = useLookups();
  const defs = (lookups.data?.customFields ?? []).filter((d) => d.entity === entity && d.isActive && inTab(d, tab));
  if (!defs.length) return null;
  const v = value ?? {};
  const set = (key: string, val: unknown) => onChange({ ...v, [key]: val });
  const errorOf = (key: string) => (errors?.[`customFields.${key}`] as { message?: string } | undefined)?.message;
  return (
    <FormSection title={title}>
      <FormGrid cols={2}>
        {defs.map((d) => {
          const current = v[d.key];
          const common = { 'aria-invalid': !!errorOf(d.key) };
          let control;
          switch (d.type) {
            case 'textarea':
              control = <Textarea rows={2} value={String(current ?? '')} onChange={(e) => set(d.key, e.target.value)} {...common} />;
              break;
            case 'number':
              control = <Input type="number" step="any" value={current === null || current === undefined ? '' : String(current)} onChange={(e) => set(d.key, e.target.value)} {...common} />;
              break;
            case 'date':
              control = <Input type="date" value={String(current ?? '')} onChange={(e) => set(d.key, e.target.value)} {...common} />;
              break;
            case 'boolean':
              control = <Checkbox checked={current === true} onChange={(e) => set(d.key, e.target.checked)} label="Yes" className="h-8" />;
              break;
            case 'select':
              control = <Select value={String(current ?? '')} onChange={(e) => set(d.key, e.target.value)} placeholder="—" options={d.options.map((o) => ({ value: o, label: o }))} {...common} />;
              break;
            default:
              control = <Input type={d.type === 'url' ? 'url' : 'text'} value={String(current ?? '')} onChange={(e) => set(d.key, e.target.value)} {...common} />;
          }
          return (
            <FormField key={d.key} label={d.label} required={d.isRequired} hint={d.helpText ?? undefined} error={errorOf(d.key)}>
              {control}
            </FormField>
          );
        })}
      </FormGrid>
    </FormSection>
  );
}

/** Read-only display of custom field values. */
export function CustomFieldsView({ entity, value, tab }: { entity: CustomFieldEntity; value: Record<string, unknown> | undefined; tab?: string | null }) {
  const lookups = useLookups();
  const defs = (lookups.data?.customFields ?? []).filter((d) => d.entity === entity && d.isActive && inTab(d, tab));
  if (!defs.length) return null;
  return (
    <>
      {defs.map((d) => {
        const raw = value?.[d.key];
        const shown =
          raw === null || raw === undefined || raw === ''
            ? null
            : d.type === 'boolean'
              ? raw
                ? 'Yes'
                : 'No'
              : d.type === 'date'
                ? fmtDate(String(raw))
                : d.type === 'url'
                  ? (
                      <a href={String(raw)} target="_blank" rel="noreferrer noopener" className="text-primary hover:underline">
                        {String(raw)}
                      </a>
                    )
                  : String(raw);
        return (
          <Field key={d.key} label={d.label}>
            {shown}
          </Field>
        );
      })}
    </>
  );
}
