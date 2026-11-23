import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Building2, Globe, Mail, MapPin, MessageSquare, Pencil, Phone, Plus, Ticket, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { ACTIVITY_TYPE, COMPANY_TYPE, CONTRACT_TYPE } from '@taskora/shared';
import { api, type Paginated } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { fmtDate, fmtDateTime, fmtRelative } from '@/lib/utils';
import { PageHeader } from '@/components/page';
import { Button } from '@/components/ui/button';
import { Avatar, Badge, Card, CardBody, CardHeader, EmptyState, Field, PageLoader, Stat } from '@/components/ui/misc';
import { ConfirmDialog, Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/overlays';
import { Input, Select, Textarea } from '@/components/ui/input';
import { DataTable, type Column } from '@/components/data-table';
import { CompanyFormDialog, type CompanyRecord } from '@/components/forms/company-form';
import { ContactFormDialog } from '@/components/forms/contact-form';
import { CustomFieldsView } from '@/components/custom-fields';
import { RelatedCis, RelatedContracts, RelatedProjects, RelatedTickets } from '@/components/related-tables';
import { Attachments } from '@/pages/tickets/detail';
import { handleFormError } from '@/components/form';
import { CompanyLogo, LogoEditor } from '@/components/logo';
import { TicketLink } from '@/lib/open-ticket';

interface Company extends CompanyRecord {
  accountManagerName: string | null;
  parentCompanyName: string | null;
  primaryContactName: string | null;
  primaryContactEmail: string | null;
  primaryContactPhone: string | null;
  defaultSlaName: string | null;
  logoUpdatedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface Summary {
  tickets: { open: number; critical: number; unassigned: number; breached: number; waiting: number };
  cis: { active: number; total: number; managed: number; attention: number };
  contracts: { id: number; name: string; type: string; status: string; endDate: string | null; isDefault: boolean }[];
  technicians: { id: number; name: string; open: number }[];
  time: { minutes30: number; billable30: number };
  counts: { contacts: number; locations: number; projects: number };
}

export default function CompanyDetailPage() {
  const id = Number(useParams().id);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { can, me } = useAuth();
  const [editing, setEditing] = useState(false);
  const [addContact, setAddContact] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const company = useQuery({ queryKey: ['company', id], queryFn: () => api.get<Company>(`/companies/${id}`) });
  const summary = useQuery({ queryKey: ['company', id, 'summary'], queryFn: () => api.get<Summary>(`/companies/${id}/summary`) });
  const remove = useMutation({
    mutationFn: () => api.delete(`/companies/${id}`),
    onSuccess: () => {
      toast.success('Company deleted');
      qc.invalidateQueries({ queryKey: ['companies'] });
      navigate('/companies');
    },
    onError: (e) => handleFormError(e),
  });

  if (company.isLoading) return <PageLoader />;
  if (!company.data) return <EmptyState title="Company not found" />;
  const c = company.data;
  const s = summary.data;
  const address = [c.address1, c.address2, [c.postalCode, c.city].filter(Boolean).join(' '), c.state, c.country].filter(Boolean).join(', ');

  return (
    <div>
      <PageHeader
        title={c.name}
        icon={c.logoUpdatedAt ? <CompanyLogo companyId={c.id} name={c.name} logoUpdatedAt={c.logoUpdatedAt} className="size-9 ring-0" /> : <Building2 />}
        breadcrumbs={[{ label: 'Companies', to: '/companies' }, { label: c.name }]}
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            <Badge>{COMPANY_TYPE.labels[c.type as keyof typeof COMPANY_TYPE.labels] ?? c.type}</Badge>
            {!c.isActive && <Badge tone="warning">Inactive</Badge>}
            {c.accountNumber && <span>#{c.accountNumber}</span>}
            {c.industry && <span>· {c.industry}</span>}
            {c.parentCompanyId && (
              <span>
                · Parent:{' '}
                <Link to={`/companies/${c.parentCompanyId}`} className="text-primary hover:underline">
                  {c.parentCompanyName}
                </Link>
              </span>
            )}
          </span>
        }
        actions={
          <>
            {can('tickets.write') && (
              <Button variant="primary" onClick={() => navigate(`/tickets/new?companyId=${id}`)}>
                <Ticket /> New ticket
              </Button>
            )}
            {can('companies.write') && (
              <Button onClick={() => setEditing(true)}>
                <Pencil /> Edit
              </Button>
            )}
            {can('companies.delete') && (
              <Button variant="ghost" onClick={() => setDeleting(true)} aria-label="Delete company">
                <Trash2 />
              </Button>
            )}
          </>
        }
      />
      <div className="space-y-4 p-5">
        {s && (
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-8">
            <Stat label="Open tickets" value={s.tickets.open} onClick={() => navigate(`/tickets?companyId=${id}&statusCategory=open`)} />
            <Stat label="Critical" value={s.tickets.critical} tone={s.tickets.critical ? 'danger' : undefined} />
            <Stat label="SLA breached" value={s.tickets.breached} tone={s.tickets.breached ? 'danger' : undefined} />
            <Stat label="Awaiting customer" value={s.tickets.waiting} />
            <Stat label="Active devices" value={s.cis.active} hint={`${s.cis.managed} managed by Action1`} />
            <Stat label="Need attention" value={s.cis.attention} tone={s.cis.attention ? 'warning' : undefined} hint="Reboot / patches / offline" />
            <Stat label="Hours (30 d)" value={(s.time.minutes30 / 60).toFixed(1)} hint={`${(s.time.billable30 / 60).toFixed(1)} h billable`} />
            <Stat label="Contacts" value={s.counts.contacts} hint={`${s.counts.locations} locations · ${s.counts.projects} active projects`} />
          </div>
        )}

        <Tabs defaultValue="overview">
          <TabsList>
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="contacts" count={s?.counts.contacts}>
              Contacts
            </TabsTrigger>
            <TabsTrigger value="tickets" count={s?.tickets.open}>
              Tickets
            </TabsTrigger>
            <TabsTrigger value="cis" count={s?.cis.total}>
              Configuration items
            </TabsTrigger>
            <TabsTrigger value="contracts" count={s?.contracts.length}>
              Contracts
            </TabsTrigger>
            <TabsTrigger value="projects" count={s?.counts.projects}>
              Projects
            </TabsTrigger>
            <TabsTrigger value="locations" count={s?.counts.locations}>
              Locations
            </TabsTrigger>
            <TabsTrigger value="docs">Documentation</TabsTrigger>
            <TabsTrigger value="activity">Activity</TabsTrigger>
            <TabsTrigger value="notes">Notes & files</TabsTrigger>
          </TabsList>

          <TabsContent value="overview" className="mt-4">
            <div className="grid gap-4 xl:grid-cols-3">
              <Card>
                <CardHeader title="Company details" />
                <CardBody className="space-y-3 text-[13px]">
                  <LogoEditor
                    kind="company"
                    id={c.id}
                    name={c.name}
                    logoUpdatedAt={c.logoUpdatedAt}
                    disabled={!can('companies.write')}
                    onChanged={() => {
                      qc.invalidateQueries({ queryKey: ['company', id] });
                      qc.invalidateQueries({ queryKey: ['companies'] });
                    }}
                  />
                  {c.phone && (
                    <a href={`tel:${c.phone}`} className="flex items-center gap-2 hover:text-primary">
                      <Phone className="size-3.5 text-muted" /> {c.phone}
                    </a>
                  )}
                  {c.email && (
                    <a href={`mailto:${c.email}`} className="flex items-center gap-2 hover:text-primary">
                      <Mail className="size-3.5 text-muted" /> {c.email}
                    </a>
                  )}
                  {c.website && (
                    <a href={c.website.startsWith('http') ? c.website : `https://${c.website}`} target="_blank" rel="noreferrer noopener" className="flex items-center gap-2 hover:text-primary">
                      <Globe className="size-3.5 text-muted" /> {c.website}
                    </a>
                  )}
                  {address && (
                    <div className="flex items-start gap-2">
                      <MapPin className="mt-0.5 size-3.5 text-muted" /> {address}
                    </div>
                  )}
                  <dl className="grid grid-cols-2 gap-3 border-t border-border pt-3">
                    <Field label="Account manager">{c.accountManagerName}</Field>
                    <Field label="Default SLA">{c.defaultSlaName ?? 'System default'}</Field>
                    <Field label="Created">{fmtDate(c.createdAt)}</Field>
                    <Field label="Updated">{fmtRelative(c.updatedAt)}</Field>
                    <CustomFieldsView entity="company" value={c.customFields} />
                  </dl>
                </CardBody>
              </Card>
              <Card>
                <CardHeader title="Primary contact" />
                <CardBody className="text-[13px]">
                  {c.primaryContactId ? (
                    <div className="space-y-1.5">
                      <Link to={`/contacts/${c.primaryContactId}`} className="flex items-center gap-2 font-medium hover:text-primary">
                        <Avatar name={c.primaryContactName} /> {c.primaryContactName}
                      </Link>
                      {c.primaryContactEmail && <div className="text-muted">{c.primaryContactEmail}</div>}
                      {c.primaryContactPhone && <div className="text-muted">{c.primaryContactPhone}</div>}
                    </div>
                  ) : (
                    <p className="text-xs text-muted">No primary contact set.</p>
                  )}
                  <div className="mt-4 border-t border-border pt-3">
                    <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-subtle">Assigned technicians (open work)</div>
                    {(s?.technicians ?? []).length === 0 ? (
                      <p className="text-xs text-muted">No open assigned tickets.</p>
                    ) : (
                      <ul className="space-y-1.5">
                        {s!.technicians.map((t) => (
                          <li key={t.id} className="flex items-center gap-2">
                            <Avatar name={t.name} className="size-5 text-[9px]" />
                            <Link to={`/tickets?companyId=${id}&assignedUserId=${t.id}&statusCategory=open`} className="flex-1 hover:text-primary">
                              {t.name}
                            </Link>
                            <span className="text-xs text-muted">{t.open} open</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </CardBody>
              </Card>
              <Card>
                <CardHeader title="Active contracts" />
                <CardBody>
                  {(s?.contracts ?? []).length === 0 ? (
                    <p className="text-xs text-muted">No active contract. Work will be billed as time & materials.</p>
                  ) : (
                    <ul className="space-y-2 text-[13px]">
                      {s!.contracts.map((k) => (
                        <li key={k.id} className="flex items-center gap-2">
                          <Link to={`/contracts/${k.id}`} className="flex-1 truncate font-medium hover:text-primary">
                            {k.name}
                          </Link>
                          {k.isDefault && <Badge tone="primary">Default</Badge>}
                          <Badge>{CONTRACT_TYPE.labels[k.type as keyof typeof CONTRACT_TYPE.labels] ?? k.type}</Badge>
                        </li>
                      ))}
                    </ul>
                  )}
                  {c.notes && (
                    <div className="mt-4 border-t border-border pt-3">
                      <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-subtle">Notes</div>
                      <p className="prose-note text-[13px]">{c.notes}</p>
                    </div>
                  )}
                </CardBody>
              </Card>
            </div>
          </TabsContent>

          <TabsContent value="contacts" className="mt-4">
            <Card>
              <CardHeader
                title="Contacts"
                actions={
                  can('companies.write') && (
                    <Button size="sm" variant="primary" onClick={() => setAddContact(true)}>
                      <Plus /> Add contact
                    </Button>
                  )
                }
              />
              <CompanyContacts companyId={id} />
            </Card>
          </TabsContent>
          <TabsContent value="tickets" className="mt-4">
            <Card>
              <RelatedTickets filter={{ companyId: id }} />
            </Card>
          </TabsContent>
          <TabsContent value="cis" className="mt-4">
            <Card>
              <CardHeader
                title="Configuration items"
                actions={
                  can('cis.write') && (
                    <Button size="sm" onClick={() => navigate(`/assets?new=1&companyId=${id}`)}>
                      <Plus /> Add CI
                    </Button>
                  )
                }
              />
              <RelatedCis filter={{ companyId: id }} hide={['Company']} />
            </Card>
          </TabsContent>
          <TabsContent value="contracts" className="mt-4">
            <Card>
              <RelatedContracts companyId={id} />
            </Card>
          </TabsContent>
          <TabsContent value="projects" className="mt-4">
            <Card>
              <RelatedProjects companyId={id} />
            </Card>
          </TabsContent>
          <TabsContent value="locations" className="mt-4">
            <Card>
              <CompanyLocations companyId={id} />
            </Card>
          </TabsContent>
          <TabsContent value="docs" className="mt-4">
            <CompanyDocs companyId={id} canWrite={can('kb.write')} />
          </TabsContent>
          <TabsContent value="activity" className="mt-4">
            <ActivityFeed companyId={id} canWrite={can('companies.write')} />
          </TabsContent>
          <TabsContent value="notes" className="mt-4">
            <Card>
              <CardHeader title="Attachments" />
              <CardBody>
                <Attachments entityType="company" entityId={id} canWrite={can('companies.write')} />
              </CardBody>
            </Card>
          </TabsContent>
        </Tabs>
      </div>
      <CompanyFormDialog open={editing} onOpenChange={setEditing} company={c} />
      <ContactFormDialog open={addContact} onOpenChange={setAddContact} companyId={id} companyName={c.name} />
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={`Delete ${c.name}?`}
        description={me?.superAdmin ? "Records that still use it will be listed so you can confirm a force delete." : "Companies with tickets cannot be deleted; mark them inactive instead."}
        danger
        confirmLabel="Delete company"
        loading={remove.isPending}
        onConfirm={() => remove.mutate()}
      />
    </div>
  );
}

export interface ContactRow {
  id: number;
  firstName: string;
  lastName: string;
  title: string | null;
  department: string | null;
  email: string | null;
  phone: string | null;
  mobile: string | null;
  isActive: boolean;
  isPrimary: boolean;
  locationName: string | null;
  openTickets: number;
  ciCount: number;
}

export const contactColumns: Column<ContactRow & { companyName?: string; companyId?: number }>[] = [
  {
    header: 'Name',
    meta: { sortKey: 'name' },
    cell: ({ row }) => (
      <span className="flex items-center gap-2">
        <Avatar name={`${row.original.firstName} ${row.original.lastName}`} />
        <span>
          <Link to={`/contacts/${row.original.id}`} onClick={(e) => e.stopPropagation()} className="font-medium hover:text-primary">
            {row.original.firstName} {row.original.lastName}
          </Link>
          {row.original.isPrimary && (
            <Badge tone="primary" className="ml-1.5">
              Primary
            </Badge>
          )}
          {!row.original.isActive && <Badge className="ml-1.5">Inactive</Badge>}
          <span className="block text-[11px] text-muted">{[row.original.title, row.original.department].filter(Boolean).join(' · ')}</span>
        </span>
      </span>
    ),
  },
  { header: 'E-mail', meta: { sortKey: 'email' }, cell: ({ row }) => (row.original.email ? <a href={`mailto:${row.original.email}`} onClick={(e) => e.stopPropagation()} className="hover:text-primary">{row.original.email}</a> : '—') },
  { header: 'Phone', cell: ({ row }) => row.original.phone ?? row.original.mobile ?? '—' },
  { header: 'Location', cell: ({ row }) => row.original.locationName ?? '—' },
  { header: 'Devices', meta: { align: 'right' }, cell: ({ row }) => row.original.ciCount },
  { header: 'Open tickets', meta: { align: 'right', sortKey: 'openTickets' }, cell: ({ row }) => row.original.openTickets || <span className="text-subtle">0</span> },
];

interface DocRow {
  id: number;
  articleNumber: string;
  title: string;
  visibility: string;
  status: string;
  authorName: string | null;
  portalAuthorName: string | null;
  updatedAt: string;
}

/** Company documentation: pages written by the IT team and by the client (client portal). */
function CompanyDocs({ companyId, canWrite }: { companyId: number; canWrite: boolean }) {
  const navigate = useNavigate();
  const q = useQuery({ queryKey: ['kb-articles', 'company', companyId], queryFn: () => api.get<Paginated<DocRow>>('/kb/articles', { scope: 'docs', companyId, pageSize: 200 }) });
  const columns: Column<DocRow>[] = [
    {
      id: 'title',
      header: 'Title',
      cell: ({ row }) => (
        <Link to={`/kb/${row.original.id}`} onClick={(e) => e.stopPropagation()} className="font-medium text-primary hover:underline">
          {row.original.title}
        </Link>
      ),
    },
    {
      id: 'portal',
      header: 'Client portal',
      cell: ({ row }) =>
        row.original.portalAuthorName ? (
          <Badge tone="info">Written by the client</Badge>
        ) : row.original.visibility === 'public' && row.original.status === 'published' ? (
          <Badge tone="success">Visible</Badge>
        ) : (
          <Badge>Internal</Badge>
        ),
    },
    { id: 'author', header: 'Author', cell: ({ row }) => row.original.portalAuthorName ?? row.original.authorName ?? '—' },
    { id: 'updatedAt', header: 'Updated', cell: ({ row }) => fmtRelative(row.original.updatedAt) },
  ];
  return (
    <Card>
      <CardHeader
        title="Documentation"
        description="Pages marked Public are shown to this company in the client portal; clients can also add their own pages there."
        actions={
          canWrite && (
            <Button size="sm" variant="primary" onClick={() => navigate(`/kb/new?companyId=${companyId}`)}>
              <Plus /> New page
            </Button>
          )
        }
      />
      <DataTable columns={columns} data={q.data?.data} loading={q.isLoading} onRowClick={(r) => navigate(`/kb/${r.id}`)} empty="No documentation yet" />
    </Card>
  );
}

function CompanyContacts({ companyId }: { companyId: number }) {
  const navigate = useNavigate();
  const [page, setPage] = useState(1);
  const q = useQuery({ queryKey: ['contacts', 'company', companyId, page], queryFn: () => api.get<Paginated<ContactRow>>('/contacts', { companyId, page, pageSize: 50 }) });
  return <DataTable columns={contactColumns} data={q.data?.data} total={q.data?.total} page={page} pageSize={50} onPageChange={setPage} loading={q.isLoading} onRowClick={(r) => navigate(`/contacts/${r.id}`)} />;
}

function CompanyLocations({ companyId }: { companyId: number }) {
  const q = useQuery({
    queryKey: ['locations', 'company', companyId],
    queryFn: () => api.get<Paginated<{ id: number; name: string; address1: string | null; city: string | null; country: string | null; phone: string | null; isPrimary: boolean; isActive: boolean }>>('/locations', { companyId, pageSize: 100 }),
  });
  if (!q.data?.data.length) return <EmptyState icon={<MapPin />} title="No locations" description="Add locations from the Locations page." />;
  return (
    <ul className="divide-y divide-border">
      {q.data.data.map((l) => (
        <li key={l.id} className="flex items-center gap-3 px-4 py-2.5 text-[13px]">
          <MapPin className="size-4 text-muted" />
          <div className="flex-1">
            <div className="font-medium">
              {l.name} {l.isPrimary && <Badge tone="primary">Primary</Badge>} {!l.isActive && <Badge>Inactive</Badge>}
            </div>
            <div className="text-xs text-muted">{[l.address1, l.city, l.country].filter(Boolean).join(', ')}</div>
          </div>
          <span className="text-xs text-muted">{l.phone}</span>
        </li>
      ))}
    </ul>
  );
}

interface FeedItem {
  kind: 'activity' | 'ticket';
  id: number;
  subtype: string;
  title: string;
  body: string | null;
  at: string;
  actor: string | null;
  ticket_id: number | null;
  ticket_number: string | null;
  contact_name: string | null;
}

function ActivityFeed({ companyId, canWrite }: { companyId: number; canWrite: boolean }) {
  const qc = useQueryClient();
  const feed = useQuery({ queryKey: ['company', companyId, 'activity'], queryFn: () => api.get<{ data: FeedItem[] }>(`/companies/${companyId}/activity`, { limit: 100 }) });
  const [type, setType] = useState('note');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const add = useMutation({
    mutationFn: () => api.post('/activities', { companyId, type, subject, body }),
    onSuccess: () => {
      setSubject('');
      setBody('');
      toast.success('Activity logged');
      qc.invalidateQueries({ queryKey: ['company', companyId, 'activity'] });
    },
    onError: (e) => handleFormError(e),
  });
  return (
    <div className="grid gap-4 xl:grid-cols-[1fr_360px]">
      <Card>
        <CardHeader title="Activity" description="Logged calls, meetings and notes, plus ticket lifecycle events" />
        <ul className="divide-y divide-border">
          {(feed.data?.data ?? []).length === 0 && <li className="px-4 py-6 text-center text-xs text-muted">No activity yet.</li>}
          {feed.data?.data.map((f) => (
            <li key={`${f.kind}-${f.id}`} className="flex gap-3 px-4 py-2.5 text-[13px]">
              <span className="mt-0.5">{f.kind === 'ticket' ? <Ticket className="size-4 text-muted" /> : <MessageSquare className="size-4 text-primary" />}</span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  {f.kind === 'ticket' ? (
                    <TicketLink ticketId={f.ticket_id!} className="font-medium hover:text-primary">
                      <span className="font-mono text-xs text-muted">{f.ticket_number}</span> {f.title}
                    </TicketLink>
                  ) : (
                    <span className="font-medium">{f.title}</span>
                  )}
                  <Badge>{f.kind === 'ticket' ? f.subtype.replace(/_/g, ' ') : (ACTIVITY_TYPE.labels[f.subtype as keyof typeof ACTIVITY_TYPE.labels] ?? f.subtype)}</Badge>
                </div>
                {f.kind === 'activity' && f.body && <p className="prose-note mt-1 text-xs text-muted">{f.body}</p>}
                <div className="mt-0.5 text-[11px] text-subtle" title={fmtDateTime(f.at)}>
                  {f.actor ?? 'System'}
                  {f.contact_name ? ` · with ${f.contact_name}` : ''} · {fmtRelative(f.at)}
                </div>
              </div>
            </li>
          ))}
        </ul>
      </Card>
      {canWrite && (
        <Card className="h-fit">
          <CardHeader title="Log activity" />
          <CardBody className="space-y-2">
            <Select value={type} onChange={(e) => setType(e.target.value)} options={ACTIVITY_TYPE.values.map((v) => ({ value: v, label: ACTIVITY_TYPE.labels[v] }))} />
            <Input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Subject" />
            <Textarea rows={4} value={body} onChange={(e) => setBody(e.target.value)} placeholder="Details…" />
            <Button variant="primary" disabled={!subject.trim()} loading={add.isPending} onClick={() => add.mutate()}>
              Save
            </Button>
          </CardBody>
        </Card>
      )}
    </div>
  );
}
