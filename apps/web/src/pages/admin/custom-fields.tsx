import { useMemo } from 'react';
import { Tags } from 'lucide-react';
import { CUSTOM_FIELD_ENTITY, CUSTOM_FIELD_TYPE, type CustomFieldEntity } from '@taskora/shared';
import { useAuth } from '@/lib/auth';
import { useLookups, type CustomFieldDef } from '@/lib/lookups';
import type { Column } from '@/components/data-table';
import { PageBody, PageHeader } from '@/components/page';
import { Badge } from '@/components/ui/misc';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/overlays';
import { ActiveBadge } from '@/components/badges';
import { SettingsTable, YesNo, type SettingsField } from '@/components/admin/settings-table';
import { useTabParam } from '@/components/admin/tabs';

interface FieldRow extends CustomFieldDef {
  sortOrder: number;
  tab?: string | null;
}

const columns: Column<FieldRow>[] = [
  { header: 'Order', meta: { align: 'right', className: 'w-16' }, cell: ({ row }) => <span className="text-muted">{row.original.sortOrder}</span> },
  {
    header: 'Label',
    cell: ({ row }) => (
      <div className="min-w-0">
        <div className="font-medium">{row.original.label}</div>
        {row.original.helpText && <div className="truncate text-xs text-muted">{row.original.helpText}</div>}
      </div>
    ),
  },
  { header: 'Key', cell: ({ row }) => <code className="rounded bg-surface-2 px-1 py-0.5 font-mono text-[11px]">{row.original.key}</code> },
  {
    header: 'Type',
    cell: ({ row }) => (
      <span className="inline-flex items-center gap-1.5">
        <Badge>{CUSTOM_FIELD_TYPE.labels[row.original.type as keyof typeof CUSTOM_FIELD_TYPE.labels] ?? row.original.type}</Badge>
        {row.original.type === 'select' && <span className="text-xs text-muted">{row.original.options.length} options</span>}
      </span>
    ),
  },
  { header: 'Tab', cell: ({ row }) => (row.original.tab ? <Badge tone="primary">{row.original.tab}</Badge> : <span className="text-xs text-subtle">Details card</span>) },
  { header: 'Required', cell: ({ row }) => <YesNo value={row.original.isRequired} /> },
  { header: 'Status', meta: { className: 'w-24' }, cell: ({ row }) => <ActiveBadge active={row.original.isActive} /> },
];

const fields: SettingsField<FieldRow>[] = [
  { name: 'label', label: 'Label', type: 'text', required: true },
  {
    name: 'key',
    label: 'Key',
    type: 'text',
    required: true,
    mono: true,
    readOnlyOnEdit: true,
    placeholder: 'e.g. contract_reference',
    hint: 'Lowercase letters, digits and underscores; used to store the value',
    rules: { pattern: { value: /^[a-z][a-z0-9_]{1,40}$/, message: 'Start with a letter; lowercase letters, digits and underscores (2–41 chars)' } },
  },
  { name: 'type', label: 'Type', type: 'select', required: true, options: CUSTOM_FIELD_TYPE.values.map((v) => ({ value: v, label: CUSTOM_FIELD_TYPE.labels[v] })) },
  { name: 'sortOrder', label: 'Sort order', type: 'number', hint: 'Lower numbers are shown first' },
  {
    name: 'options',
    label: 'Picklist options',
    type: 'lines',
    placeholder: 'One option per line',
    hint: 'One option per line. Removing an option does not change values already stored on records.',
    visible: (v) => v.type === 'select',
    rules: { validate: (v, all) => all.type !== 'select' || String(v ?? '').trim().length > 0 || 'Add at least one option' },
  },
  { name: 'helpText', label: 'Help text', type: 'text', span: 2, placeholder: 'Shown below the field in forms' },
  {
    name: 'tab',
    label: 'Show in tab',
    type: 'text',
    placeholder: 'e.g. Onboarding, Hardware, Billing',
    hint: 'Optional. Fields with the same tab name get their own tab on the ticket (and record) page; leave empty to show them in the Custom fields card.',
  },
  { name: 'isRequired', label: 'Required', type: 'checkbox' },
  { name: 'isActive', label: 'Active', type: 'checkbox', hint: 'Inactive fields are hidden from forms; stored values are kept' },
];

export default function CustomFieldsPage() {
  const { can } = useAuth();
  const canWrite = can('settings.manage');
  const lookups = useLookups();
  const [tab, setTab] = useTabParam('ticket');
  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const f of lookups.data?.customFields ?? []) c[f.entity] = (c[f.entity] ?? 0) + 1;
    return c;
  }, [lookups.data]);

  return (
    <Tabs value={tab} onValueChange={setTab}>
      <PageHeader title="Custom Fields" subtitle="Additional fields shown on record forms and detail pages" icon={<Tags />}>
        <TabsList className="-mx-1 border-b-0">
          {CUSTOM_FIELD_ENTITY.values.map((e) => (
            <TabsTrigger key={e} value={e} count={lookups.data ? (counts[e] ?? 0) : undefined}>
              {CUSTOM_FIELD_ENTITY.labels[e]}
            </TabsTrigger>
          ))}
        </TabsList>
      </PageHeader>
      <PageBody>
        {CUSTOM_FIELD_ENTITY.values.map((e) => (
          <TabsContent key={e} value={e}>
            <EntityFields entity={e} canWrite={canWrite} />
          </TabsContent>
        ))}
      </PageBody>
    </Tabs>
  );
}

function EntityFields({ entity, canWrite }: { entity: CustomFieldEntity; canWrite: boolean }) {
  return (
    <SettingsTable<FieldRow>
      title={`${CUSTOM_FIELD_ENTITY.labels[entity]} fields`}
      description="Values are stored on each record. Deactivate a field to hide it from forms without deleting its definition."
      entityLabel="field"
      endpoint="/settings/custom-fields"
      params={{ entity }}
      columns={columns}
      fields={fields}
      defaults={{ label: '', key: '', type: 'text', options: [], isRequired: false, isActive: true, sortOrder: 0, helpText: '', tab: '' }}
      canWrite={canWrite}
      rowLabel={(r) => r.label}
      emptyText={`No custom fields for ${CUSTOM_FIELD_ENTITY.labels[entity].toLowerCase()} records yet.`}
      beforeSave={(p) => (p.type === 'select' ? p : { ...p, options: [] })}
    />
  );
}
