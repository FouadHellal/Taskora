import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Building2, Mail, MapPin, Pencil, Phone, Smartphone, Ticket, Trash2, UserRound } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { fmtDate } from '@/lib/utils';
import { PageHeader } from '@/components/page';
import { Button } from '@/components/ui/button';
import { Badge, Card, CardBody, CardHeader, EmptyState, Field, PageLoader } from '@/components/ui/misc';
import { ConfirmDialog, Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/overlays';
import { ContactFormDialog, type ContactRecord } from '@/components/forms/contact-form';
import { CustomFieldsView } from '@/components/custom-fields';
import { RelatedCis, RelatedTickets } from '@/components/related-tables';
import { handleFormError } from '@/components/form';
import { PortalAccessCard } from '@/components/forms/portal-access';

interface ContactDetail extends ContactRecord {
  companyName: string;
  companyPhone: string | null;
  locationName: string | null;
  portalEnabled: boolean;
  portalLastLoginAt: string | null;
  portalRole: string;
  portalPasswordSet: boolean;
  createdAt: string;
  updatedAt: string;
}

export default function ContactDetailPage() {
  const id = Number(useParams().id);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { can, me } = useAuth();
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const q = useQuery({ queryKey: ['contact', id], queryFn: () => api.get<ContactDetail>(`/contacts/${id}`) });
  const remove = useMutation({
    mutationFn: () => api.delete(`/contacts/${id}`),
    onSuccess: () => {
      toast.success('Contact deleted');
      qc.invalidateQueries({ queryKey: ['contacts'] });
      navigate('/contacts');
    },
    onError: (e) => handleFormError(e),
  });
  if (q.isLoading) return <PageLoader />;
  if (!q.data) return <EmptyState title="Contact not found" />;
  const c = q.data;
  const name = `${c.firstName} ${c.lastName}`;
  return (
    <div>
      <PageHeader
        title={name}
        icon={<UserRound />}
        breadcrumbs={[{ label: 'Contacts', to: '/contacts' }, { label: c.companyName, to: `/companies/${c.companyId}` }, { label: name }]}
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            {[c.title, c.department].filter(Boolean).join(' · ')}
            {c.isPrimary && <Badge tone="primary">Primary contact</Badge>}
            {!c.isActive && <Badge tone="warning">Inactive</Badge>}
          </span>
        }
        actions={
          <>
            {can('tickets.write') && (
              <Button variant="primary" onClick={() => navigate(`/tickets/new?companyId=${c.companyId}&contactId=${id}`)}>
                <Ticket /> New ticket
              </Button>
            )}
            {can('companies.write') && (
              <Button onClick={() => setEditing(true)}>
                <Pencil /> Edit
              </Button>
            )}
            {can('companies.delete') && (
              <Button variant="ghost" onClick={() => setDeleting(true)} aria-label="Delete contact">
                <Trash2 />
              </Button>
            )}
          </>
        }
      />
      <div className="grid gap-4 p-5 xl:grid-cols-[320px_1fr]">
        <div className="space-y-4">
        <Card className="h-fit">
          <CardHeader title="Contact information" />
          <CardBody className="space-y-2.5 text-[13px]">
            <Link to={`/companies/${c.companyId}`} className="flex items-center gap-2 font-medium hover:text-primary">
              <Building2 className="size-3.5 text-muted" /> {c.companyName}
            </Link>
            {c.email && (
              <a href={`mailto:${c.email}`} className="flex items-center gap-2 text-primary hover:underline">
                <Mail className="size-3.5" /> {c.email}
              </a>
            )}
            {c.phone && (
              <a href={`tel:${c.phone}`} className="flex items-center gap-2 hover:text-primary">
                <Phone className="size-3.5 text-muted" /> {c.phone}
              </a>
            )}
            {c.mobile && (
              <a href={`tel:${c.mobile}`} className="flex items-center gap-2 hover:text-primary">
                <Smartphone className="size-3.5 text-muted" /> {c.mobile}
              </a>
            )}
            {c.locationName && (
              <div className="flex items-center gap-2">
                <MapPin className="size-3.5 text-muted" /> {c.locationName}
              </div>
            )}
            <dl className="grid grid-cols-2 gap-3 border-t border-border pt-3">
              <Field label="Company phone">{c.companyPhone}</Field>
              <Field label="Created">{fmtDate(c.createdAt)}</Field>
              <CustomFieldsView entity="contact" value={c.customFields} />
            </dl>
            {c.notes && <p className="prose-note border-t border-border pt-3 text-xs text-muted">{c.notes}</p>}
          </CardBody>
        </Card>
        <PortalAccessCard contact={c} canWrite={can('companies.write')} />
        </div>
        <Card>
          <Tabs defaultValue="tickets">
            <div className="px-2">
              <TabsList className="border-b-0">
                <TabsTrigger value="tickets">Tickets</TabsTrigger>
                <TabsTrigger value="devices">Assigned devices</TabsTrigger>
              </TabsList>
            </div>
            <TabsContent value="tickets" className="border-t border-border">
              <RelatedTickets filter={{ contactId: id }} scope="all" />
            </TabsContent>
            <TabsContent value="devices" className="border-t border-border">
              <RelatedCis filter={{ contactId: id }} hide={['Company', 'Assigned to']} />
            </TabsContent>
          </Tabs>
        </Card>
      </div>
      <ContactFormDialog open={editing} onOpenChange={setEditing} contact={c} />
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={`Delete ${name}?`}
        description={me?.superAdmin ? "Records that still use it will be listed so you can confirm a force delete." : "Contacts linked to tickets cannot be deleted; mark them inactive instead."}
        danger
        confirmLabel="Delete contact"
        loading={remove.isPending}
        onConfirm={() => remove.mutate()}
      />
    </div>
  );
}
