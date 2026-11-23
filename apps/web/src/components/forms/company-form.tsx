import { useEffect } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { COMPANY_TYPE } from '@taskora/shared';
import { api } from '@/lib/api';
import { useLookups, opts, userOpts } from '@/lib/lookups';
import { Button } from '../ui/button';
import { Checkbox, Input, Select, Textarea } from '../ui/input';
import { Dialog } from '../ui/overlays';
import { FormField, FormGrid, FormSection, handleFormError } from '../form';
import { EntityPicker } from '../entity-picker';
import { CustomFieldsEditor } from '../custom-fields';

export interface CompanyRecord {
  id: number;
  name: string;
  accountNumber: string | null;
  type: string;
  isActive: boolean;
  industry: string | null;
  website: string | null;
  phone: string | null;
  email: string | null;
  emailDomains?: string[];
  address1: string | null;
  address2: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  country: string | null;
  parentCompanyId: number | null;
  parentCompanyName?: string | null;
  primaryContactId: number | null;
  primaryContactName?: string | null;
  accountManagerId: number | null;
  defaultSlaId: number | null;
  notes: string | null;
  customFields: Record<string, unknown>;
}

type FormValues = Omit<CompanyRecord, 'id' | 'emailDomains'> & { emailDomainsText: string };

const empty: FormValues = {
  name: '',
  accountNumber: '',
  type: 'customer',
  isActive: true,
  industry: '',
  website: '',
  phone: '',
  email: '',
  emailDomainsText: '',
  address1: '',
  address2: '',
  city: '',
  state: '',
  postalCode: '',
  country: '',
  parentCompanyId: null,
  primaryContactId: null,
  accountManagerId: null,
  defaultSlaId: null,
  notes: '',
  customFields: {},
};

export function CompanyFormDialog({
  open,
  onOpenChange,
  company,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  company?: CompanyRecord | null;
  onSaved?: (c: CompanyRecord) => void;
}) {
  const qc = useQueryClient();
  const lookups = useLookups();
  const form = useForm<FormValues>({ defaultValues: empty });
  const { register, handleSubmit, reset, setError, control, formState } = form;

  useEffect(() => {
    if (open)
      reset(
        company
          ? {
              ...empty,
              ...Object.fromEntries(Object.entries(company).map(([k, v]) => [k, v ?? (k in empty && typeof (empty as never)[k] === 'string' ? '' : v)])),
              emailDomainsText: (company.emailDomains ?? []).join(', '),
            }
          : empty,
      );
  }, [open, company, reset]);

  const save = useMutation({
    mutationFn: ({ emailDomainsText, ...rest }: FormValues) => {
      const values = { ...rest, emailDomains: emailDomainsText.split(/[,;\s]+/).map((d) => d.trim()).filter(Boolean) };
      return company ? api.patch<CompanyRecord>(`/companies/${company.id}`, values) : api.post<CompanyRecord>('/companies', values);
    },
    onSuccess: (row) => {
      toast.success(company ? 'Company updated' : 'Company created');
      qc.invalidateQueries({ queryKey: ['companies'] });
      qc.invalidateQueries({ queryKey: ['company', row.id] });
      onOpenChange(false);
      onSaved?.(row);
    },
    onError: (e) => handleFormError(e, ((name: string, error: { message: string }) => setError((name === 'emailDomains' ? 'emailDomainsText' : name) as keyof FormValues, error)) as never),
  });

  const err = (k: keyof FormValues) => formState.errors[k]?.message as string | undefined;

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={company ? `Edit ${company.name}` : 'New company'}
      size="lg"
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" loading={save.isPending} onClick={handleSubmit((v) => save.mutate(v))}>
            {company ? 'Save changes' : 'Create company'}
          </Button>
        </>
      }
    >
      <form className="space-y-5" onSubmit={handleSubmit((v) => save.mutate(v))}>
        <FormSection title="General">
          <FormGrid cols={3}>
            <FormField label="Company name" required error={err('name')} className="sm:col-span-2">
              <Input {...register('name')} aria-invalid={!!err('name')} />
            </FormField>
            <FormField label="Account number" error={err('accountNumber')}>
              <Input {...register('accountNumber')} placeholder="e.g. NS-001" />
            </FormField>
            <FormField label="Type">
              <Select {...register('type')} options={COMPANY_TYPE.values.map((v) => ({ value: v, label: COMPANY_TYPE.labels[v] }))} />
            </FormField>
            <FormField label="Industry">
              <Input {...register('industry')} />
            </FormField>
            <FormField label="Account manager">
              <Select {...register('accountManagerId', { setValueAs: (v) => (v ? Number(v) : null) })} placeholder="—" options={userOpts(lookups.data?.users, company?.accountManagerId, false)} />
            </FormField>
            <FormField label="Parent company">
              <Controller
                control={control}
                name="parentCompanyId"
                render={({ field }) => <EntityPicker kind="company" value={field.value} onChange={field.onChange} label={company?.parentCompanyName} placeholder="None" />}
              />
            </FormField>
            {company && (
              <FormField label="Primary contact">
                <Controller
                  control={control}
                  name="primaryContactId"
                  render={({ field }) => (
                    <EntityPicker kind="contact" value={field.value} onChange={field.onChange} label={company.primaryContactName} filter={{ companyId: company.id }} placeholder="None" />
                  )}
                />
              </FormField>
            )}
            <FormField label="Default SLA" hint="Used when no contract SLA applies">
              <Select {...register('defaultSlaId', { setValueAs: (v) => (v ? Number(v) : null) })} placeholder="System default" options={opts(lookups.data?.slaPolicies, company?.defaultSlaId)} />
            </FormField>
          </FormGrid>
          <Checkbox label="Active" {...register('isActive')} />
        </FormSection>
        <FormSection title="Contact details">
          <FormGrid cols={3}>
            <FormField label="Main phone">
              <Input {...register('phone')} />
            </FormField>
            <FormField label="Primary e-mail" error={err('email')}>
              <Input type="email" {...register('email')} />
            </FormField>
            <FormField label="Website">
              <Input {...register('website')} placeholder="https://" />
            </FormField>
          </FormGrid>
          <FormField
            label="E-mail domains"
            error={err('emailDomainsText')}
            hint="E-mails from these domains open tickets for this company, and unknown senders become contacts (e.g. lesaures.com). Separate several with commas. People with a personal address (gmail.com…) are matched when they are contacts."
          >
            <Input {...register('emailDomainsText')} placeholder="example.com" />
          </FormField>
        </FormSection>
        <FormSection title="Billing address">
          <FormGrid cols={2}>
            <FormField label="Address line 1">
              <Input {...register('address1')} />
            </FormField>
            <FormField label="Address line 2">
              <Input {...register('address2')} />
            </FormField>
          </FormGrid>
          <FormGrid cols={4}>
            <FormField label="Postal code">
              <Input {...register('postalCode')} />
            </FormField>
            <FormField label="City">
              <Input {...register('city')} />
            </FormField>
            <FormField label="State / region">
              <Input {...register('state')} />
            </FormField>
            <FormField label="Country">
              <Input {...register('country')} />
            </FormField>
          </FormGrid>
        </FormSection>
        <Controller control={control} name="customFields" render={({ field }) => <CustomFieldsEditor entity="company" value={field.value} onChange={field.onChange} errors={formState.errors} />} />
        <FormField label="Notes">
          <Textarea rows={3} {...register('notes')} />
        </FormField>
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}
