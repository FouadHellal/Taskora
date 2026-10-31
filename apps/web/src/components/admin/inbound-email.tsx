import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api, type Paginated } from '@/lib/api';
import { fmtDateTime } from '@/lib/utils';
import { Badge, Card, CardHeader } from '../ui/misc';

interface InboundRow {
  id: number;
  fromAddress: string;
  fromName: string | null;
  subject: string | null;
  status: string;
  ticketId: number | null;
  detail: string | null;
  receivedAt: string;
}

const TONE: Record<string, 'success' | 'info' | 'warning' | 'danger'> = { created: 'success', appended: 'info', rejected: 'warning', failed: 'danger' };

/** Mail channel status and the latest processed inbound messages. */
export function InboundEmailLog() {
  const q = useQuery({
    queryKey: ['inbound-emails'],
    queryFn: () => api.get<Paginated<InboundRow> & { imapConfigured: boolean; smtpConfigured: boolean }>('/inbound-emails', { pageSize: 25 }),
  });
  const d = q.data;
  return (
    <Card>
      <CardHeader
        title="E-mail channel"
        description="Configured with the IMAP_* and SMTP_* environment variables (see docs/deployment.md)"
        actions={
          <>
            <Badge tone={d?.imapConfigured ? 'success' : 'neutral'}>Inbound {d?.imapConfigured ? 'on' : 'off'}</Badge>
            <Badge tone={d?.smtpConfigured ? 'success' : 'neutral'}>Outbound {d?.smtpConfigured ? 'on' : 'off'}</Badge>
          </>
        }
      />
      {(d?.data ?? []).length === 0 ? (
        <p className="px-4 py-5 text-center text-xs text-muted">No inbound e-mail processed yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wide text-muted">
                <th className="px-4 py-2">Received</th>
                <th className="px-4 py-2">From</th>
                <th className="px-4 py-2">Subject</th>
                <th className="px-4 py-2">Result</th>
              </tr>
            </thead>
            <tbody>
              {d!.data.map((r) => (
                <tr key={r.id} className="border-t border-border">
                  <td className="whitespace-nowrap px-4 py-1.5 text-xs">{fmtDateTime(r.receivedAt)}</td>
                  <td className="px-4 py-1.5">{r.fromName ? `${r.fromName} <${r.fromAddress}>` : r.fromAddress}</td>
                  <td className="px-4 py-1.5 text-muted">{r.subject}</td>
                  <td className="px-4 py-1.5">
                    <Badge tone={TONE[r.status] ?? 'info'} title={r.detail ?? undefined}>
                      {r.status}
                    </Badge>{' '}
                    {r.ticketId && (
                      <Link to={`/tickets/${r.ticketId}`} className="text-xs text-primary hover:underline">
                        ticket
                      </Link>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
