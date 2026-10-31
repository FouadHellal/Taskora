import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Command } from 'cmdk';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { BookOpen, Building2, Contact, FileSignature, FolderKanban, HardDrive, Plus, Search, Ticket } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { flatNav } from './nav';
import { Spinner } from '../ui/misc';

interface Hit {
  type: string;
  id: number;
  title: string;
  subtitle: string | null;
  url: string;
}

const TYPE_ICON: Record<string, typeof Ticket> = {
  ticket: Ticket,
  company: Building2,
  contact: Contact,
  ci: HardDrive,
  article: BookOpen,
  contract: FileSignature,
  project: FolderKanban,
};
const TYPE_LABEL: Record<string, string> = {
  ticket: 'Tickets',
  company: 'Companies',
  contact: 'Contacts',
  ci: 'Configuration items',
  article: 'Knowledge base',
  contract: 'Contracts',
  project: 'Projects',
};

/** Ctrl/Cmd+K: global record search plus quick navigation and actions. */
export function CommandPalette({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const navigate = useNavigate();
  const { can } = useAuth();
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 180);
    return () => clearTimeout(t);
  }, [q]);
  useEffect(() => {
    if (!open) setQ('');
  }, [open]);

  const search = useQuery({
    queryKey: ['search', debounced],
    queryFn: () => api.get<{ data: Hit[] }>('/search', { q: debounced }),
    enabled: open && debounced.length >= 2,
    staleTime: 5_000,
  });

  const go = (url: string) => {
    onOpenChange(false);
    navigate(url);
  };

  const groups = (search.data?.data ?? []).reduce<Record<string, Hit[]>>((acc, h) => {
    (acc[h.type] ??= []).push(h);
    return acc;
  }, {});

  const pages = flatNav().filter((i) => !i.perm || can(i.perm));

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/40" />
        <DialogPrimitive.Content className="fixed left-1/2 top-[4dvh] sm:top-[12vh] z-50 w-[calc(100vw-2rem)] max-w-2xl -translate-x-1/2 overflow-hidden rounded-lg border border-border bg-surface shadow-2xl">
          <DialogPrimitive.Title className="sr-only">Search</DialogPrimitive.Title>
          <DialogPrimitive.Description className="sr-only">Search records or jump to a page</DialogPrimitive.Description>
          <Command shouldFilter={false} loop className="flex flex-col">
            <div className="flex items-center gap-2 border-b border-border px-3">
              <Search className="size-4 text-muted" />
              <Command.Input
                value={q}
                onValueChange={setQ}
                placeholder="Search by ticket number, title, company, contact, serial number…"
                className="h-11 flex-1 bg-transparent text-sm outline-none placeholder:text-subtle"
              />
              {search.isFetching && <Spinner />}
            </div>
            <Command.List className="max-h-[60dvh] overflow-y-auto p-1.5 scrollbar-thin">
              <Command.Empty className="px-3 py-6 text-center text-xs text-muted">{debounced.length >= 2 ? 'No results' : 'Type at least 2 characters'}</Command.Empty>
              {Object.entries(groups).map(([type, hits]) => {
                const Icon = TYPE_ICON[type] ?? Search;
                return (
                  <Command.Group key={type} heading={TYPE_LABEL[type] ?? type} className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:text-subtle">
                    {hits.map((h) => (
                      <Command.Item
                        key={`${h.type}-${h.id}`}
                        value={`${h.type}-${h.id}`}
                        onSelect={() => go(h.url)}
                        className="flex cursor-pointer items-center gap-2.5 rounded px-2 py-1.5 text-[13px] data-[selected=true]:bg-surface-2"
                      >
                        <Icon className="size-4 shrink-0 text-muted" />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate">{h.title}</span>
                          {h.subtitle && <span className="block truncate text-[11px] text-muted">{h.subtitle}</span>}
                        </span>
                      </Command.Item>
                    ))}
                  </Command.Group>
                );
              })}
              {debounced.length < 2 && (
                <>
                  {can('tickets.write') && (
                    <Command.Group heading="Actions" className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:text-subtle">
                      <Command.Item value="new-ticket" onSelect={() => go('/tickets/new')} className="flex cursor-pointer items-center gap-2.5 rounded px-2 py-1.5 text-[13px] data-[selected=true]:bg-surface-2">
                        <Plus className="size-4 text-muted" /> New ticket
                      </Command.Item>
                    </Command.Group>
                  )}
                  <Command.Group heading="Go to" className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:text-subtle">
                    {pages.map((p) => (
                      <Command.Item key={p.to} value={`page-${p.to}`} onSelect={() => go(p.to)} className="flex cursor-pointer items-center gap-2.5 rounded px-2 py-1.5 text-[13px] data-[selected=true]:bg-surface-2">
                        <p.icon className="size-4 text-muted" /> {p.label}
                      </Command.Item>
                    ))}
                  </Command.Group>
                </>
              )}
            </Command.List>
          </Command>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
