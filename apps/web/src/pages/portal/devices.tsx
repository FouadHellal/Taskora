import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { HardDrive, Search, ShieldAlert } from 'lucide-react';
import { CI_LIFECYCLE } from '@taskora/shared';
import { translate as t } from '@/lib/i18n';
import { fmtDate } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge, Card, EmptyState, PageLoader } from '@/components/ui/misc';
import { papi, type Me } from './lib';

interface Device {
  id: number;
  name: string;
  typeName: string | null;
  serialNumber: string | null;
  hostname: string | null;
  osName: string | null;
  warrantyExpiresAt: string | null;
  lifecycleStatus: string;
  userName: string | null;
  mine: boolean;
  openTickets: number;
}

export default function PortalDevices({ me }: { me: Me }) {
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const q = useQuery({ queryKey: ['portal-devices'], queryFn: () => papi<{ data: Device[] }>('GET', '/devices') });
  const c = me.contact!;
  if (q.isLoading) return <PageLoader />;
  const term = search.trim().toLowerCase();
  const rows = (q.data?.data ?? []).filter((d) => !term || [d.name, d.typeName, d.serialNumber, d.hostname, d.userName].some((v) => v?.toLowerCase().includes(term)));
  const today = new Date().toISOString().slice(0, 10);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="text-lg font-semibold">{c.isManager ? t('Devices') : t('My devices')}</h1>
          <p className="text-[12px] text-muted">{c.isManager ? t('The computers and equipment the IT team manages for {company}.', { company: c.companyName }) : t('The computers and equipment registered in your name.')}</p>
        </div>
        <div className="relative w-full sm:w-64">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-subtle" />
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search devices…" className="pl-8" />
        </div>
      </div>
      {!rows.length ? (
        <Card>
          <EmptyState icon={<HardDrive />} title={term ? 'No device matches your search' : 'No devices registered'} />
        </Card>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {rows.map((d) => {
            const warrantyOver = d.warrantyExpiresAt && d.warrantyExpiresAt < today;
            return (
              <Card key={d.id} className="flex flex-col p-4">
                <div className="flex items-start gap-2">
                  <HardDrive className="mt-0.5 size-4 shrink-0 text-primary" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[14px] font-medium">{d.name}</div>
                    <div className="text-[11px] text-muted">{d.typeName ?? t('Device')}</div>
                  </div>
                  {d.mine && <Badge tone="primary">{t('Yours')}</Badge>}
                  {d.lifecycleStatus !== 'active' && <Badge>{t((CI_LIFECYCLE.labels as Record<string, string>)[d.lifecycleStatus] ?? d.lifecycleStatus)}</Badge>}
                </div>
                <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1.5 text-[12px]">
                  {d.userName && (
                    <>
                      <dt className="text-muted">{t('User')}</dt>
                      <dd className="truncate">{d.userName}</dd>
                    </>
                  )}
                  {d.osName && (
                    <>
                      <dt className="text-muted">{t('System')}</dt>
                      <dd className="truncate">{d.osName}</dd>
                    </>
                  )}
                  {d.serialNumber && (
                    <>
                      <dt className="text-muted">{t('Serial number')}</dt>
                      <dd className="truncate font-mono text-[11px]">{d.serialNumber}</dd>
                    </>
                  )}
                  {d.warrantyExpiresAt && (
                    <>
                      <dt className="text-muted">{t('Warranty until')}</dt>
                      <dd className={warrantyOver ? 'inline-flex items-center gap-1 text-warning' : ''}>
                        {warrantyOver && <ShieldAlert className="size-3" />} {fmtDate(d.warrantyExpiresAt)}
                      </dd>
                    </>
                  )}
                  <dt className="text-muted">{t('Open requests')}</dt>
                  <dd>{d.openTickets}</dd>
                </dl>
                <div className="mt-auto pt-3">
                  <Button size="sm" variant="ghost" className="-ml-2" onClick={() => navigate(`/portal/tickets/new?device=${d.id}`)}>
                    {t('Report a problem')}
                  </Button>
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
