import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Mail, Palette, Save, Send, ShieldCheck, Wand2 } from 'lucide-react';
import { toast } from 'sonner';
import { api, ApiError } from '@/lib/api';
import { useMe } from '@/lib/auth';
import { PageHeader } from '@/components/page';
import { Button } from '@/components/ui/button';
import { Checkbox, Input, Textarea } from '@/components/ui/input';
import { Badge, Card, CardBody, CardHeader, PageLoader } from '@/components/ui/misc';
import { FormField, FormGrid, FormSection, handleFormError } from '@/components/form';
import { InboundEmailLog } from '@/components/admin/inbound-email';
import { LogoEditor } from '@/components/logo';

interface MailSettings {
  enabled: boolean;
  host: string;
  port: number;
  secure: boolean;
  user: string;
  hasPassword: boolean;
  passwordError: string | null;
  from: string;
  replyTo: string;
  signature: string;
  environment: { host: string; port: number; from: string } | null;
  effectiveSource: 'settings' | 'environment' | null;
}

export default function EmailSettingsPage() {
  const qc = useQueryClient();
  const me = useMe();
  const q = useQuery({ queryKey: ['email-settings'], queryFn: () => api.get<MailSettings>('/settings/email') });
  const [f, setF] = useState({ enabled: false, host: '', port: 587, secure: false, user: '', password: '', from: '', replyTo: '', signature: '' });
  const [testTo, setTestTo] = useState(me.user.email);
  useEffect(() => {
    if (q.data) setF({ enabled: q.data.enabled, host: q.data.host, port: q.data.port, secure: q.data.secure, user: q.data.user, password: '', from: q.data.from, replyTo: q.data.replyTo, signature: q.data.signature });
  }, [q.data]);
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }));

  const save = useMutation({
    mutationFn: (clearPassword?: boolean) => api.put<MailSettings>('/settings/email', { ...f, password: clearPassword ? '' : f.password || undefined }),
    onSuccess: () => {
      toast.success('E-mail settings saved');
      qc.invalidateQueries({ queryKey: ['email-settings'] });
      qc.invalidateQueries({ queryKey: ['me'] });
      qc.invalidateQueries({ queryKey: ['inbound-emails'] });
    },
    onError: (e) => handleFormError(e),
  });
  const test = useMutation({
    mutationFn: () => api.post<{ ok: boolean }>('/settings/email/test', { to: testTo }),
    onSuccess: () => toast.success(`Test e-mail sent to ${testTo}`),
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Test failed', { duration: 10000 }),
  });

  if (!q.data) return <PageLoader />;
  const d = q.data;
  return (
    <div>
      <PageHeader title="E-mail" icon={<Mail />} subtitle="Outgoing mail for notifications, customer replies and e-mails sent from tickets" />
      <div className="space-y-4 p-5">
        <Card>
          <CardHeader
            title={
              <span className="flex items-center gap-2">
                Outgoing mail (SMTP)
                {d.effectiveSource === 'settings' && <Badge tone="success">Active — these settings</Badge>}
                {d.effectiveSource === 'environment' && <Badge tone="info">Active — server environment (SMTP_*)</Badge>}
                {!d.effectiveSource && <Badge>Not configured</Badge>}
              </span>
            }
            description="Settings saved here take precedence over the SMTP_* variables in .env. The password is encrypted at rest."
          />
          <CardBody className="space-y-5">
            {d.environment && !f.enabled && (
              <p className="rounded-md bg-info-soft px-3 py-2 text-xs text-info">
                The server environment provides SMTP via {d.environment.host}:{d.environment.port} as {d.environment.from}. Enable the settings below to override it.
              </p>
            )}
            {d.passwordError && <p className="rounded-md bg-warning-soft px-3 py-2 text-xs text-warning">{d.passwordError} — re-enter the password.</p>}
            <Checkbox label="Send e-mail with these settings" checked={f.enabled} onChange={(e) => set('enabled', e.target.checked)} />
            <div className="rounded-md border border-border bg-surface-2 px-3 py-2.5 text-xs">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">Gmail / Google Workspace:</span>
                <span className="text-muted">host smtp.gmail.com · port 587 · TLS unticked (STARTTLS) · user = the full Gmail address · password = an app password · From = the same address.</span>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setF((x) => ({ ...x, enabled: true, host: 'smtp.gmail.com', port: 587, secure: false, from: x.from || x.user, user: x.user }))}
                >
                  Use Gmail settings
                </Button>
              </div>
              <p className="mt-1 text-muted">
                Google does not accept the normal password: turn on 2-Step Verification for the account, then create an app password at myaccount.google.com/apppasswords and paste its 16 letters here.
              </p>
            </div>
            <FormSection title="Server">
              <FormGrid cols={3}>
                <FormField label="SMTP host" required={f.enabled}>
                  <Input value={f.host} onChange={(e) => set('host', e.target.value)} placeholder="smtp.office365.com" autoComplete="off" />
                </FormField>
                <FormField label="Port" hint="587 = STARTTLS, 465 = TLS, 25 = relay">
                  <Input type="number" min={1} max={65535} value={f.port} onChange={(e) => set('port', Number(e.target.value))} />
                </FormField>
                <FormField label="Encryption">
                  <div className="flex h-8 items-center">
                    <Checkbox label="Implicit TLS (usually port 465)" checked={f.secure} onChange={(e) => set('secure', e.target.checked)} />
                  </div>
                </FormField>
                <FormField label="Username" hint="Leave empty for an unauthenticated relay">
                  <Input value={f.user} onChange={(e) => set('user', e.target.value)} autoComplete="off" />
                </FormField>
                <FormField label="Password" hint={d.hasPassword ? 'Stored — leave empty to keep it' : undefined}>
                  <Input type="password" value={f.password} onChange={(e) => set('password', e.target.value)} placeholder={d.hasPassword ? '•••••••• stored' : ''} autoComplete="new-password" />
                </FormField>
              </FormGrid>
            </FormSection>
            <FormSection title="Sender">
              <FormGrid cols={2}>
                <FormField label="From" required={f.enabled} hint='e.g. "Helpdesk <support@example.com>" — must be allowed by your mail server'>
                  <Input value={f.from} onChange={(e) => set('from', e.target.value)} />
                </FormField>
                <FormField label="Reply-To" hint="Optional — point replies at the mailbox Taskora reads (IMAP) so they thread into tickets">
                  <Input value={f.replyTo} onChange={(e) => set('replyTo', e.target.value)} />
                </FormField>
              </FormGrid>

            </FormSection>
            <div className="flex flex-wrap items-end gap-2 border-t border-border pt-4">
              <Button variant="primary" loading={save.isPending} onClick={() => save.mutate(false)}>
                Save settings
              </Button>
              {d.hasPassword && (
                <Button variant="ghost" onClick={() => save.mutate(true)}>
                  Remove stored password
                </Button>
              )}
              <div className="ml-auto flex items-end gap-2">
                <FormField label="Send a test to">
                  <Input value={testTo} onChange={(e) => setTestTo(e.target.value)} className="w-64" />
                </FormField>
                <Button loading={test.isPending} disabled={!d.effectiveSource} onClick={() => test.mutate()}>
                  <Send /> Send test
                </Button>
              </div>
            </div>
            <div className="flex items-start gap-2 rounded-md bg-surface-2 px-3 py-2 text-xs text-muted">
              <ShieldCheck className="mt-0.5 size-4 shrink-0" />
              Technicians send e-mail from a ticket with <b className="mx-1">Send e-mail</b> in the ticket header. Each message is kept on the ticket as a customer-visible note, and the ticket number in the
              subject threads the customer's reply back into the ticket when inbound e-mail (IMAP) is configured.
            </div>
          </CardBody>
        </Card>
        <EmailLookCard signature={f.signature} onSignature={(v) => set('signature', v)} onSaveSignature={() => save.mutateAsync(false)} />
        <InboundEmailLog />
      </div>
    </div>
  );
}

interface LookSettings {
  emailHeaderColor: string;
  emailAccentColor: string;
  emailFooter: string;
  emailLogoUpdatedAt: string | null;
  organizationName: string;
}

/** A starting point for an HTML signature; {{…}} are filled in when the e-mail is sent. */
const SIGNATURE_TEMPLATE = `<table cellpadding="0" cellspacing="0" style="font-family:Arial,Helvetica,sans-serif;color:#334155">
  <tr>
    <td style="padding-right:16px;vertical-align:middle"><img src="{{logo}}" alt="{{organization}}" height="48" style="display:block;height:48px"></td>
    <td style="border-left:2px solid #2563eb;padding-left:16px;vertical-align:middle">
      <div style="font-size:15px;font-weight:bold;color:#0f172a">{{sender}}</div>
      <div style="font-size:13px;color:#64748b">Support — {{organization}}</div>
      <div style="font-size:13px;margin-top:6px">+00 000 00 00 · <a href="mailto:support@example.com" style="color:#2563eb;text-decoration:none">support@example.com</a></div>
      <div style="font-size:13px"><a href="{{portal}}" style="color:#2563eb;text-decoration:none">Client portal</a></div>
    </td>
  </tr>
</table>`;

function EmailLookCard({ signature, onSignature, onSaveSignature }: { signature: string; onSignature: (v: string) => void; onSaveSignature: () => Promise<unknown> }) {
  const qc = useQueryClient();
  const sys = useQuery({ queryKey: ['system-settings'], queryFn: () => api.get<LookSettings & Record<string, unknown>>('/settings/system') });
  const [look, setLook] = useState<{ emailHeaderColor: string; emailAccentColor: string; emailFooter: string } | null>(null);
  const [html, setHtml] = useState('');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (sys.data && !look) setLook({ emailHeaderColor: sys.data.emailHeaderColor, emailAccentColor: sys.data.emailAccentColor, emailFooter: sys.data.emailFooter });
  }, [sys.data, look]);
  // Live preview of a client e-mail with the unsaved look and signature.
  useEffect(() => {
    if (!look) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      api
        .post<{ html: string }>('/settings/email/preview', { signature, headerColor: look.emailHeaderColor, accentColor: look.emailAccentColor, footer: look.emailFooter })
        .then((r) => setHtml(r.html))
        .catch(() => null);
    }, 400);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [look, signature, sys.data?.emailLogoUpdatedAt]);
  const save = useMutation({
    mutationFn: async () => {
      await api.put('/settings/system', look);
      await onSaveSignature();
    },
    onSuccess: () => {
      toast.success('E-mail look and signature saved');
      qc.invalidateQueries({ queryKey: ['system-settings'] });
    },
    onError: (e) => handleFormError(e),
  });
  if (!sys.data || !look) return null;
  const valid = (v: string) => /^#[0-9a-fA-F]{6}$/.test(v);
  const colour = (key: 'emailHeaderColor' | 'emailAccentColor', label: string, hint: string) => (
    <FormField label={label} hint={hint}>
      <div className="flex items-center gap-2">
        <input
          type="color"
          value={valid(look[key]) ? look[key] : '#000000'}
          onChange={(e) => setLook({ ...look, [key]: e.target.value })}
          className="h-8 w-10 cursor-pointer rounded border border-border bg-transparent p-0.5"
          aria-label={label}
        />
        <Input value={look[key]} onChange={(e) => setLook({ ...look, [key]: e.target.value })} className="w-28 font-mono" maxLength={7} />
      </div>
    </FormField>
  );
  return (
    <Card>
      <CardHeader
        title={
          <span className="inline-flex items-center gap-1.5">
            <Palette className="size-4 text-primary" /> Look of the e-mails and signature
          </span>
        }
        description="Every e-mail (ticket e-mails, client notifications, IT alerts, invitations) uses this logo, these colours and this signature."
      />
      <CardBody className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
        <div className="space-y-4">
          <FormField
            label="E-mail logo"
            hint="Shown in the header of every e-mail and usable in the signature. Use a version that reads well on the header colour. Without one, the organization logo is used."
          >
            <LogoEditor
              kind="email"
              maxSize={600}
              previewBg={valid(look.emailHeaderColor) ? look.emailHeaderColor : undefined}
              logoUpdatedAt={sys.data.emailLogoUpdatedAt}
              onChanged={() => qc.invalidateQueries({ queryKey: ['system-settings'] })}
            />
          </FormField>
          <FormGrid cols={2}>
            {colour('emailHeaderColor', 'Header colour', 'Behind the logo')}
            {colour('emailAccentColor', 'Accent colour', 'Buttons, links and highlights')}
          </FormGrid>
          <FormField label="Footer line" hint="Optional: address, company number, legal text.">
            <Input value={look.emailFooter} onChange={(e) => setLook({ ...look, emailFooter: e.target.value })} />
          </FormField>
          <FormField
            label="Signature"
            hint={
              <>
                Plain text or HTML (tables and inline styles; scripts are removed). Variables: <code>{'{{sender}}'}</code> the technician (or the team for automatic e-mails),{' '}
                <code>{'{{organization}}'}</code>, <code>{'{{logo}}'}</code> the e-mail logo address, <code>{'{{portal}}'}</code> the client portal address.
              </>
            }
          >
            <Textarea rows={12} value={signature} onChange={(e) => onSignature(e.target.value)} className="font-mono text-xs" placeholder={'Kind regards,\n{{sender}}\n{{organization}}'} />
          </FormField>
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>
              <Save /> Save look and signature
            </Button>
            {!signature.trim() && (
              <Button variant="ghost" onClick={() => onSignature(SIGNATURE_TEMPLATE)}>
                <Wand2 /> Start from a template
              </Button>
            )}
          </div>
        </div>
        <div>
          <div className="mb-1.5 text-[12px] font-medium text-muted">Preview — confirmation e-mail to a client</div>
          <iframe title="E-mail preview" sandbox="" srcDoc={html} className="h-[720px] w-full rounded-md border border-border bg-white" />
        </div>
      </CardBody>
    </Card>
  );
}
