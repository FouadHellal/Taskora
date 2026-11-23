import { Briefcase } from 'lucide-react';
import { BILLING_PERIOD, SERVICE_QUANTITY_SOURCE, formatMoney } from '@taskora/shared';
import { opts, useLookups } from '@/lib/lookups';
import { translate as t } from '@/lib/i18n';
import { useAuth } from '@/lib/auth';
import { PageHeader } from '@/components/page';
import { Badge } from '@/components/ui/misc';
import { SettingsTable } from '@/components/admin/settings-table';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = { id: number } & Record<string, any>;

export default function ServicesPage() {
  const { can } = useAuth();
  const lookups = useLookups();
  return (
    <div>
      <PageHeader title="Services" icon={<Briefcase />} subtitle="Catalogue of recurring services sold on contracts. Price per device (laptop, desktop, server…) or per user, and Taskora counts the quantity for you." />
      <div className="p-5">
        <SettingsTable<Row>
          title="Service catalogue"
          entityLabel="service"
          endpoint="/services"
          canWrite={can('contracts.write')}
          defaults={{ name: '', description: '', unitPrice: 0, unitCost: '', period: 'monthly', quantitySource: 'manual', ciTypeId: '', isActive: true }}
          columns={[
            { header: 'Service', cell: ({ row }) => <div><div className="font-medium">{row.original.name}</div>{row.original.description && <div className="text-[11px] text-muted">{row.original.description}</div>}</div> },
            { header: 'Period', cell: ({ row }) => <Badge>{BILLING_PERIOD.labels[row.original.period as keyof typeof BILLING_PERIOD.labels]}</Badge> },
            {
              header: 'Priced',
              cell: ({ row }) =>
                row.original.quantitySource === 'devices'
                  ? `${t('Per device')}${row.original.ciTypeId ? ` · ${lookups.data?.ciTypes.find((x) => x.id === row.original.ciTypeId)?.name ?? ''}` : ''}`
                  : t(SERVICE_QUANTITY_SOURCE.labels[row.original.quantitySource as keyof typeof SERVICE_QUANTITY_SOURCE.labels] ?? ''),
            },
            { header: 'Unit price', meta: { align: 'right' }, cell: ({ row }) => formatMoney(row.original.unitPrice) },
            { header: 'Unit cost', meta: { align: 'right' }, cell: ({ row }) => (row.original.unitCost != null ? formatMoney(row.original.unitCost) : '—') },
            { header: 'Active', cell: ({ row }) => (row.original.isActive ? 'Yes' : 'No') },
          ]}
          fields={[
            { name: 'name', label: 'Name', type: 'text', required: true, span: 2 },
            { name: 'description', label: 'Description', type: 'textarea', span: 2, rows: 2 },
            { name: 'unitPrice', label: 'Unit price', type: 'number', step: 0.01, required: true },
            { name: 'unitCost', label: 'Unit cost', type: 'number', step: 0.01 },
            { name: 'period', label: 'Price is per', type: 'select', options: BILLING_PERIOD.values.map((v) => ({ value: v, label: BILLING_PERIOD.labels[v] })) },
            {
              name: 'quantitySource',
              label: 'Quantity',
              type: 'select',
              options: SERVICE_QUANTITY_SOURCE.values.map((v) => ({ value: v, label: SERVICE_QUANTITY_SOURCE.labels[v] })),
              hint: 'Per device / per user: contract lines can count the client’s active devices of the type below, or their active contacts.',
            },
            { name: 'ciTypeId', label: 'Device type (per device)', type: 'select', numeric: true, options: opts(lookups.data?.ciTypes), hint: 'Empty = every active device of the client.' },
            { name: 'isActive', label: 'Active', type: 'checkbox' },
          ]}
        />
      </div>
    </div>
  );
}
