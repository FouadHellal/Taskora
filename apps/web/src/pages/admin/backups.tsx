import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArchiveRestore, DatabaseBackup, Download, HardDriveDownload, KeyRound, RotateCcw, Server, Trash2, Truck, Upload } from 'lucide-react';
import { toast } from 'sonner';
import { api, ApiError, downloadUrl, request } from '@/lib/api';
import { fmtDateTime, fmtRelative } from '@/lib/utils';
import { PageHeader } from '@/components/page';
import { Button } from '@/components/ui/button';
import { Checkbox, Input } from '@/components/ui/input';
import { Badge, Card, CardBody, CardHeader, PageLoader } from '@/components/ui/misc';
import { ConfirmDialog, Dialog } from '@/components/ui/overlays';
import { DataTable, type Column } from '@/components/data-table';
import { FormField, FormGrid, handleFormError } from '@/components/form';

interface BackupFile {
  name: string;
  sizeBytes: number;
  createdAt: string;
  kind: 'auto' | 'manual' | 'pre-restore' | 'migration';
}

interface BackupList {
  data: BackupFile[];
  directory: string;
  autoBackupEnabled: boolean;
  autoBackupIntervalHours: number;
  backupRetention: number;
}

interface RestoreResult {
  tables: number;
  rows: number;
  files: number;
  safetyBackup: string | null;
  migratedFrom?: string | null;
  skippedSecrets?: string[];
}

const KIND: Record<BackupFile['kind'], { label: string; tone: 'neutral' | 'info' | 'warning' }> = {
  manual: { label: 'Manual', tone: 'neutral' },
  auto: { label: 'Automatic', tone: 'info' },
  'pre-restore': { label: 'Before restore', tone: 'warning' },
  migration: { label: 'Migration package', tone: 'info' },
};

export function fmtBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** Restore target: a backup kept on the server, or an uploaded file. */
type RestoreSource = { kind: 'server'; name: string; migration?: boolean } | { kind: 'upload'; file: File; migration?: boolean };

export default function BackupsPage() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['backups'], queryFn: () => api.get<BackupList>('/admin/backups') });
  const [includeFiles, setIncludeFiles] = useState(true);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [restoring, setRestoring] = useState<RestoreSource | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const create = useMutation({
    mutationFn: () => api.post<BackupFile>('/admin/backups', { includeFiles }),
    onSuccess: (b) => {
      toast.success(`Backup ${b.name} saved on the server`);
      qc.invalidateQueries({ queryKey: ['backups'] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Backup failed'),
  });
  const remove = useMutation({
    mutationFn: (name: string) => api.delete(`/admin/backups/${encodeURIComponent(name)}`),
    onSuccess: () => {
      toast.success('Backup deleted');
      setDeleting(null);
      qc.invalidateQueries({ queryKey: ['backups'] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Delete failed'),
  });

  if (!q.data) return <PageLoader />;
  const d = q.data;
  const cols: Column<BackupFile>[] = [
    { header: 'Backup', cell: ({ row }) => <span className="font-mono text-[12px]">{row.original.name}</span> },
    { header: 'Type', cell: ({ row }) => <Badge tone={KIND[row.original.kind].tone}>{KIND[row.original.kind].label}</Badge> },
    { header: 'Created', cell: ({ row }) => <span title={fmtDateTime(row.original.createdAt)}>{fmtRelative(row.original.createdAt)}</span> },
    { header: 'Size', meta: { align: 'right' }, cell: ({ row }) => fmtBytes(row.original.sizeBytes) },
    {
      header: '',
      id: 'actions',
      meta: { align: 'right' },
      cell: ({ row }) => (
        <div className="flex justify-end gap-1">
          <Button size="sm" variant="ghost" onClick={() => downloadUrl(`/admin/backups/${encodeURIComponent(row.original.name)}`)}>
            <Download /> Download
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setRestoring({ kind: 'server', name: row.original.name, migration: row.original.kind === 'migration' })}>
            <RotateCcw /> {row.original.kind === 'migration' ? 'Import' : 'Restore'}
          </Button>
          <Button size="icon-sm" variant="ghost" onClick={() => setDeleting(row.original.name)} aria-label="Delete backup">
            <Trash2 />
          </Button>
        </div>
      ),
    },
  ];

  return (
    <div>
      <PageHeader title="Backup & Restore" icon={<DatabaseBackup />} subtitle="Full backups of all Taskora data: tickets, companies, contacts, assets, Action1 sync data, settings, users and files" />
      <div className="space-y-4 p-5">
        <MoveServer onImport={(file) => setRestoring({ kind: 'upload', file, migration: true })} />

        <Card>
          <CardHeader title="Create a backup" description="One compressed file with every table and, optionally, all uploaded attachments. Sessions and queued jobs are not included." />
          <CardBody className="space-y-4">
            <Checkbox label="Include uploaded files (attachments)" checked={includeFiles} onChange={(e) => setIncludeFiles(e.target.checked)} />
            <div className="flex flex-wrap gap-2">
              <Button variant="primary" loading={create.isPending} onClick={() => create.mutate()}>
                <HardDriveDownload /> Save backup on the server
              </Button>
              <Button onClick={() => downloadUrl('/admin/backups/export', { includeFiles: includeFiles ? 'true' : 'false' })}>
                <Download /> Download a backup now
              </Button>
              <Button variant="ghost" onClick={() => fileInput.current?.click()}>
                <Upload /> Restore from a file…
              </Button>
              <input
                ref={fileInput}
                type="file"
                accept=".gz,.json,application/gzip,application/json"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = '';
                  if (file) setRestoring({ kind: 'upload', file });
                }}
              />
            </div>
            <p className="text-xs text-muted">
              Server folder: <span className="font-mono">{d.directory}</span>. Stored passwords (Action1, SMTP, IMAP, webhook secrets) are encrypted with this server&apos;s <span className="font-mono">TASKORA_ENCRYPTION_KEY</span>. To move to another
              server, use <b>Move Taskora to another server</b> above so they keep working.
            </p>
          </CardBody>
        </Card>

        <AutoBackupSettings list={d} />

        <Card>
          <CardHeader title="Backups on the server" description={`${d.data.length} backup(s)`} />
          <DataTable columns={cols} data={d.data} loading={q.isLoading} empty={<p className="py-8 text-center text-xs text-muted">No backups yet.</p>} />
        </Card>
      </div>

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(o) => !o && setDeleting(null)}
        title="Delete this backup?"
        description={<span className="font-mono">{deleting}</span>}
        confirmLabel="Delete"
        danger
        loading={remove.isPending}
        onConfirm={() => deleting && remove.mutate(deleting)}
      />
      {restoring && (restoring.migration ? <MigrationImportDialog source={restoring} onClose={() => setRestoring(null)} /> : <RestoreDialog source={restoring} onClose={() => setRestoring(null)} />)}
    </div>
  );
}

function AutoBackupSettings({ list }: { list: BackupList }) {
  const qc = useQueryClient();
  const [f, setF] = useState({ autoBackupEnabled: list.autoBackupEnabled, autoBackupIntervalHours: list.autoBackupIntervalHours, backupRetention: list.backupRetention });
  useEffect(
    () => setF({ autoBackupEnabled: list.autoBackupEnabled, autoBackupIntervalHours: list.autoBackupIntervalHours, backupRetention: list.backupRetention }),
    [list.autoBackupEnabled, list.autoBackupIntervalHours, list.backupRetention],
  );
  const save = useMutation({
    mutationFn: () => api.put('/admin/backups/settings', f),
    onSuccess: () => {
      toast.success('Automatic backup settings saved');
      qc.invalidateQueries({ queryKey: ['backups'] });
    },
    onError: (e) => handleFormError(e),
  });
  const lastAuto = list.data.find((b) => b.kind === 'auto');
  return (
    <Card>
      <CardHeader title="Automatic backups" description="The background worker saves a backup on the server on this schedule and keeps only the newest ones. Manual backups are never deleted automatically." />
      <CardBody className="space-y-4">
        <Checkbox label="Create automatic backups" checked={f.autoBackupEnabled} onChange={(e) => setF({ ...f, autoBackupEnabled: e.target.checked })} />
        <FormGrid cols={3}>
          <FormField label="Every (hours)">
            <Input type="number" min={1} max={720} value={f.autoBackupIntervalHours} onChange={(e) => setF({ ...f, autoBackupIntervalHours: Number(e.target.value) })} />
          </FormField>
          <FormField label="Keep the last">
            <Input type="number" min={1} max={365} value={f.backupRetention} onChange={(e) => setF({ ...f, backupRetention: Number(e.target.value) })} />
          </FormField>
          <FormField label="Last automatic backup">
            <div className="flex h-8 items-center text-[13px]">{lastAuto ? `${fmtRelative(lastAuto.createdAt)} (${fmtBytes(lastAuto.sizeBytes)})` : 'None yet'}</div>
          </FormField>
        </FormGrid>
        <Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>
          Save
        </Button>
      </CardBody>
    </Card>
  );
}

function RestoreDialog({ source, onClose }: { source: RestoreSource; onClose: () => void }) {
  const [confirm, setConfirm] = useState('');
  const [safetyBackup, setSafetyBackup] = useState(true);
  const restore = useMutation({
    mutationFn: async () => {
      if (source.kind === 'server') return api.post<RestoreResult>(`/admin/backups/${encodeURIComponent(source.name)}/restore`, { confirm, safetyBackup });
      const fd = new FormData();
      fd.append('file', source.file, source.file.name);
      return request<RestoreResult>('POST', '/admin/backups/restore', fd, { query: { confirm, safetyBackup: safetyBackup ? 'true' : 'false' } });
    },
    onSuccess: (r) => {
      toast.success(`Restored ${r.rows} records and ${r.files} files. Please sign in again.`, { duration: 10000 });
      // Every session was cleared by the restore.
      setTimeout(() => window.location.assign('/login'), 1500);
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Restore failed', { duration: 10000 }),
  });
  const label = source.kind === 'server' ? source.name : `${source.file.name} (${fmtBytes(source.file.size)})`;
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && !restore.isPending && onClose()}
      title="Restore a backup"
      size="sm"
      footer={
        <>
          <Button onClick={onClose} disabled={restore.isPending}>
            Cancel
          </Button>
          <Button variant="danger" disabled={confirm !== 'RESTORE'} loading={restore.isPending} onClick={() => restore.mutate()}>
            <ArchiveRestore /> Replace all data
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-[13px]">
        <p>
          <b>All current data will be replaced</b> by <span className="break-all font-mono text-xs">{label}</span>. Everyone, including you, is signed out afterwards. The restore is all-or-nothing: if anything fails, nothing
          changes.
        </p>
        <Checkbox label="Save the current data as a backup first (recommended)" checked={safetyBackup} onChange={(e) => setSafetyBackup(e.target.checked)} />
        <FormField label="Type RESTORE to confirm">
          <Input value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="off" />
        </FormField>
      </div>
    </Dialog>
  );
}

/* ------------------------------------------------------- move to another server */

function MoveServer({ onImport }: { onImport: (file: File) => void }) {
  const qc = useQueryClient();
  const [pass, setPass] = useState('');
  const [pass2, setPass2] = useState('');
  const [busy, setBusy] = useState<'download' | 'save' | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const valid = pass.length >= 10 && pass === pass2;

  const run = async (save: boolean) => {
    setBusy(save ? 'save' : 'download');
    try {
      if (save) {
        const r = await api.post<{ name: string; sizeBytes: number; skipped: string[] }>('/admin/migration/export', { passphrase: pass, save: true });
        toast.success(`Migration package ${r.name} (${fmtBytes(r.sizeBytes)}) saved on the server`);
        if (r.skipped.length) toast.warning(`Unreadable secrets left empty: ${r.skipped.join(', ')}`, { duration: 15000 });
        qc.invalidateQueries({ queryKey: ['backups'] });
      } else {
        const res = await request<Response>('POST', '/admin/migration/export', { passphrase: pass, save: false }, { raw: true });
        const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? 'taskora-migration.json.gz';
        const blob = await res.blob();
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = name;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
        toast.success(`Downloaded ${name} (${fmtBytes(blob.size)})`);
      }
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : 'Export failed');
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card>
      <CardHeader
        title="Move Taskora to another server"
        description="Copy everything (tickets, companies, contacts, assets, contracts, invoices, time, projects, knowledge base, settings, users and roles, custom fields, workflows, e-mail settings, API keys, webhooks, integrations, logos and attachments) to a new Taskora server in one file."
      />
      <CardBody className="space-y-5 text-[13px]">
        <div className="grid gap-5 lg:grid-cols-2">
          <div className="space-y-3">
            <div className="flex items-center gap-2 font-semibold">
              <Truck className="size-4 text-primary" /> 1. On the old server: export
            </div>
            <p className="text-xs text-muted">
              Choose a passphrase. It protects the stored passwords inside the file (SMTP, IMAP, Action1, webhook secrets) so they keep working on the new server. You need it to import; it is
              not stored anywhere.
            </p>
            <FormGrid cols={2}>
              <FormField label="Passphrase" hint="At least 10 characters">
                <Input type="password" autoComplete="new-password" value={pass} onChange={(e) => setPass(e.target.value)} />
              </FormField>
              <FormField label="Repeat passphrase" error={pass2 && pass !== pass2 ? 'Does not match' : undefined}>
                <Input type="password" autoComplete="new-password" value={pass2} onChange={(e) => setPass2(e.target.value)} />
              </FormField>
            </FormGrid>
            <div className="flex flex-wrap gap-2">
              <Button variant="primary" disabled={!valid || !!busy} loading={busy === 'download'} onClick={() => run(false)}>
                <Download /> Download migration package
              </Button>
              <Button disabled={!valid || !!busy} loading={busy === 'save'} onClick={() => run(true)}>
                <Server /> Save it on this server
              </Button>
            </div>
          </div>
          <div className="space-y-3">
            <div className="flex items-center gap-2 font-semibold">
              <KeyRound className="size-4 text-primary" /> 2. On the new server: import
            </div>
            <p className="text-xs text-muted">
              Install Taskora on the new server, create a temporary administrator, open this page and import the file with the same passphrase. All data on the new server is replaced; afterwards
              everybody signs in with their accounts from the old server.
            </p>
            <Button onClick={() => fileInput.current?.click()}>
              <Upload /> Import migration package…
            </Button>
            <input
              ref={fileInput}
              type="file"
              accept=".gz,.json,application/gzip,application/json"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = '';
                if (file) onImport(file);
              }}
            />
            <p className="text-xs text-muted">
              Very large file? Copy it into the server backups folder and use <b>Import</b> in the list below, or the command line{' '}
              <span className="font-mono">node dist/cli/migration.js import &lt;file&gt; --yes</span>.
            </p>
          </div>
        </div>
        <p className="text-xs text-muted">
          Not included (set these on the new server): the <span className="font-mono">.env</span> file (domain, HTTPS, ports and its own encryption key), open sign-in sessions and old backups.
        </p>
      </CardBody>
    </Card>
  );
}

function MigrationImportDialog({ source, onClose }: { source: RestoreSource; onClose: () => void }) {
  const [passphrase, setPassphrase] = useState('');
  const [confirm, setConfirm] = useState('');
  const [safetyBackup, setSafetyBackup] = useState(true);
  const run = useMutation({
    mutationFn: async () => {
      if (source.kind === 'server') return api.post<RestoreResult>(`/admin/migration/import/${encodeURIComponent(source.name)}`, { passphrase, confirm, safetyBackup });
      const fd = new FormData();
      // The passphrase must come before the file in the multipart body.
      fd.append('passphrase', passphrase);
      fd.append('file', source.file, source.file.name);
      return request<RestoreResult>('POST', '/admin/migration/import', fd, { query: { confirm, safetyBackup: safetyBackup ? 'true' : 'false' } });
    },
    onSuccess: (r) => {
      toast.success(`Imported ${r.rows} records and ${r.files} files${r.migratedFrom ? ` from ${r.migratedFrom}` : ''}. Sign in with your account from the old server.`, { duration: 12000 });
      if (r.skippedSecrets?.length) toast.warning(`Re-enter these in Settings: ${r.skippedSecrets.join(', ')}`, { duration: 20000 });
      setTimeout(() => window.location.assign('/login'), 2500);
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Import failed', { duration: 10000 }),
  });
  const label = source.kind === 'server' ? source.name : `${source.file.name} (${fmtBytes(source.file.size)})`;
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && !run.isPending && onClose()}
      title="Import migration package"
      size="sm"
      footer={
        <>
          <Button onClick={onClose} disabled={run.isPending}>
            Cancel
          </Button>
          <Button variant="danger" disabled={confirm !== 'RESTORE' || passphrase.length < 10} loading={run.isPending} onClick={() => run.mutate()}>
            <ArchiveRestore /> Import and replace all data
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-[13px]">
        <p>
          <b>All data on this server will be replaced</b> by <span className="break-all font-mono text-xs">{label}</span>, including users, settings and integrations. Everyone, including you, is
          signed out afterwards. If anything fails (for example a wrong passphrase), nothing changes.
        </p>
        <FormField label="Passphrase used for the export">
          <Input type="password" autoComplete="off" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} />
        </FormField>
        <Checkbox label="Save the current data as a backup first (recommended)" checked={safetyBackup} onChange={(e) => setSafetyBackup(e.target.checked)} />
        <FormField label="Type RESTORE to confirm">
          <Input value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="off" />
        </FormField>
        {run.isPending && <p className="text-xs text-muted">Importing… large installations can take a few minutes. Keep this page open.</p>}
      </div>
    </Dialog>
  );
}
