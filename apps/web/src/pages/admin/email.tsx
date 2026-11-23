import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Mail, Send, ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';
import { api, ApiError } from '@/lib/api';
import { useMe } from '@/lib/auth';
import { PageHeader } from '@/components/page';
import { Button } from '@/components/ui/button';
import { Checkbox, Input, Textarea } from '@/components/ui/input';
import { Badge, Card, CardBody, CardHeader, PageLoader } from '@/components/ui/misc';
import { FormField, FormGrid, FormSection, handleFormError } from '@/components/form';
import { InboundEmailLog } from '@/components/admin/inbound-email';

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
              <FormField label="Signature" hint="Appended to e-mails sent from tickets and test e-mails">
                <Textarea rows={4} value={f.signature} onChange={(e) => set('signature', e.target.value)} placeholder={'Kind regards,\nThe support team'} />
              </FormField>
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
        <InboundEmailLog />
      </div>
    </div>
  );
}
