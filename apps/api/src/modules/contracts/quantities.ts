import { sql } from 'drizzle-orm';
import type { Tx } from '../../db/client.js';

/**
 * Per-device / per-user pricing: contract service lines with "count
 * automatically" follow the number of active devices of the service's CI type
 * (all active devices when the service names no type) or of active contacts
 * of the company. Runs daily in the worker and whenever a contract or the
 * client's billing page is opened. Returns the number of lines changed.
 */
export async function refreshAutoQuantities(db: Tx, opts: { companyId?: number; contractId?: number } = {}): Promise<number> {
  const scope = sql.join(
    [
      sql`cs2.auto_quantity and sv.quantity_source in ('devices','users')`,
      ...(opts.companyId ? [sql`c.company_id = ${opts.companyId}`] : []),
      ...(opts.contractId ? [sql`c.id = ${opts.contractId}`] : []),
    ],
    sql` and `,
  );
  const res = await db.execute(sql`
    update contract_services cs set quantity = sub.n
    from (
      select cs2.id,
        case when sv.quantity_source = 'devices' then
          (select count(*) from configuration_items ci
            where ci.company_id = c.company_id and ci.lifecycle_status = 'active'
              and (sv.ci_type_id is null or ci.ci_type_id = sv.ci_type_id))
        else
          (select count(*) from contacts ct where ct.company_id = c.company_id and ct.is_active)
        end as n
      from contract_services cs2
      join services sv on sv.id = cs2.service_id
      join contracts c on c.id = cs2.contract_id
      where ${scope}
    ) sub
    where cs.id = sub.id and cs.quantity <> sub.n`);
  return Number((res as { rowCount?: number | null }).rowCount ?? 0);
}

export const PERIOD_MONTHS: Record<string, number> = { monthly: 1, quarterly: 3, semi_annual: 6, annual: 12 };
