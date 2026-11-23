import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Copy, ExternalLink, KeyRound, Mail, ShieldOff } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { translate as t } from '@/lib/i18n';
import { fmtRelative } from '@/lib/utils';
import { Button } from '../ui/button';
import { Select } from '../ui/input';
import { Badge, Card, CardBody, CardHeader } from '../ui/misc';
import { handleFormError } from '../form';

export interface PortalContact {
  id: number;
  email: string | null;
  isPrimary?: boolean;
  portalEnabled?: boolean;
  portalLastLoginAt?: string | null;
  portalRole?: string | null;
  portalPasswordSet?: boolean;
}

export const PORTAL_ROLE_LABELS: Record<string, string> = {
  user: 'User — own tickets',
  manager: 'Company manager — all company tickets, work and contracts',
};

/** Staff control for a contact's client portal access (contact page). */
export function PortalAccessCard({ contact, canWrite }: { contact: PortalContact; canWrite: boolean }) {
  const qc = useQueryClient();
  const [password, setPassword] = useState<string | null>(null);
  const [role, setRole] = useState(contact.portalRole ?? 'user');
  const set = useMutation({
    mutationFn: (body: { enabled: boolean; resetPassword?: boolean; role?: string; sendInvite?: boolean }) =>
      api.post<{ enabled: boolean; password: string | null; invited: boolean }>(`/contacts/${contact.id}/portal`, body),
    onSuccess: (r) => {
      setPassword(r.password);
      toast.success(r.invited ? t('Invitation sent to {email}', { email: contact.email ?? '' }) : r.enabled ? t('Client portal access updated') : t('Client portal access disabled'));
      qc.invalidateQueries({ queryKey: ['contact', contact.id] });
      qc.invalidateQueries({ queryKey: ['portal-users'] });
    },
    onError: (e) => handleFormError(e),
  });
  const portalUrl = `${window.location.origin}/portal`;
  const pending = contact.portalEnabled && contact.portalPasswordSet === false;

  return (
    <Card>
      <CardHeader
        title="Client portal"
        actions={contact.portalEnabled ? pending ? <Badge tone="warning">Invitation pending</Badge> : <Badge tone="success">Enabled</Badge> : <Badge>Disabled</Badge>}
      />
      <CardBody className="space-y-3 text-[13px]">
        <p className="text-xs text-muted">{t('Lets this contact sign in at {url} to open requests, follow tickets, see the work done and edit the company documentation.', { url: portalUrl })}</p>
        {contact.portalEnabled && <p className="text-xs text-muted">{t('Last sign-in: {when}', { when: fmtRelative(contact.portalLastLoginAt, t('never')) })}</p>}
        {password && (
          <div className="rounded-md border border-warning/40 bg-warning-soft p-2.5 text-xs">
            <div className="mb-1 font-medium text-warning">{t('Share these sign-in details securely — the password is shown only once.')}</div>
            <div>
              {t('Portal')}: {portalUrl}
            </div>
            <div>
              {t('E-mail')}: {contact.email}
            </div>
            <div className="flex items-center gap-1">
              {t('Password')}: <code className="font-mono">{password}</code>
              <button
                className="cursor-pointer text-muted hover:text-foreground"
                onClick={() => {
                  navigator.clipboard?.writeText(`${portalUrl}\n${contact.email}\n${password}`);
                  toast.success(t('Copied'));
                }}
                aria-label={t('Copy sign-in details')}
              >
                <Copy className="size-3" />
              </button>
            </div>
          </div>
        )}
        {canWrite && (
          <div>
            <label className="mb-1 block text-xs font-medium text-muted">{t('Access level')}</label>
            <Select
              value={role}
              disabled={set.isPending}
              onChange={(e) => {
                setRole(e.target.value);
                if (contact.portalEnabled) set.mutate({ enabled: true, role: e.target.value });
              }}
            >
              {Object.entries(PORTAL_ROLE_LABELS).map(([k, v]) => (
                <option key={k} value={k}>
                  {t(v)}
                </option>
              ))}
            </Select>
            {contact.isPrimary && role === 'user' && <p className="mt-1 text-[11px] text-muted">{t('Primary contacts always see the whole company.')}</p>}
          </div>
        )}
        {canWrite && (
          <div className="flex flex-wrap gap-2">
            {contact.portalEnabled ? (
              <>
                <Button size="sm" onClick={() => set.mutate({ enabled: true, sendInvite: true })} loading={set.isPending && set.variables?.sendInvite}>
                  <Mail /> {pending ? 'Send the invitation again' : 'E-mail a password link'}
                </Button>
                <Button size="sm" onClick={() => set.mutate({ enabled: true, resetPassword: true })} loading={set.isPending && set.variables?.resetPassword}>
                  <KeyRound /> Generate a password
                </Button>
                <Button size="sm" variant="ghost" onClick={() => set.mutate({ enabled: false })}>
                  <ShieldOff /> Disable access
                </Button>
              </>
            ) : (
              <>
                <Button size="sm" variant="primary" disabled={!contact.email} onClick={() => set.mutate({ enabled: true, role, sendInvite: true })} loading={set.isPending && set.variables?.sendInvite}>
                  <Mail /> Invite by e-mail
                </Button>
                <Button size="sm" disabled={!contact.email} onClick={() => set.mutate({ enabled: true, role })} loading={set.isPending && !set.variables?.sendInvite}>
                  <KeyRound /> Grant access with a password
                </Button>
              </>
            )}
            <a href="/portal/login" target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 self-center text-xs text-primary hover:underline">
              {t('Open the portal')} <ExternalLink className="size-3" />
            </a>
          </div>
        )}
        {!contact.email && <p className="text-xs text-muted">{t('Add an e-mail address to enable portal access.')}</p>}
      </CardBody>
    </Card>
  );
}
