import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, CalendarClock, Download, FileSignature, Hourglass, Receipt, RefreshCw } from 'lucide-react';
import { CONTRACT_TYPE } from '@taskora/shared';
import { getLanguage, translate as t } from '@/lib/i18n';
import { cn, fmtDate } from '@/lib/utils';
import { Badge, Card, CardBody, CardHeader, EmptyState, PageLoader } from '@/components/ui/misc';
import { Progress } from '@/components/charts';
import { fmtMoney, papi, type Me } from './lib';

interface Line {
  id: number;
  name: string;
  description: string | null;
  period: string;
  quantitySource: 'manual' | 'devices' | 'users';
  ciTypeName: string | null;
  quantity: number;
  autoQuantity: boolean;
  unitPrice: number;
  amount: number;
  monthly: number | null;
  oneTime: boolean;
  upcoming: boolean;
  startDate: string | null;
}

interface Agreement {
  id: number;
  contractNumber: string;
  name: string;
  type: string;
  description: string | null;
  startDate: string;
  endDate: string | null;
  autoRenew: boolean;
  billingPeriod: string;
  billingMonths: number;
  daysLeft: number | null;
  termProgress: number | null;
  nextInvoiceDate: string | null;
  recurringAmount: number | null;
  fixedAmount: number | null;
  hourlyRate: number | null;
  overageRate: number | null;
  perTicketRate: number | null;
  services: Line[];
  totals: { monthly: number; perPeriod: number; annual: number };
  hours: { purchased: number; used: number; remaining: number; low: boolean } | null;
}

interface Billing {
  currency: string;
  agreements: Agreement[];
  totals: { monthly: number; annual: number };
  invoices: { id: number; invoiceNumber: string; status: string; issueDate: string | null; dueDate: string | null; periodStart: string; periodEnd: string; total: number; currency: string; overdue: boolean }[];
  outstanding: number;
}

const PERIOD_WORD: Record<string, string> = { monthly: 'month', quarterly: 'quarter', semi_annual: 'half-year', annual: 'year', one_time: 'one-time' };
const PER_PERIOD: Record<string, string> = { monthly: 'per month', quarterly: 'per quarter', semi_annual: 'per half-year', annual: 'per year', one_time: 'one-time' };
const BILLED: Record<string, string> = { monthly: 'Billed monthly', quarterly: 'Billed quarterly', semi_annual: 'Billed every six months', annual: 'Billed yearly', one_time: 'Billed once' };

function unitLabel(l: Line) {
  if (l.quantitySource === 'devices') return l.ciTypeName ? t('per {type}', { type: t(l.ciTypeName).toLowerCase() }) : t('per device');
  if (l.quantitySource === 'users') return t('per user');
  return t('per unit');
}

export default function PortalBilling({ me }: { me: Me }) {
  const q = useQuery({ queryKey: ['portal-billing'], queryFn: () => papi<Billing>('GET', '/billing') });
  if (q.isLoading) return <PageLoader />;
  const b = q.data;
  if (!b) return null;
  const lang = getLanguage();
  const money = (n: number | null | undefined) => fmtMoney(n, b.currency, lang);

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">{t('Contract & billing')}</h1>
        <p className="mt-0.5 text-[13px] text-muted">{t('Your service agreement with {org}: what is included, the price of each service and your invoices.', { org: me.organizationName })}</p>
      </div>

      {!b.agreements.length ? (
        <Card>
          <EmptyState icon={<FileSignature />} title="No active agreement" description="Contact us if you expected to see your service agreement here." />
        </Card>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-3">
            <Summary label="Per month" value={money(b.totals.monthly)} hint="All services together" accent />
            <Summary label="Per year" value={money(b.totals.annual)} hint="At today's quantities" />
            <Summary label="Open invoices" value={money(b.outstanding)} hint={b.outstanding ? 'Waiting for payment' : 'Nothing to pay'} warn={b.invoices.some((i) => i.overdue)} />
          </div>

          {b.agreements.map((a) => (
            <Card key={a.id}>
              <CardHeader
                title={
                  <span className="flex flex-wrap items-center gap-2">
                    {a.name}
                    <span className="font-mono text-[11px] font-normal text-muted">{a.contractNumber}</span>
                  </span>
                }
                actions={<Badge tone="primary">{t((CONTRACT_TYPE.labels as Record<string, string>)[a.type] ?? a.type)}</Badge>}
              />
              <CardBody className="space-y-5">
                {/* Term */}
                <div className="grid gap-3 sm:grid-cols-3">
                  <Fact icon={<CalendarClock className="size-4" />} label="Contract term">
                    {fmtDate(a.startDate)} → {a.endDate ? fmtDate(a.endDate) : t('open-ended')}
                  </Fact>
                  <Fact icon={<Receipt className="size-4" />} label="Billing">
                    {t(BILLED[a.billingPeriod] ?? a.billingPeriod)}
                    {a.nextInvoiceDate && <div className="text-[11px] font-normal text-muted">{t('Next invoice around {date}', { date: fmtDate(a.nextInvoiceDate) })}</div>}
                  </Fact>
                  <Fact icon={<RefreshCw className="size-4" />} label="Renewal">
                    {a.endDate ? (a.autoRenew ? t('Renews automatically') : t('Ends on {date}', { date: fmtDate(a.endDate) })) : t('No end date')}
                    {a.daysLeft != null && a.daysLeft >= 0 && <div className="text-[11px] font-normal text-muted">{t('{n} days left', { n: a.daysLeft })}</div>}
                  </Fact>
                </div>
                {a.termProgress != null && <Progress value={a.termProgress} tone={a.daysLeft != null && a.daysLeft < 30 ? 'warning' : 'primary'} />}
                {a.description && <p className="text-[13px] text-muted">{a.description}</p>}

                {/* Services */}
                {(a.services.length > 0 || !!a.recurringAmount) && (
                <div className="overflow-x-auto rounded-md border border-border">
                  <table className="w-full min-w-[560px] text-[13px]">
                    <thead className="bg-surface-2 text-left text-[11px] uppercase tracking-wide text-muted">
                      <tr>
                        <th className="px-3 py-2 font-medium">{t('Service')}</th>
                        <th className="px-3 py-2 text-right font-medium">{t('Unit price')}</th>
                        <th className="px-3 py-2 text-right font-medium">{t('Quantity')}</th>
                        <th className="px-3 py-2 text-right font-medium">{t('Per month')}</th>
                        <th className="px-3 py-2 text-right font-medium">{t(PER_PERIOD[a.billingPeriod] ?? 'per period')}</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {a.services.map((l) => (
                        <tr key={l.id} className={cn(l.upcoming && 'text-muted')}>
                          <td className="px-3 py-2">
                            <div className="font-medium">{l.name}</div>
                            {l.description && <div className="text-[11px] text-muted">{l.description}</div>}
                            {l.upcoming && l.startDate && <div className="text-[11px] text-primary">{t('Starts on {date}', { date: fmtDate(l.startDate) })}</div>}
                          </td>
                          <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums">
                            {money(l.unitPrice)}
                            <div className="text-[11px] text-muted">
                              {unitLabel(l)} · {t(PERIOD_WORD[l.period] ?? l.period)}
                            </div>
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums">
                            {l.quantity}
                            {l.autoQuantity && <div className="text-[11px] text-muted">{t('counted automatically')}</div>}
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums">{l.oneTime ? '—' : money(l.monthly)}</td>
                          <td className="px-3 py-2 text-right font-medium tabular-nums">{l.oneTime ? money(l.amount) : money((l.monthly ?? 0) * a.billingMonths)}</td>
                        </tr>
                      ))}
                      {!!a.recurringAmount && (
                        <tr>
                          <td className="px-3 py-2 font-medium">{t('Recurring fee')}</td>
                          <td className="px-3 py-2 text-right tabular-nums">{money(a.recurringAmount)}</td>
                          <td className="px-3 py-2 text-right">1</td>
                          <td className="px-3 py-2 text-right tabular-nums">{money(a.recurringAmount / a.billingMonths)}</td>
                          <td className="px-3 py-2 text-right font-medium tabular-nums">{money(a.recurringAmount)}</td>
                        </tr>
                      )}
                      {!a.services.length && !a.recurringAmount && (
                        <tr>
                          <td colSpan={5} className="px-3 py-3 text-center text-muted">
                            {t('No recurring services on this agreement.')}
                          </td>
                        </tr>
                      )}
                    </tbody>
                    <tfoot className="bg-surface-2 font-semibold">
                      <tr>
                        <td className="px-3 py-2" colSpan={3}>
                          {t('Total')}
                          <span className="ml-2 text-[11px] font-normal text-muted">{t('{amount} per year', { amount: money(a.totals.annual) })}</span>
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">{money(a.totals.monthly)}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{money(a.totals.perPeriod)}</td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
                )}
                {!!a.fixedAmount && (
                  <div className="flex items-center justify-between rounded-md border border-border px-3 py-2 text-[13px]">
                    <span>{t('Fixed price')}</span>
                    <span className="font-semibold tabular-nums">{money(a.fixedAmount)}</span>
                  </div>
                )}

                {/* Hours and extra work */}
                <div className="grid gap-3 sm:grid-cols-2">
                  {a.hours && (
                    <div className="rounded-md border border-border p-3">
                      <div className="flex items-center gap-1.5 text-[12px] text-muted">
                        <Hourglass className="size-4 text-primary" /> {t('Prepaid hours')}
                      </div>
                      <div className="mt-1 text-[15px] font-semibold">{t('{remaining} h left of {purchased} h', { remaining: a.hours.remaining, purchased: a.hours.purchased })}</div>
                      <Progress className="mt-2" value={(a.hours.used / Math.max(a.hours.purchased, 1)) * 100} tone={a.hours.low ? 'warning' : 'primary'} />
                    </div>
                  )}
                  {(a.hourlyRate || a.overageRate || a.perTicketRate) && (
                    <div className="rounded-md border border-border p-3 text-[13px]">
                      <div className="mb-1 text-[12px] text-muted">{t('Work outside the agreement')}</div>
                      {a.hourlyRate ? <div>{t('{amount} per hour', { amount: money(a.hourlyRate) })}</div> : null}
                      {a.overageRate ? <div>{t('{amount} per extra hour beyond the prepaid hours', { amount: money(a.overageRate) })}</div> : null}
                      {a.perTicketRate ? <div>{t('{amount} per request', { amount: money(a.perTicketRate) })}</div> : null}
                    </div>
                  )}
                </div>
              </CardBody>
            </Card>
          ))}
          <p className="text-[11px] text-muted">{t('Prices exclude taxes unless stated otherwise. Per-device and per-user services follow the number of devices and users we manage for you.')}</p>
        </>
      )}

      <Card>
        <CardHeader title="Invoices" />
        {!b.invoices.length ? (
          <CardBody className="text-[13px] text-muted">{t('No invoice yet.')}</CardBody>
        ) : (
          <ul className="divide-y divide-border">
            {b.invoices.map((i) => (
              <li key={i.id} className="flex flex-wrap items-center gap-3 px-4 py-2.5 text-[13px]">
                <div className="min-w-0 flex-1">
                  <div className="font-medium">{i.invoiceNumber}</div>
                  <div className="text-[11px] text-muted">
                    {fmtDate(i.periodStart)} – {fmtDate(i.periodEnd)}
                    {i.dueDate ? ` · ${t('due {date}', { date: fmtDate(i.dueDate) })}` : ''}
                  </div>
                </div>
                <span className="font-semibold tabular-nums">{fmtMoney(i.total, i.currency || b.currency, lang)}</span>
                {i.status === 'paid' ? (
                  <Badge tone="success">{t('Paid')}</Badge>
                ) : i.overdue ? (
                  <Badge tone="danger">
                    <AlertTriangle className="size-3" /> {t('Overdue')}
                  </Badge>
                ) : (
                  <Badge tone="warning">{t('To pay')}</Badge>
                )}
                <a href={`/api/portal/invoices/${i.id}/pdf`} className="inline-flex items-center gap-1 text-[12px] text-primary hover:underline">
                  <Download className="size-3.5" /> PDF
                </a>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

function Summary({ label, value, hint, accent, warn }: { label: string; value: string; hint?: string; accent?: boolean; warn?: boolean }) {
  return (
    <Card className={cn('p-4', accent && 'border-primary/40 bg-primary-soft/40')}>
      <div className="text-[12px] text-muted">{t(label)}</div>
      <div className={cn('mt-1 text-2xl font-semibold tabular-nums', warn && 'text-danger')}>{value}</div>
      {hint && <div className="mt-0.5 text-[11px] text-muted">{t(hint)}</div>}
    </Card>
  );
}

function Fact({ icon, label, children }: { icon: React.ReactNode; label: string; children: React.ReactNode }) {
  return (
    <div className="rounded-md bg-surface-2 px-3 py-2.5">
      <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-muted">
        <span className="text-primary">{icon}</span>
        {t(label)}
      </div>
      <div className="mt-1 text-[13px] font-medium">{children}</div>
    </div>
  );
}
