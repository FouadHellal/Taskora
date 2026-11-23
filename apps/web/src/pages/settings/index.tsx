import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  BookOpen,
  Building2,
  ClipboardList,
  Clock,
  Copy,
  CreditCard,
  DatabaseBackup,
  FileUp,
  Gauge,
  Globe2,
  HardDrive,
  KeyRound,
  Mail,
  MailPlus,
  Plug,
  Plus,
  ScrollText,
  Search,
  Send,
  Settings,
  SlidersHorizontal,
  Tags,
  Trash2,
  UserCog,
  Users,
  Webhook,
  Workflow,
  type LucideIcon,
} from 'lucide-react';
import { toast } from 'sonner';
import type { Permission } from '@taskora/shared';
import { api } from '@/lib/api';
import { LANGUAGES } from '@/lib/i18n';
import { useAuth } from '@/lib/auth';
import { opts, useLookups } from '@/lib/lookups';
import { cn, fmtDateTime, fmtRelative } from '@/lib/utils';
import { useTheme } from '@/hooks/use-theme';
import { PageHeader } from '@/components/page';
import { Button } from '@/components/ui/button';
import { Checkbox, Input, Select } from '@/components/ui/input';
import { Badge, Card, CardBody, CardHeader, EmptyState, PageLoader } from '@/components/ui/misc';
import { ConfirmDialog, Dialog, Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/overlays';
import { FormField, FormGrid, FormSection, handleFormError } from '@/components/form';
import { timezoneOptions } from '@/components/admin/timezones';
import { useTabParam } from '@/components/admin/tabs';
import { InboundEmailLog } from '@/components/admin/inbound-email';
import { EntityPicker } from '@/components/entity-picker';

const UI_LANGUAGES = LANGUAGES;

const CURRENCIES = [
  ['EUR', 'Euro (€)'],
  ['USD', 'US dollar ($)'],
  ['GBP', 'Pound sterling (£)'],
  ['CHF', 'Swiss franc (CHF)'],
  ['CAD', 'Canadian dollar (CA$)'],
  ['AUD', 'Australian dollar (A$)'],
  ['MAD', 'Moroccan dirham (MAD)'],
  ['DZD', 'Algerian dinar (DZD)'],
  ['TND', 'Tunisian dinar (TND)'],
  ['AED', 'UAE dirham (AED)'],
  ['SAR', 'Saudi riyal (SAR)'],
  ['SEK', 'Swedish krona (kr)'],
  ['NOK', 'Norwegian krone (kr)'],
  ['DKK', 'Danish krone (kr)'],
  ['PLN', 'Polish złoty (zł)'],
  ['CZK', 'Czech koruna (Kč)'],
  ['JPY', 'Japanese yen (¥)'],
  ['INR', 'Indian rupee (₹)'],
  ['BRL', 'Brazilian real (R$)'],
  ['ZAR', 'South African rand (R)'],
] as const;

const DATE_FORMATS = [
  ['auto', 'Automatic (follows the language)'],
  ['dd/MM/yyyy', '31/12/2026'],
  ['MM/dd/yyyy', '12/31/2026'],
  ['yyyy-MM-dd', '2026-12-31'],
  ['dd.MM.yyyy', '31.12.2026'],
] as const;

interface HubLink {
  title: string;
  description: string;
  to: string;
  icon: LucideIcon;
  perm?: Permission;
  keywords?: string;
}

const HUB: { section: string; links: HubLink[] }[] = [
  {
    section: 'You',
    links: [{ title: 'My preferences', description: 'Language, how tickets open, theme and time zone', to: '/settings?tab=me', icon: UserCog, keywords: 'language theme dark window popup' }],
  },
  {
    section: 'Organization',
    links: [
      { title: 'Regional & display', description: 'Currency, default language, date format, time zone, default tax rate', to: '/settings?tab=org', icon: Globe2, perm: 'settings.manage', keywords: 'currency euro dollar language date tax' },
      { title: 'General & numbering', description: 'Organization name, logo, address, ticket/CI/contract number prefixes, time rounding', to: '/admin/system', icon: Building2, perm: 'settings.manage', keywords: 'logo prefix invoice footer' },
      { title: 'Backup & Restore', description: 'Full backups, automatic schedule, restore', to: '/admin/backups', icon: DatabaseBackup, perm: 'backups.manage' },
      {
        title: 'Move to another server',
        description: 'Export everything (data, settings, users, API keys, files) and import it on a new server in one step',
        to: '/admin/backups',
        icon: DatabaseBackup,
        perm: 'backups.manage',
        keywords: 'migrate migration vps export import transfer',
      },
      { title: 'Users & roles', description: 'Accounts, technicians, roles and permissions', to: '/admin/users', icon: Users, perm: 'users.manage', keywords: 'permission admin' },
      {
        title: 'Client portal',
        description: 'Let client contacts sign in to open requests, follow tickets, see the work done and keep their documentation',
        to: '/admin/portal',
        icon: Building2,
        perm: 'companies.read',
        keywords: 'customer client portal access login self-service',
      },
      { title: 'Audit log', description: 'Who changed what and when', to: '/admin/audit', icon: ScrollText, perm: 'audit.read' },
    ],
  },
  {
    section: 'Service desk',
    links: [
      { title: 'Ticket settings', description: 'Statuses, priorities, ticket types, issue/sub-issue types, sources, queues, templates', to: '/admin/ticket-settings', icon: ClipboardList, perm: 'settings.manage', keywords: 'status priority queue issue type template' },
      { title: 'Custom fields & ticket tabs', description: 'Add your own fields to tickets, companies, contacts, CIs…; group them into custom tabs', to: '/admin/custom-fields', icon: Tags, perm: 'settings.manage', keywords: 'field tab udf' },
      { title: 'SLA policies', description: 'Response and resolution targets per priority', to: '/admin/system?tab=sla', icon: Gauge, perm: 'settings.manage' },
      { title: 'Business hours & holidays', description: 'Working days and hours used by SLA clocks', to: '/admin/system?tab=hours', icon: Clock, perm: 'settings.manage' },
      { title: 'Workflow rules', description: 'Automations: when a ticket is created/updated, do something', to: '/admin/workflows', icon: Workflow, perm: 'automation.manage', keywords: 'automation rule' },
      { title: 'Notification templates', description: 'E-mail texts sent to technicians and customers', to: '/admin/system?tab=templates', icon: Mail, perm: 'settings.manage' },
    ],
  },
  {
    section: 'Assets & billing',
    links: [
      { title: 'CI types', description: 'Configuration item (asset) types: laptops, servers, licences…', to: '/admin/system?tab=ci-types', icon: HardDrive, perm: 'settings.manage', keywords: 'asset type configuration item' },
      { title: 'Work types', description: 'Labour types and default hourly rates for time entries', to: '/admin/system?tab=work-types', icon: SlidersHorizontal, perm: 'settings.manage', keywords: 'rate hourly' },
      { title: 'Billing codes', description: 'Codes used on invoices and time', to: '/admin/system?tab=billing-codes', icon: CreditCard, perm: 'settings.manage' },
    ],
  },
  {
    section: 'E-mail & integrations',
    links: [
      { title: 'E-mail to ticket', description: 'Mailbox that turns incoming e-mail into tickets and replies into notes', to: '/settings?tab=email', icon: MailPlus, perm: 'settings.manage', keywords: 'imap inbound mailbox' },
      { title: 'Outgoing e-mail (SMTP)', description: 'Server used to send notifications and replies', to: '/admin/email', icon: Send, perm: 'settings.manage', keywords: 'smtp' },
      { title: 'API keys & webhooks', description: 'Connect n8n, Power Automate or scripts to Taskora', to: '/settings?tab=api', icon: Webhook, keywords: 'n8n zapier api token rest automation' },
      { title: 'Integrations', description: 'Action1, atlas and other connected tools', to: '/admin/integrations', icon: Plug, perm: 'integrations.read' },
      { title: 'Data import', description: 'Import companies, contacts, CIs and tickets from CSV (Autotask exports)', to: '/admin/import', icon: FileUp, perm: 'companies.write', keywords: 'csv autotask migrate' },
    ],
  },
  {
    section: 'Help',
    links: [{ title: 'Help & how-to guides', description: 'How to use every part of Taskora', to: '/help', icon: BookOpen, keywords: 'documentation guide manual' }],
  },
];

export default function SettingsPage() {
  const [tab, setTab] = useTabParam('overview');
  const { can } = useAuth();
  return (
    <div>
      <PageHeader title="Settings" icon={<Settings />} subtitle="Everything you can configure in Taskora, in one place" />
      <div className="p-4 sm:p-5">
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList>
            <TabsTrigger value="overview">All settings</TabsTrigger>
            <TabsTrigger value="me">My preferences</TabsTrigger>
            {can('settings.manage') && <TabsTrigger value="org">Regional & display</TabsTrigger>}
            {can('settings.manage') && <TabsTrigger value="email">E-mail to ticket</TabsTrigger>}
            <TabsTrigger value="api">API & webhooks</TabsTrigger>
          </TabsList>
          <TabsContent value="overview" className="mt-4">
            <Overview />
          </TabsContent>
          <TabsContent value="me" className="mt-4">
            <MyPreferences />
          </TabsContent>
          {can('settings.manage') && (
            <TabsContent value="org" className="mt-4">
              <Regional />
            </TabsContent>
          )}
          {can('settings.manage') && (
            <TabsContent value="email" className="mt-4">
              <EmailToTicket />
            </TabsContent>
          )}
          <TabsContent value="api" className="mt-4 space-y-4">
            <ApiKeys />
            {can('integrations.manage') && <Webhooks />}
            <ApiQuickStart />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}

/* --------------------------------------------------------------- overview */

function Overview() {
  const { can } = useAuth();
  const [q, setQ] = useState('');
  const needle = q.trim().toLowerCase();
  const sections = HUB.map((s) => ({
    ...s,
    links: s.links.filter((l) => (!l.perm || can(l.perm)) && (!needle || `${l.title} ${l.description} ${l.keywords ?? ''}`.toLowerCase().includes(needle))),
  })).filter((s) => s.links.length);
  return (
    <div className="space-y-5">
      <div className="relative max-w-md">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-subtle" />
        <Input className="pl-8" placeholder="Search settings (e.g. currency, queue, n8n)…" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
      </div>
      {sections.length === 0 && <EmptyState title="No setting matches your search" />}
      {sections.map((s) => (
        <section key={s.section}>
          <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-subtle">{s.section}</h2>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {s.links.map((l) => (
              <Link key={l.title} to={l.to} className="group flex gap-3 rounded-lg border border-border bg-surface p-3.5 transition hover:border-primary/50 hover:shadow-sm">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
                  <l.icon className="size-[18px]" />
                </span>
                <span className="min-w-0">
                  <span className="block text-[13px] font-semibold group-hover:text-primary">{l.title}</span>
                  <span className="block text-xs text-muted">{l.description}</span>
                </span>
              </Link>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

/* ---------------------------------------------------------- preferences */

function usePrefs() {
  const { me, refresh } = useAuth();
  const save = useMutation({
    mutationFn: (patch: Record<string, unknown>) => api.patch('/auth/preferences', patch),
    onSuccess: async () => {
      await refresh();
      toast.success('Preference saved');
    },
    onError: (e) => handleFormError(e),
  });
  return { prefs: me?.preferences ?? {}, me, save };
}

function MyPreferences() {
  const { prefs, me, save } = usePrefs();
  const { theme, setTheme } = useTheme();
  if (!me) return <PageLoader />;
  const orgWindow = me.organization.ticketsOpenInWindow !== false;
  const openMode = (prefs.ticketOpenMode as string | undefined) ?? '';
  return (
    <Card className="max-w-3xl">
      <CardBody className="space-y-6">
        <FormSection title="Language & region">
          <FormGrid cols={2}>
            <FormField label="Language" hint={`Organization default: ${UI_LANGUAGES.find((l) => l.code === (me.organization.language ?? 'en'))?.label ?? 'English'}`}>
              <Select
                value={String(prefs.language ?? '')}
                onChange={(e) => save.mutate({ language: e.target.value || null })}
                options={[{ value: '', label: 'Organization default' }, ...UI_LANGUAGES.map((l) => ({ value: l.code, label: l.label }))]}
              />
            </FormField>
            <FormField label="My time zone">
              <Select value={me.user.timezone} onChange={(e) => save.mutate({ timezone: e.target.value })} options={timezoneOptions(me.user.timezone)} />
            </FormField>
          </FormGrid>
        </FormSection>
        <FormSection title="Tickets">
          <FormField label="When I open a ticket" hint={`Organization default: ${orgWindow ? 'its own window' : 'the same window'}`}>
            <Select
              value={openMode}
              onChange={(e) => save.mutate({ ticketOpenMode: e.target.value || null })}
              options={[
                { value: '', label: 'Organization default' },
                { value: 'window', label: 'Open it in its own window (like Autotask)' },
                { value: 'same', label: 'Open it in the same window' },
              ]}
            />
          </FormField>
          <p className="text-xs text-muted">
            Tip: Ctrl/⌘-click or middle-click a ticket always opens a normal browser tab. On phones tickets always open in the same window. If nothing happens, allow pop-ups for this
            site in your browser.
          </p>
        </FormSection>
        <FormSection title="Appearance">
          <div className="flex flex-wrap gap-2">
            {(['light', 'dark', 'system'] as const).map((t) => (
              <Button key={t} variant={theme === t ? 'primary' : 'secondary'} onClick={() => setTheme(t)}>
                {t === 'light' ? 'Light' : t === 'dark' ? 'Dark' : 'Follow my device'}
              </Button>
            ))}
          </div>
        </FormSection>
        <FormSection title="Notifications">
          <Checkbox
            label="Send me e-mail notifications (assignments, customer replies, SLA warnings)"
            checked={prefs.emailNotifications !== false}
            onChange={(e) => save.mutate({ emailNotifications: e.target.checked })}
          />
        </FormSection>
      </CardBody>
    </Card>
  );
}

/* ------------------------------------------------------------- regional */

type SystemSettings = Record<string, unknown>;

function Regional() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['system-settings'], queryFn: () => api.get<SystemSettings>('/settings/system') });
  const [f, setF] = useState<SystemSettings>({});
  const [customCurrency, setCustomCurrency] = useState(false);
  useEffect(() => {
    if (!q.data) return;
    setF(q.data);
    setCustomCurrency(!CURRENCIES.some(([c]) => c === q.data.currency));
  }, [q.data]);
  const save = useMutation({
    mutationFn: () =>
      api.put('/settings/system', {
        currency: String(f.currency ?? 'EUR').toUpperCase(),
        language: f.language,
        dateFormat: f.dateFormat,
        timezone: f.timezone,
        ticketsOpenInWindow: !!f.ticketsOpenInWindow,
        defaultTaxRate: Number(f.defaultTaxRate ?? 0),
        timeRoundingMinutes: Number(f.timeRoundingMinutes ?? 1),
        requireTimeApproval: !!f.requireTimeApproval,
        invoicePaymentTermsDays: Number(f.invoicePaymentTermsDays ?? 30),
      }),
    onSuccess: () => {
      toast.success('Settings saved');
      qc.invalidateQueries({ queryKey: ['system-settings'] });
      qc.invalidateQueries({ queryKey: ['me'] });
    },
    onError: (e) => handleFormError(e),
  });
  if (!q.data) return <PageLoader />;
  const set = (k: string, v: unknown) => setF((p) => ({ ...p, [k]: v }));
  return (
    <Card className="max-w-3xl">
      <CardBody className="space-y-6">
        <FormSection title="Money">
          <FormGrid cols={2}>
            <FormField label="Currency" hint="Used for rates, contracts and new invoices. Existing invoices keep their own currency.">
              <Select
                value={customCurrency ? '__other' : String(f.currency ?? 'EUR')}
                onChange={(e) => {
                  if (e.target.value === '__other') setCustomCurrency(true);
                  else {
                    setCustomCurrency(false);
                    set('currency', e.target.value);
                  }
                }}
                options={[...CURRENCIES.map(([v, l]) => ({ value: v, label: `${v} — ${l}` })), { value: '__other', label: 'Other (ISO code)…' }]}
              />
            </FormField>
            {customCurrency && (
              <FormField label="ISO currency code" hint="Three letters, e.g. HUF, RON, XOF">
                <Input maxLength={3} value={String(f.currency ?? '')} onChange={(e) => set('currency', e.target.value.toUpperCase())} />
              </FormField>
            )}
            <FormField label="Default tax rate (%)" hint="Pre-filled on new invoices">
              <Input type="number" min={0} max={100} step="0.01" value={String(f.defaultTaxRate ?? 0)} onChange={(e) => set('defaultTaxRate', e.target.value)} />
            </FormField>
            <FormField label="Invoice payment terms (days)">
              <Input type="number" min={0} max={365} value={String(f.invoicePaymentTermsDays ?? 30)} onChange={(e) => set('invoicePaymentTermsDays', e.target.value)} />
            </FormField>
          </FormGrid>
        </FormSection>
        <FormSection title="Language & dates">
          <FormGrid cols={2}>
            <FormField label="Default language" hint="Users can still pick their own in My preferences">
              <Select value={String(f.language ?? 'en')} onChange={(e) => set('language', e.target.value)} options={UI_LANGUAGES.map((l) => ({ value: l.code, label: l.label }))} />
            </FormField>
            <FormField label="Date format">
              <Select value={String(f.dateFormat ?? 'auto')} onChange={(e) => set('dateFormat', e.target.value)} options={DATE_FORMATS.map(([v, l]) => ({ value: v, label: l }))} />
            </FormField>
            <FormField label="Organization time zone" hint="Used for SLAs, business hours and billing periods">
              <Select value={String(f.timezone ?? 'UTC')} onChange={(e) => set('timezone', e.target.value)} options={timezoneOptions(String(f.timezone ?? ''))} />
            </FormField>
          </FormGrid>
        </FormSection>
        <FormSection title="Tickets & time">
          <Checkbox label="Open tickets in their own window by default (users can change this for themselves)" checked={!!f.ticketsOpenInWindow} onChange={(e) => set('ticketsOpenInWindow', e.target.checked)} />
          <FormGrid cols={2}>
            <FormField label="Round time entries to (minutes)" hint="1 = no rounding">
              <Input type="number" min={1} max={60} value={String(f.timeRoundingMinutes ?? 1)} onChange={(e) => set('timeRoundingMinutes', e.target.value)} />
            </FormField>
          </FormGrid>
          <Checkbox label="Time entries need approval before they can be billed" checked={!!f.requireTimeApproval} onChange={(e) => set('requireTimeApproval', e.target.checked)} />
        </FormSection>
        <div className="flex justify-end">
          <Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>
            Save settings
          </Button>
        </div>
      </CardBody>
    </Card>
  );
}

/* ------------------------------------------------------- e-mail to ticket */

interface ImapState {
  enabled: boolean;
  host: string;
  port: number;
  secure: boolean;
  user: string;
  mailbox: string;
  useSmtpAccount: boolean;
  hasPassword: boolean;
  environmentConfigured: boolean;
  environmentHost: string | null;
  active: 'settings' | 'environment' | null;
}

function EmailToTicket() {
  const qc = useQueryClient();
  const lookups = useLookups();
  const q = useQuery({ queryKey: ['imap-settings'], queryFn: () => api.get<ImapState>('/settings/imap') });
  const sys = useQuery({ queryKey: ['system-settings'], queryFn: () => api.get<SystemSettings>('/settings/system') });
  const [f, setF] = useState<Partial<ImapState> & { password?: string }>({});
  const [routing, setRouting] = useState<{ inboundEmailCompanyId: number | null; inboundEmailQueueId: number | null }>({ inboundEmailCompanyId: null, inboundEmailQueueId: null });
  useEffect(() => q.data && setF({ ...q.data, password: undefined }), [q.data]);
  useEffect(() => {
    if (sys.data)
      setRouting({ inboundEmailCompanyId: (sys.data.inboundEmailCompanyId as number | null) ?? null, inboundEmailQueueId: (sys.data.inboundEmailQueueId as number | null) ?? null });
  }, [sys.data]);
  const save = useMutation({
    mutationFn: async () => {
      await api.put('/settings/imap', {
        enabled: !!f.enabled,
        host: f.host ?? '',
        port: Number(f.port ?? 993),
        secure: f.secure !== false,
        user: f.user ?? '',
        mailbox: f.mailbox || 'INBOX',
        useSmtpAccount: !!f.useSmtpAccount,
        ...(f.password !== undefined ? { password: f.password } : {}),
      });
      await api.put('/settings/system', routing);
    },
    onSuccess: () => {
      toast.success('E-mail to ticket saved');
      qc.invalidateQueries({ queryKey: ['imap-settings'] });
      qc.invalidateQueries({ queryKey: ['system-settings'] });
      qc.invalidateQueries({ queryKey: ['inbound-emails'] });
    },
    onError: (e) => handleFormError(e),
  });
  const test = useMutation({
    mutationFn: () => api.post<{ mailbox: string; messages: number; unseen: number }>('/settings/imap/test'),
    onSuccess: (r) => toast.success(`Connected to ${r.mailbox}: ${r.messages} messages, ${r.unseen} unread`),
    onError: (e) => handleFormError(e),
  });
  if (!q.data) return <PageLoader />;
  const d = q.data;
  const origin = window.location.origin;
  return (
    <div className="space-y-4">
      <Card className="max-w-3xl">
        <CardHeader
          title="Mailbox"
          description="Taskora checks this mailbox every minute. New e-mails become tickets; replies with the ticket number in the subject (e.g. [TKA-000142]) are added to that ticket as a note."
          actions={
            <Badge tone={d.active ? 'success' : 'neutral'}>{d.active === 'settings' ? 'Active' : d.active === 'environment' ? 'Active (from .env)' : 'Off'}</Badge>
          }
        />
        <CardBody className="space-y-5">
          {d.environmentConfigured && (
            <p className="rounded-md border border-border bg-surface-2 p-2.5 text-xs text-muted">
              A mailbox is also set in the server's .env file ({d.environmentHost}). Settings saved here take precedence when enabled.
            </p>
          )}
          <Checkbox label="Turn incoming e-mail into tickets" checked={!!f.enabled} onChange={(e) => setF({ ...f, enabled: e.target.checked })} />
          <div className="rounded-md border border-primary/30 bg-primary-soft/30 p-3">
            <Checkbox
              label="Use the same mailbox as outgoing e-mail (recommended)"
              checked={!!f.useSmtpAccount}
              onChange={(e) => setF({ ...f, useSmtpAccount: e.target.checked, ...(e.target.checked ? { host: '', port: 993, secure: true } : {}) })}
            />
            <p className="ml-6 mt-1 text-xs text-muted">
              One mailbox for everything: Taskora sends from the account of{' '}
              <Link to="/admin/email" className="text-primary hover:underline">
                Administration → E-mail
              </Link>{' '}
              and reads the replies from that same inbox with the same user and app password (Gmail: imap.gmail.com, filled in automatically). Clients simply answer the e-mails they receive and
              their reply lands in the ticket. In Gmail, IMAP is on by default.
            </p>
          </div>
          {!f.useSmtpAccount && (
          <FormGrid cols={3}>
            <FormField label="IMAP server">
              <Input value={f.host ?? ''} onChange={(e) => setF({ ...f, host: e.target.value })} placeholder="outlook.office365.com" />
            </FormField>
            <FormField label="Port">
              <Input type="number" value={String(f.port ?? 993)} onChange={(e) => setF({ ...f, port: Number(e.target.value) })} />
            </FormField>
            <FormField label="Folder">
              <Input value={f.mailbox ?? 'INBOX'} onChange={(e) => setF({ ...f, mailbox: e.target.value })} />
            </FormField>
            <FormField label="User name">
              <Input value={f.user ?? ''} onChange={(e) => setF({ ...f, user: e.target.value })} placeholder="support@yourcompany.com" autoComplete="off" />
            </FormField>
            <FormField label="Password / app password" hint={d.hasPassword ? 'Stored (encrypted). Leave empty to keep it.' : undefined}>
              <Input type="password" autoComplete="new-password" value={f.password ?? ''} onChange={(e) => setF({ ...f, password: e.target.value || undefined })} />
            </FormField>
            <FormField label="Security">
              <Select
                value={f.secure === false ? 'starttls' : 'tls'}
                onChange={(e) => setF({ ...f, secure: e.target.value === 'tls' })}
                options={[
                  { value: 'tls', label: 'SSL/TLS (port 993)' },
                  { value: 'starttls', label: 'STARTTLS / none (port 143)' },
                ]}
              />
            </FormField>
          </FormGrid>
          )}
          <FormSection title="Routing">
            <FormGrid cols={2}>
              <FormField label="Company for unknown senders" hint="Leave empty to reject e-mail from addresses that match no contact or company domain">
                <EntityPicker kind="company" value={routing.inboundEmailCompanyId} onChange={(v) => setRouting({ ...routing, inboundEmailCompanyId: v })} />
              </FormField>
              <FormField label="Queue for new e-mail tickets">
                <Select
                  value={String(routing.inboundEmailQueueId ?? '')}
                  onChange={(e) => setRouting({ ...routing, inboundEmailQueueId: e.target.value ? Number(e.target.value) : null })}
                  options={[{ value: '', label: 'No queue' }, ...opts(lookups.data?.queues)]}
                />
              </FormField>
            </FormGrid>
          </FormSection>
          <p className="text-xs text-muted">
            Microsoft 365 / Google Workspace: basic IMAP passwords are often disabled. Use an app password, or let n8n read the mailbox (OAuth) and post each message to Taskora —
            see below.
          </p>
          <div className="flex flex-wrap justify-end gap-2">
            <Button onClick={() => test.mutate()} loading={test.isPending} disabled={!d.active}>
              Test connection
            </Button>
            <Button variant="primary" onClick={() => save.mutate()} loading={save.isPending}>
              Save
            </Button>
          </div>
        </CardBody>
      </Card>

      <Card className="max-w-3xl">
        <CardHeader title="Or: send e-mails in with n8n / Power Automate" description="Any tool that can read a mailbox can create tickets through the API, with the same threading rules." />
        <CardBody className="space-y-2 text-[13px]">
          <ol className="list-decimal space-y-1 pl-5">
            <li>
              Create an API key in{' '}
              <Link className="text-primary hover:underline" to="/settings?tab=api">
                Settings → API & webhooks
              </Link>
              .
            </li>
            <li>In n8n add an e-mail trigger (IMAP, Microsoft Outlook or Gmail node).</li>
            <li>
              Add an <b>HTTP Request</b> node: <code className="rounded bg-surface-2 px-1">POST {origin}/api/v1/inbound/email</code>, header{' '}
              <code className="rounded bg-surface-2 px-1">Authorization: Bearer tka_…</code>, JSON body:
            </li>
          </ol>
          <CodeBlock
            code={`{
  "from": "{{ $json.from.value[0].address }}",
  "fromName": "{{ $json.from.value[0].name }}",
  "subject": "{{ $json.subject }}",
  "text": "{{ $json.text }}",
  "messageId": "{{ $json.messageId }}"
}`}
          />
        </CardBody>
      </Card>

      <InboundEmailLog />
    </div>
  );
}

/* ------------------------------------------------------------- API keys */

interface ApiKeyRow {
  id: number;
  name: string;
  prefix: string;
  owner: string;
  createdAt: string;
  lastUsedAt: string | null;
  lastUsedIp: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
}

function CodeBlock({ code }: { code: string }) {
  return (
    <div className="relative">
      <pre className="overflow-x-auto rounded-md border border-border bg-surface-2 p-3 font-mono text-[12px] leading-relaxed">{code}</pre>
      <Button
        size="icon-sm"
        variant="ghost"
        className="absolute right-1.5 top-1.5"
        aria-label="Copy"
        onClick={() => {
          navigator.clipboard?.writeText(code);
          toast.success('Copied');
        }}
      >
        <Copy />
      </Button>
    </div>
  );
}

function ApiKeys() {
  const qc = useQueryClient();
  const { can } = useAuth();
  const [all, setAll] = useState(false);
  const q = useQuery({ queryKey: ['api-keys', all], queryFn: () => api.get<{ data: ApiKeyRow[] }>('/api-keys', { all }) });
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [expires, setExpires] = useState('');
  const [token, setToken] = useState<string | null>(null);
  const [revoke, setRevoke] = useState<ApiKeyRow | null>(null);
  const create = useMutation({
    mutationFn: () => api.post<{ token: string }>('/api-keys', { name, expiresInDays: expires ? Number(expires) : null }),
    onSuccess: (r) => {
      setToken(r.token);
      setName('');
      setExpires('');
      qc.invalidateQueries({ queryKey: ['api-keys'] });
    },
    onError: (e) => handleFormError(e),
  });
  const del = useMutation({
    mutationFn: (id: number) => api.delete(`/api-keys/${id}`),
    onSuccess: () => {
      setRevoke(null);
      toast.success('API key revoked');
      qc.invalidateQueries({ queryKey: ['api-keys'] });
    },
    onError: (e) => handleFormError(e),
  });
  const rows = q.data?.data ?? [];
  return (
    <Card>
      <CardHeader
        title="API keys"
        description="A key lets n8n, scripts or other tools use the Taskora API as you, with your permissions. Treat it like a password."
        actions={
          <div className="flex items-center gap-2">
            {can('users.manage') && <Checkbox label="Everyone's keys" checked={all} onChange={(e) => setAll(e.target.checked)} />}
            <Button variant="primary" size="sm" onClick={() => setOpen(true)}>
              <Plus /> New API key
            </Button>
          </div>
        }
      />
      {rows.length === 0 ? (
        <p className="px-4 py-5 text-center text-xs text-muted">No API keys yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wide text-muted">
                <th className="px-4 py-2">Name</th>
                <th className="px-4 py-2">Key</th>
                {all && <th className="px-4 py-2">Owner</th>}
                <th className="px-4 py-2">Last used</th>
                <th className="px-4 py-2">Expires</th>
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody>
              {rows.map((k) => (
                <tr key={k.id} className={cn('border-t border-border', k.revokedAt && 'opacity-50')}>
                  <td className="px-4 py-1.5 font-medium">{k.name}</td>
                  <td className="px-4 py-1.5 font-mono text-xs">{k.prefix}…</td>
                  {all && <td className="px-4 py-1.5">{k.owner}</td>}
                  <td className="px-4 py-1.5 text-xs text-muted">{k.lastUsedAt ? `${fmtRelative(k.lastUsedAt)}${k.lastUsedIp ? ` · ${k.lastUsedIp}` : ''}` : 'Never'}</td>
                  <td className="px-4 py-1.5 text-xs text-muted">{k.revokedAt ? <Badge tone="danger">Revoked</Badge> : k.expiresAt ? fmtDateTime(k.expiresAt) : 'Never'}</td>
                  <td className="px-4 py-1.5 text-right">
                    {!k.revokedAt && (
                      <Button size="icon-sm" variant="ghost" aria-label="Revoke" onClick={() => setRevoke(k)}>
                        <Trash2 />
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Dialog
        open={open}
        onOpenChange={(o) => {
          setOpen(o);
          if (!o) setToken(null);
        }}
        title={token ? 'Copy your API key now' : 'New API key'}
        description={token ? 'This is the only time the full key is shown. Store it in n8n credentials or your password manager.' : undefined}
        footer={
          token ? (
            <Button variant="primary" onClick={() => (setOpen(false), setToken(null))}>
              Done
            </Button>
          ) : (
            <>
              <Button onClick={() => setOpen(false)}>Cancel</Button>
              <Button variant="primary" disabled={!name.trim()} loading={create.isPending} onClick={() => create.mutate()}>
                <KeyRound /> Create key
              </Button>
            </>
          )
        }
      >
        {token ? (
          <CodeBlock code={token} />
        ) : (
          <FormGrid cols={2}>
            <FormField label="Name" hint="What uses it, e.g. n8n">
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="n8n" />
            </FormField>
            <FormField label="Expires after">
              <Select
                value={expires}
                onChange={(e) => setExpires(e.target.value)}
                options={[
                  { value: '', label: 'Never' },
                  { value: '30', label: '30 days' },
                  { value: '90', label: '90 days' },
                  { value: '365', label: '1 year' },
                ]}
              />
            </FormField>
          </FormGrid>
        )}
      </Dialog>
      <ConfirmDialog
        open={!!revoke}
        onOpenChange={(o) => !o && setRevoke(null)}
        title={`Revoke “${revoke?.name}”?`}
        description="Anything using this key stops working immediately."
        confirmLabel="Revoke key"
        danger
        loading={del.isPending}
        onConfirm={() => revoke && del.mutate(revoke.id)}
      />
    </Card>
  );
}

/* ------------------------------------------------------------- webhooks */

interface WebhookRow {
  id: number;
  name: string;
  url: string;
  events: string[];
  isActive: boolean;
  signed: boolean;
  lastStatus: number | null;
  lastError: string | null;
  lastDeliveredAt: string | null;
}

function Webhooks() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['webhooks'], queryFn: () => api.get<{ data: WebhookRow[] }>('/webhooks') });
  const events = useQuery({ queryKey: ['webhook-events'], queryFn: () => api.get<{ data: { event: string; description: string }[] }>('/webhooks/events') });
  const [edit, setEdit] = useState<Partial<WebhookRow> | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [remove, setRemove] = useState<WebhookRow | null>(null);
  const done = (r: { secret?: string | null }) => {
    qc.invalidateQueries({ queryKey: ['webhooks'] });
    if (r.secret) setSecret(r.secret);
    else setEdit(null);
  };
  const save = useMutation({
    mutationFn: () => {
      const body = { name: edit!.name, url: edit!.url, events: edit!.events ?? [], isActive: edit!.isActive !== false };
      return edit!.id ? api.patch<{ secret?: string }>(`/webhooks/${edit!.id}`, body) : api.post<{ secret?: string }>('/webhooks', body);
    },
    onSuccess: done,
    onError: (e) => handleFormError(e),
  });
  const rotate = useMutation({
    mutationFn: (id: number) => api.patch<{ secret?: string }>(`/webhooks/${id}`, { secret: 'generate' }),
    onSuccess: done,
    onError: (e) => handleFormError(e),
  });
  const test = useMutation({
    mutationFn: (id: number) => api.post(`/webhooks/${id}/test`),
    onSuccess: () => {
      toast.success('Test event queued — it is sent within a few seconds');
      setTimeout(() => qc.invalidateQueries({ queryKey: ['webhooks'] }), 5000);
    },
    onError: (e) => handleFormError(e),
  });
  const del = useMutation({
    mutationFn: (id: number) => api.delete(`/webhooks/${id}`),
    onSuccess: () => {
      setRemove(null);
      qc.invalidateQueries({ queryKey: ['webhooks'] });
    },
  });
  const rows = q.data?.data ?? [];
  const all = useMemo(() => events.data?.data ?? [], [events.data]);
  const toggle = (ev: string) => {
    const cur = new Set(edit?.events ?? []);
    if (cur.has(ev)) cur.delete(ev);
    else cur.add(ev);
    setEdit({ ...edit, events: [...cur] });
  };
  return (
    <Card>
      <CardHeader
        title="Webhooks"
        description="Taskora sends a signed JSON POST to your URL when something happens — e.g. to an n8n “Webhook” trigger."
        actions={
          <Button variant="primary" size="sm" onClick={() => setEdit({ events: ['ticket.created'], isActive: true })}>
            <Plus /> New webhook
          </Button>
        }
      />
      {rows.length === 0 ? (
        <p className="px-4 py-5 text-center text-xs text-muted">No webhooks yet.</p>
      ) : (
        <ul className="divide-y divide-border">
          {rows.map((w) => (
            <li key={w.id} className="flex flex-wrap items-center gap-3 px-4 py-2.5 text-[13px]">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 font-medium">
                  {w.name} {!w.isActive && <Badge>Disabled</Badge>}
                  {w.lastStatus !== null && <Badge tone={w.lastError ? 'danger' : 'success'}>{w.lastError ? 'Failing' : `OK ${w.lastStatus}`}</Badge>}
                </div>
                <div className="truncate font-mono text-xs text-muted">{w.url}</div>
                <div className="text-xs text-subtle">
                  {w.events.join(', ')}
                  {w.lastDeliveredAt && ` · last sent ${fmtRelative(w.lastDeliveredAt)}`}
                </div>
                {w.lastError && <div className="truncate text-xs text-danger">{w.lastError}</div>}
              </div>
              <div className="flex gap-1">
                <Button size="sm" onClick={() => test.mutate(w.id)}>
                  Send test
                </Button>
                <Button size="sm" onClick={() => setEdit(w)}>
                  Edit
                </Button>
                <Button size="icon-sm" variant="ghost" aria-label="Delete webhook" onClick={() => setRemove(w)}>
                  <Trash2 />
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <Dialog
        open={!!edit}
        onOpenChange={(o) => {
          if (!o) {
            setEdit(null);
            setSecret(null);
          }
        }}
        title={secret ? 'Signing secret' : edit?.id ? 'Edit webhook' : 'New webhook'}
        description={secret ? 'Copy it now — it is shown once. Verify X-Taskora-Signature = sha256=HMAC_SHA256(secret, raw body).' : undefined}
        size="lg"
        footer={
          secret ? (
            <Button variant="primary" onClick={() => (setSecret(null), setEdit(null))}>
              Done
            </Button>
          ) : (
            <>
              {edit?.id && (
                <Button className="mr-auto" onClick={() => rotate.mutate(edit.id!)} loading={rotate.isPending}>
                  New signing secret
                </Button>
              )}
              <Button onClick={() => setEdit(null)}>Cancel</Button>
              <Button variant="primary" loading={save.isPending} disabled={!edit?.name || !edit?.url || !(edit?.events ?? []).length} onClick={() => save.mutate()}>
                Save
              </Button>
            </>
          )
        }
      >
        {secret ? (
          <CodeBlock code={secret} />
        ) : (
          edit && (
            <div className="space-y-4">
              <FormGrid cols={2}>
                <FormField label="Name">
                  <Input value={edit.name ?? ''} onChange={(e) => setEdit({ ...edit, name: e.target.value })} placeholder="n8n – new tickets" />
                </FormField>
                <FormField label="URL">
                  <Input value={edit.url ?? ''} onChange={(e) => setEdit({ ...edit, url: e.target.value })} placeholder="https://n8n.example.com/webhook/…" />
                </FormField>
              </FormGrid>
              <FormField label="Events">
                <div className="grid gap-1.5 sm:grid-cols-2">
                  <Checkbox label="Everything (*)" checked={(edit.events ?? []).includes('*')} onChange={() => toggle('*')} />
                  {all.map((e) => (
                    <label key={e.event} className="flex items-start gap-2 text-[13px]">
                      <input type="checkbox" className="mt-0.5" checked={(edit.events ?? []).includes(e.event)} onChange={() => toggle(e.event)} />
                      <span>
                        <code className="text-xs">{e.event}</code>
                        <span className="block text-xs text-muted">{e.description}</span>
                      </span>
                    </label>
                  ))}
                </div>
              </FormField>
              <Checkbox label="Active" checked={edit.isActive !== false} onChange={(e) => setEdit({ ...edit, isActive: e.target.checked })} />
            </div>
          )
        )}
      </Dialog>
      <ConfirmDialog
        open={!!remove}
        onOpenChange={(o) => !o && setRemove(null)}
        title={`Delete webhook “${remove?.name}”?`}
        confirmLabel="Delete"
        danger
        loading={del.isPending}
        onConfirm={() => remove && del.mutate(remove.id)}
      />
    </Card>
  );
}

function ApiQuickStart() {
  const origin = window.location.origin;
  return (
    <Card>
      <CardHeader title="Using the API" description="REST + JSON under /api/v1. Every page of Taskora uses the same API, so anything you can do in the UI can be automated." />
      <CardBody className="space-y-3 text-[13px]">
        <p>List your open tickets:</p>
        <CodeBlock code={`curl -H "Authorization: Bearer tka_YOUR_KEY" "${origin}/api/v1/tickets?statusCategory=open&pageSize=50"`} />
        <p>Create a ticket:</p>
        <CodeBlock
          code={`curl -X POST -H "Authorization: Bearer tka_YOUR_KEY" -H "Content-Type: application/json" \\
  -d '{"title":"Printer offline","companyId":1,"description":"Reported by phone"}' \\
  "${origin}/api/v1/tickets"`}
        />
        <p className="text-muted">
          In n8n use the <b>HTTP Request</b> node with “Header Auth” credentials (name <code>Authorization</code>, value <code>Bearer tka_…</code>). The full list of endpoints is in{' '}
          <code>docs/api.md</code> in the repository and the n8n guide in <code>docs/n8n.md</code>; see also{' '}
          <Link to="/help/api" className="text-primary hover:underline">
            Help → API & n8n
          </Link>
          .
        </p>
      </CardBody>
    </Card>
  );
}
