import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { translate } from '@/lib/i18n';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Dialog } from '../ui/overlays';
import { FormField, handleFormError } from '../form';

export function ChangePasswordDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const save = useMutation({
    mutationFn: () => api.post('/auth/change-password', { currentPassword: current, newPassword: next }),
    onSuccess: () => {
      toast.success(translate('Password changed. Other sessions were signed out.'));
      onOpenChange(false);
      setCurrent('');
      setNext('');
      setConfirm('');
    },
    onError: (e) => handleFormError(e, (name: string, err: { message: string }) => setErrors((x) => ({ ...x, [name]: err.message }))),
  });
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Change password"
      size="sm"
      footer={
        <>
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            variant="primary"
            loading={save.isPending}
            onClick={() => {
              setErrors({});
              if (next !== confirm) return setErrors({ confirm: 'Passwords do not match' });
              save.mutate();
            }}
          >
            Change password
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <FormField label="Current password" error={errors.currentPassword}>
          <Input type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
        </FormField>
        <FormField label="New password" error={errors.newPassword} hint="At least 12 characters with letters and numbers.">
          <Input type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
        </FormField>
        <FormField label="Confirm new password" error={errors.confirm}>
          <Input type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        </FormField>
      </div>
    </Dialog>
  );
}
