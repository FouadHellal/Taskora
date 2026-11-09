import { and, eq } from 'drizzle-orm';
import type { CustomFieldEntity } from '@taskora/shared';
import type { Tx } from '../db/client.js';
import { customFieldDefinitions } from '../db/schema/index.js';
import { AppError } from './errors.js';

/**
 * Validates user-defined field values against the active definitions for an
 * entity. Unknown keys are dropped; values are coerced to their declared type.
 * `enforceRequired: false` is for records an integration creates (a monitoring alert cannot
 * answer a form): types are still checked, missing required values are left for a person.
 */
export async function validateCustomFields(
  db: Tx,
  entity: CustomFieldEntity,
  values: Record<string, unknown> | undefined,
  existing: Record<string, unknown> = {},
  { enforceRequired = true }: { enforceRequired?: boolean } = {},
): Promise<Record<string, unknown>> {
  const defs = await db
    .select()
    .from(customFieldDefinitions)
    .where(and(eq(customFieldDefinitions.entity, entity), eq(customFieldDefinitions.isActive, true)));
  const out: Record<string, unknown> = { ...existing };
  const errors: Record<string, string> = {};
  const input = values ?? {};

  for (const def of defs) {
    if (!(def.key in input)) {
      if (enforceRequired && def.isRequired && (out[def.key] === undefined || out[def.key] === null || out[def.key] === '')) {
        errors[`customFields.${def.key}`] = `${def.label} is required`;
      }
      continue;
    }
    const raw = input[def.key];
    if (raw === null || raw === undefined || raw === '') {
      if (enforceRequired && def.isRequired) errors[`customFields.${def.key}`] = `${def.label} is required`;
      out[def.key] = null;
      continue;
    }
    switch (def.type) {
      case 'number': {
        const n = Number(raw);
        if (!Number.isFinite(n)) errors[`customFields.${def.key}`] = `${def.label} must be a number`;
        else out[def.key] = n;
        break;
      }
      case 'boolean':
        out[def.key] = raw === true || raw === 'true';
        break;
      case 'date':
        if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) errors[`customFields.${def.key}`] = `${def.label} must be a date`;
        else out[def.key] = raw;
        break;
      case 'select':
        if (!def.options.includes(String(raw))) errors[`customFields.${def.key}`] = `${def.label}: invalid option`;
        else out[def.key] = String(raw);
        break;
      case 'url':
        if (!/^https?:\/\/\S+$/i.test(String(raw))) errors[`customFields.${def.key}`] = `${def.label} must be a URL`;
        else out[def.key] = String(raw);
        break;
      default:
        out[def.key] = String(raw).slice(0, def.type === 'textarea' ? 10000 : 500);
    }
  }
  if (Object.keys(errors).length) throw new AppError(400, 'validation_error', 'Validation failed', { fields: errors });
  // Drop keys that no longer correspond to an active definition.
  const allowed = new Set(defs.map((d) => d.key));
  return Object.fromEntries(Object.entries(out).filter(([k]) => allowed.has(k)));
}
