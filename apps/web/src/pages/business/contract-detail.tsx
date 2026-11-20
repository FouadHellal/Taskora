import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { FileSignature, MoreHorizontal, Pencil, Star, Trash2 } from 'lucide-react';
import { BILLING_PERIOD, formatMinutes } from '@taskora/shared';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { fmtDate } from '@/lib/utils';
import { PageBody, PageHeader } from '@/components/page';
import { Progress } from '@/components/charts';
import { CustomFieldsView } from '@/components/custom-fields';
import { handleFormError } from '@/components/form';
import { Button } from '@/components/ui/button';
import { Badge, Card, CardBody, CardHeader, EmptyState, Field, PageLoader, Stat } from '@/components/ui/misc';
import { ConfirmDialog, DropdownContent, DropdownItem, DropdownMenu, DropdownTrigger, Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/overlays';
import { ContractStatusBadge, ContractTypeBadge, FieldGrid, hrs, labelOf, useMoney, useTabParam } from '@/components/business/common';
import { CONTRACT_FIELDS, CONTRACT_TYPE_HINTS, ContractFormDialog, type ContractRecord } from '@/components/business/contract-form';
import {
  ContractBlocksTab,
  ContractExclusionsCard,
  ContractRatesTab,
  ContractServicesTab,
  type ContractBlock,
  type ContractExclusion,
  type ContractRate,
  type ContractServiceLine,
} from '@/components/business/contract-tabs';
import { RelatedTickets, RelatedTime } from '@/components/business/related-lists';

interface ContractDetail extends ContractRecord {
  createdAt: string;
  updatedAt: string;
  rates: ContractRate[];
  blocks: ContractBlock[];
  services: ContractServiceLine[];
  exclusions: ContractExclusion[];
  usage: {
    minutes: number;
    billableMinutes: number;
    coveredMinutes: number;
    overageMinutes: number;
    billableAmount: number;
    tickets: number;
    openTickets: number;
    purchasedHours: number;
    usedHours: number;
    remainingHours: number;
    lowBalance: boolean;
    recurringServicesAmount: number;
  };
}

export default function ContractDetailPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { can } = useAuth();
  const money = useMoney();
  const [tab, setTab] = useTabParam('overview');
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const q = useQuery({ queryKey: ['contract', Number(id)], queryFn: () => api.get<ContractDetail>(`/contracts/${id}`) });
  const remove = useMutation({
    mutationFn: () => api.delete(`/contracts/${id}`),
    onSuccess: () => {
      toast.success('Contract deleted');
      qc.invalidateQueries({ queryKey: ['contracts'] });
      navigate('/contracts');
    },
    onError: (e) => {
      setDeleting(false);
      handleFormError(e);
    },
  });

  if (q.isLoading) return <PageLoader />;
  if (q.isError || !q.data) return <EmptyState icon={<FileSignature />} title="Contract not found" description="It may have been deleted." action={<Button onClick={() => navigate('/contracts')}>Back to contracts</Button>} />;
  const c = q.data;
  const u = c.usage;
  const f = CONTRACT_FIELDS[c.type] ?? {};
  const isBlock = c.type === 'block_hours' || u.purchasedHours > 0;
  const livePurchased = c.blocks.filter((b) => !b.expired).reduce((a, b) => a + b.hours, 0);
  const usedPct = livePurchased ? ((livePurchased - u.remainingHours) / livePurchased) * 100 : u.purchasedHours ? 100 : 0;
  const writable = can('contracts.write');

  return (
    <Tabs value={tab} onValueChange={setTab}>
      <PageHeader
        breadcrumbs={[{ label: 'Contracts', to: '/contracts' }, { label: c.contractNumber }]}
        icon={<FileSignature />}
        title={c.name}
        subtitle={
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span>{c.contractNumber}</span>
            <span className="text-subtle">·</span>
            <Link to={`/companies/${c.companyId}`} className="text-foreground hover:text-primary">
              {c.companyName}
            </Link>
            <ContractTypeBadge type={c.type} />
            <ContractStatusBadge status={c.status} />
            {isBlock && u.lowBalance && <Badge tone="danger">Low block balance</Badge>}
            {c.isDefault && (
              <span className="inline-flex items-center gap-1 text-xs text-warning">
                <Star className="size-3 fill-current" /> Default
              </span>
            )}
            <span className="text-subtle">·</span>
            <span>
              {fmtDate(c.startDate)} – {c.endDate ? fmtDate(c.endDate) : 'open-ended'}
            </span>
            <span className="text-subtle">·</span>
            <span>SLA: {c.slaName ?? 'default'}</span>
          </span>
        }
        actions={
          writable && (
            <>
              <Button onClick={() => setEditing(true)}>
                <Pencil /> Edit
              </Button>
              <DropdownMenu>
                <DropdownTrigger asChild>
                  <Button size="icon" variant="ghost" aria-label="More actions">
                    <MoreHorizontal />
                  </Button>
                </DropdownTrigger>
                <DropdownContent>
                  <DropdownItem danger onSelect={() => setDeleting(true)}>
                    <Trash2 /> Delete contract
                  </DropdownItem>
                </DropdownContent>
              </DropdownMenu>
            </>
          )
        }
      >
        <TabsList className="border-b-0">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="rates" count={c.rates.length}>
            Rates
          </TabsTrigger>
          <TabsTrigger value="blocks" count={c.blocks.length}>
            Blocks
          </TabsTrigger>
          <TabsTrigger value="services" count={c.services.length}>
            Services
          </TabsTrigger>
          <TabsTrigger value="tickets" count={u.tickets}>
            Tickets
          </TabsTrigger>
          <TabsTrigger value="time">Time</TabsTrigger>
        </TabsList>
      </PageHeader>

      <PageBody className="space-y-4">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
          <Stat label="Hours logged" value={hrs(u.minutes)} hint={`${formatMinutes(u.billableMinutes)} billable`} />
          <Stat label="Covered vs billable" value={`${formatMinutes(u.coveredMinutes)} / ${formatMinutes(Math.max(0, u.billableMinutes - u.coveredMinutes))}`} hint="Contract-covered / billed separately" />
          {isBlock ? (
            <button type="button" onClick={() => setTab('blocks')} className="rounded-lg border border-border bg-surface px-3.5 py-2.5 text-left shadow-card hover:border-border-strong">
              <div className="flex items-center justify-between gap-2 text-[11px] font-medium uppercase tracking-wide text-muted">
                Block hours remaining
                {u.lowBalance && <Badge tone="danger">Low</Badge>}
              </div>
              <div className={`mt-0.5 text-xl font-semibold tabular-nums ${u.lowBalance ? 'text-danger' : ''}`}>{u.remainingHours} h</div>
              <Progress value={usedPct} tone={u.lowBalance ? 'danger' : usedPct >= 80 ? 'warning' : 'primary'} className="mt-1" />
              <div className="mt-0.5 text-[11px] text-muted">
                {u.usedHours} of {u.purchasedHours} h used{u.overageMinutes ? ` · ${(u.overageMinutes / 60).toFixed(2)} h overage` : ''}
              </div>
            </button>
          ) : (
            <Stat label="Recurring" value={c.recurringAmount ? money(c.recurringAmount + u.recurringServicesAmount) : money(u.recurringServicesAmount)} hint={`${labelOf(BILLING_PERIOD, c.billingPeriod)} · fee + services`} />
          )}
          <Stat label="Billable amount" value={money(u.billableAmount)} hint="Billable time not covered (overage included)" />
          <Stat label="Open tickets" value={u.openTickets} hint={`${u.tickets} total`} tone={u.openTickets ? 'warning' : undefined} onClick={() => setTab('tickets')} />
        </div>

        <TabsContent value="overview">
          <div className="grid gap-4 lg:grid-cols-3">
            <Card className="lg:col-span-2">
              <CardHeader title="Contract details" />
              <CardBody>
                <FieldGrid cols={3}>
                  <Field label="Company">
                    <Link to={`/companies/${c.companyId}`} className="text-primary hover:underline">
                      {c.companyName}
                    </Link>
                  </Field>
                  <Field label="Customer contact">{c.contactId ? <Link to={`/contacts/${c.contactId}`} className="text-primary hover:underline">{c.contactName}</Link> : null}</Field>
                  <Field label="SLA policy">{c.slaName ?? 'Company / system default'}</Field>
                  <Field label="Start date">{fmtDate(c.startDate)}</Field>
                  <Field label="End date">{c.endDate ? fmtDate(c.endDate) : 'Open-ended'}</Field>
                  <Field label="Default contract">{c.isDefault ? 'Yes' : 'No'}</Field>
                  <Field label="Billing model" className="sm:col-span-3">
                    <span className="text-muted">{CONTRACT_TYPE_HINTS[c.type]}</span>
                  </Field>
                  {(f.hourly || c.hourlyRate != null) && <Field label="Hourly rate">{c.hourlyRate != null ? money(c.hourlyRate) : null}</Field>}
                  {(f.fixed || c.fixedAmount != null) && <Field label="Fixed amount">{c.fixedAmount != null ? money(c.fixedAmount) : null}</Field>}
                  {(f.recurring || c.recurringAmount != null) && <Field label="Recurring amount">{c.recurringAmount != null ? money(c.recurringAmount) : null}</Field>}
                  {(f.recurring || c.recurringAmount != null) && <Field label="Billing period">{labelOf(BILLING_PERIOD, c.billingPeriod)}</Field>}
                  {(f.overage || c.overageRate != null) && <Field label="Overage rate">{c.overageRate != null ? `${money(c.overageRate)}/h` : null}</Field>}
                  {(f.perTicket || c.perTicketRate != null) && <Field label="Per-ticket rate">{c.perTicketRate != null ? money(c.perTicketRate) : null}</Field>}
                  <CustomFieldsView entity="contract" value={c.customFields} />
                </FieldGrid>
                {c.description && (
                  <div className="mt-4 border-t border-border pt-3">
                    <div className="text-[11px] font-medium uppercase tracking-wide text-subtle">Description / scope</div>
                    <p className="prose-note mt-1 text-[13px]">{c.description}</p>
                  </div>
                )}
              </CardBody>
            </Card>
            <Card>
              <CardHeader title="Financial summary" />
              <CardBody className="space-y-2 text-[13px]">
                <Row label="Time logged" value={hrs(u.minutes)} />
                <Row label="Billable time" value={hrs(u.billableMinutes)} />
                <Row label="Contract-covered time" value={hrs(u.coveredMinutes)} />
                {u.overageMinutes > 0 && <Row label="Overage time" value={hrs(u.overageMinutes)} />}
                <Row label="Billable amount (uncovered)" value={money(u.billableAmount)} />
                {u.purchasedHours > 0 && <Row label="Purchased hours" value={`${u.purchasedHours} h`} />}
                {u.purchasedHours > 0 && <Row label="Remaining hours" value={`${u.remainingHours} h`} />}
                <Row label="Services per period" value={money(u.recurringServicesAmount)} />
                <div className="border-t border-border pt-2 text-xs text-muted">
                  Created {fmtDate(c.createdAt)} · updated {fmtDate(c.updatedAt)}
                </div>
              </CardBody>
            </Card>
            {c.type !== 'time_materials' && (
              <div className="lg:col-span-3">
                <ContractExclusionsCard contractId={c.id} exclusions={c.exclusions} />
              </div>
            )}
          </div>
        </TabsContent>
        <TabsContent value="rates">
          <ContractRatesTab contractId={c.id} rates={c.rates} contractRate={c.hourlyRate} />
        </TabsContent>
        <TabsContent value="blocks">
          <ContractBlocksTab contractId={c.id} blocks={c.blocks} summary={u} overageRate={c.overageRate} />
        </TabsContent>
        <TabsContent value="services">
          <ContractServicesTab contractId={c.id} services={c.services} />
        </TabsContent>
        <TabsContent value="tickets">
          <RelatedTickets filter={{ contractId: c.id }} />
        </TabsContent>
        <TabsContent value="time">
          <RelatedTime filter={{ contractId: c.id }} />
        </TabsContent>
      </PageBody>

      <ContractFormDialog open={editing} onOpenChange={setEditing} contract={c} />
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title="Delete contract?"
        description={`${c.contractNumber} ${c.name} will be permanently deleted. Contracts with logged time cannot be deleted — set them to cancelled instead.`}
        confirmLabel="Delete"
        danger
        loading={remove.isPending}
        onConfirm={() => remove.mutate()}
      />
    </Tabs>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-muted">{label}</span>
      <span className="font-medium tabular-nums">{value}</span>
    </div>
  );
}
