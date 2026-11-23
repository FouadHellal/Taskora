import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Building2, ExternalLink, Save, UserPlus, Users } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { translate as t } from '@/lib/i18n';
import { fmtRelative } from '@/lib/utils';
import { PageHeader } from '@/components/page';
import { Button } from '@/components/ui/button';
import { Checkbox, Select, Textarea } from '@/components/ui/input';
import { Badge, Card, CardBody, CardHeader, EmptyState, PageLoader, Stat } from '@/components/ui/misc';
import { Dialog } from '@/components/ui/overlays';
import { EntityPicker } from '@/components/entity-picker';
import { FormField, handleFormError } from '@/components/form';
import { PORTAL_ROLE_LABELS, PortalAccessCard } from '@/components/forms/portal-access';

interface PortalSettings {
  portalEnabled: boolean;
  portalWelcome: string;
  portalShowTime: boolean;
  portalShowDevices: boolean;
  portalShowContracts: boolean;
  portalAllowDocs: boolean;
  portalAllowPriority: boolean;
  portalAllowAttachments: boolean;
}

interface PortalUser {
  id: number;
  firstName: string;
  lastName: string;
  email: string | null;
  companyId: number;
  companyName: string;
  isPrimary: boolean;
  isActive: boolean;
  portalRole: string;
  portalLastLoginAt: string | null;
  invitePending: boolean;
}

const TOGGLES: { key: keyof PortalSettings; label: string; hint: string }[] = [
  { key: 'portalShowTime', label: 'Show the work done', hint: 'Time entries on tickets (date, technician, duration, description) and the Work & hours page. Internal notes and rates are never shown.' },
  { key: 'portalShowContracts', label: 'Show contracts and remaining hours', hint: 'Company managers see their active contracts and hour-block balances.' },
  { key: 'portalShowDevices', label: 'Show devices', hint: 'Managers see the company devices, users see the devices assigned to them. Also lets them pick a device on a new request.' },
  { key: 'portalAllowDocs', label: 'Company documentation', hint: 'Clients read the documentation you share (public pages of their company) and can write their own pages.' },
  { key: 'portalAllowPriority', label: 'Clients choose the priority', hint: 'Otherwise new requests get the default priority.' },
  { key: 'portalAllowAttachments', label: 'Clients can attach files', hint: 'Screenshots and documents on new requests and replies.' },
];

export default function ClientPortalPage() {
  const qc = useQueryClient();
  const { can } = useAuth();
  const settings = useQuery({ queryKey: ['system-settings'], queryFn: () => api.get<PortalSettings & Record<string, unknown>>('/settings/system') });
  const users = useQuery({ queryKey: ['portal-users'], queryFn: () => api.get<{ data: PortalUser[]; stats: { tickets30: number; docs: number } }>('/portal/users') });
  const [f, setF] = useState<PortalSettings | null>(null);
  const [adding, setAdding] = useState(false);
  useEffect(() => {
    if (settings.data && !f)
      setF({
        portalEnabled: settings.data.portalEnabled,
        portalWelcome: settings.data.portalWelcome,
        portalShowTime: settings.data.portalShowTime,
        portalShowDevices: settings.data.portalShowDevices,
        portalShowContracts: settings.data.portalShowContracts,
        portalAllowDocs: settings.data.portalAllowDocs,
        portalAllowPriority: settings.data.portalAllowPriority,
        portalAllowAttachments: settings.data.portalAllowAttachments,
      });
  }, [settings.data, f]);
  const save = useMutation({
    mutationFn: () => api.put('/settings/system', f),
    onSuccess: () => {
      toast.success(t('Client portal settings saved'));
      qc.invalidateQueries({ queryKey: ['system-settings'] });
    },
    onError: (e) => handleFormError(e),
  });
  const setRole = useMutation({
    mutationFn: ({ id, role }: { id: number; role: string }) => api.post(`/contacts/${id}/portal`, { enabled: true, role }),
    onSuccess: () => {
      toast.success(t('Access level updated'));
      qc.invalidateQueries({ queryKey: ['portal-users'] });
    },
    onError: (e) => handleFormError(e),
  });
  const canManage = can('settings.manage');
  const canWrite = can('companies.write');
  if (!f) return <PageLoader />;
  const portalUrl = `${window.location.origin}/portal`;
  const list = users.data?.data ?? [];

  return (
    <div>
      <PageHeader
        title="Client portal"
        icon={<Building2 />}
        subtitle="What your clients see when they sign in, and who has access"
        actions={
          <a href="/portal/login" target="_blank" rel="noreferrer">
            <Button>
              <ExternalLink /> Open the client portal
            </Button>
          </a>
        }
      />
      <div className="space-y-4 p-4 sm:p-5">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Stat label="Portal users" value={list.length} />
          <Stat label="Companies" value={new Set(list.map((u) => u.companyId)).size} />
          <Stat label="Requests from the portal (30 d)" value={users.data?.stats.tickets30 ?? 0} />
          <Stat label="Pages written by clients" value={users.data?.stats.docs ?? 0} />
        </div>

        <div className="grid gap-4 xl:grid-cols-5">
          <Card className="xl:col-span-2">
            <CardHeader title="Settings" />
            <CardBody className="space-y-4 text-[13px]">
              <div className="rounded-md border border-border bg-surface-2 p-3">
                <Checkbox label={t('Client portal enabled')} checked={f.portalEnabled} disabled={!canManage} onChange={(e) => setF({ ...f, portalEnabled: e.target.checked })} />
                <p className="ml-6 mt-1 text-xs text-muted">
                  {t('Clients sign in at')} <span className="font-mono">{portalUrl}</span> {t('(also linked from the sign-in page: “Sign in as a client”).')}
                </p>
              </div>
              {TOGGLES.map((tg) => (
                <div key={tg.key}>
                  <Checkbox label={t(tg.label)} checked={f[tg.key] as boolean} disabled={!canManage || !f.portalEnabled} onChange={(e) => setF({ ...f, [tg.key]: e.target.checked })} />
                  <p className="ml-6 mt-0.5 text-xs text-muted">{t(tg.hint)}</p>
                </div>
              ))}
              <FormField label="Welcome message" hint="Shown on the portal home page. Markdown: **bold**, - lists, [links](https://…). E.g. opening hours or an emergency phone number.">
                <Textarea rows={4} value={f.portalWelcome} disabled={!canManage} onChange={(e) => setF({ ...f, portalWelcome: e.target.value })} />
              </FormField>
              {canManage && (
                <Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>
                  <Save /> Save settings
                </Button>
              )}
            </CardBody>
          </Card>

          <Card className="xl:col-span-3">
            <CardHeader
              title={<span className="inline-flex items-center gap-1.5"><Users className="size-4 text-primary" /> {t('Who has access')}</span>}
              actions={
                canWrite && (
                  <Button size="sm" variant="primary" onClick={() => setAdding(true)}>
                    <UserPlus /> Give a contact access
                  </Button>
                )
              }
            />
            {users.isLoading ? (
              <PageLoader />
            ) : !list.length ? (
              <EmptyState icon={<Users />} title="Nobody has access yet" description="Give access to a contact of one of your companies: they receive an e-mail to choose their password, or you share a generated one." />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[640px] text-[13px]">
                  <thead>
                    <tr className="border-b border-border text-left text-[11px] uppercase tracking-wide text-muted">
                      <th className="px-4 py-2 font-medium">{t('Contact')}</th>
                      <th className="px-2 py-2 font-medium">{t('Company')}</th>
                      <th className="px-2 py-2 font-medium">{t('Access level')}</th>
                      <th className="px-4 py-2 font-medium">{t('Last sign-in')}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {list.map((u) => (
                      <tr key={u.id}>
                        <td className="px-4 py-2">
                          <Link to={`/contacts/${u.id}`} className="font-medium text-primary hover:underline">
                            {u.firstName} {u.lastName}
                          </Link>
                          <div className="text-[11px] text-muted">{u.email}</div>
                        </td>
                        <td className="px-2 py-2">
                          <Link to={`/companies/${u.companyId}`} className="hover:underline">
                            {u.companyName}
                          </Link>
                        </td>
                        <td className="px-2 py-2">
                          {canWrite ? (
                            <Select className="h-8 max-w-56 text-[12px]" value={u.portalRole} onChange={(e) => setRole.mutate({ id: u.id, role: e.target.value })}>
                              {Object.entries(PORTAL_ROLE_LABELS).map(([k, v]) => (
                                <option key={k} value={k}>
                                  {t(v.split(' — ')[0]!)}
                                </option>
                              ))}
                            </Select>
                          ) : (
                            t(PORTAL_ROLE_LABELS[u.portalRole]?.split(' — ')[0] ?? u.portalRole)
                          )}
                          {u.isPrimary && u.portalRole === 'user' && <div className="text-[11px] text-muted">{t('Primary contact: sees the whole company')}</div>}
                        </td>
                        <td className="px-4 py-2 text-[12px]">
                          {u.invitePending ? <Badge tone="warning">{t('Invitation pending')}</Badge> : fmtRelative(u.portalLastLoginAt, t('never'))}
                          {!u.isActive && <Badge className="ml-1">{t('Inactive contact')}</Badge>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </div>

        <Card>
          <CardHeader title="How it works" />
          <CardBody className="grid gap-4 text-[13px] md:grid-cols-3">
            <div>
              <div className="font-medium">{t('1. Give access')}</div>
              <p className="mt-1 text-xs text-muted">{t('Open a contact (or use “Give a contact access”), choose the access level and send an invitation e-mail — or generate a password and share it yourself.')}</p>
            </div>
            <div>
              <div className="font-medium">{t('2. Access levels')}</div>
              <p className="mt-1 text-xs text-muted">{t('A user sees the requests they opened. A company manager (and the primary contact) sees every ticket of the company, the work done and the contracts.')}</p>
            </div>
            <div>
              <div className="font-medium">{t('3. What clients can do')}</div>
              <p className="mt-1 text-xs text-muted">
                {t('Open requests, reply, attach files and write their documentation. They cannot change a ticket status, the solution or the time: that stays with the IT team. Ticket files are shared with the eye button on the ticket.')}
              </p>
            </div>
          </CardBody>
        </Card>
      </div>
      {adding && <AddAccessDialog onClose={() => setAdding(false)} />}
    </div>
  );
}

function AddAccessDialog({ onClose }: { onClose: () => void }) {
  const [companyId, setCompanyId] = useState<number | null>(null);
  const [contactId, setContactId] = useState<number | null>(null);
  const contact = useQuery({
    queryKey: ['contact', contactId],
    queryFn: () => api.get<{ id: number; email: string | null; isPrimary: boolean; portalEnabled: boolean; portalLastLoginAt: string | null; portalRole: string; portalPasswordSet: boolean }>(`/contacts/${contactId}`),
    enabled: contactId !== null,
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title="Give a contact access" size="md" footer={<Button onClick={onClose}>Close</Button>}>
      <div className="space-y-3">
        <FormField label="Company">
          <EntityPicker
            kind="company"
            value={companyId}
            onChange={(id) => {
              setCompanyId(id);
              setContactId(null);
            }}
          />
        </FormField>
        {companyId && (
          <FormField label="Contact" hint="Missing someone? Add the contact on the company first.">
            <EntityPicker kind="contact" value={contactId} onChange={setContactId} filter={{ companyId }} />
          </FormField>
        )}
        {contact.data && <PortalAccessCard key={contact.data.id} contact={contact.data} canWrite />}
      </div>
    </Dialog>
  );
}
