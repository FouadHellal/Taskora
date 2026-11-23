/**
 * Client portal: monthly reports, the service agreement (prices per unit,
 * per month / billing period / year, invoices), e-mail preferences, the
 * company logo and the figures of the home page.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { and, asc, desc, eq, inArray, ne, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import * as s from '../../db/schema/index.js';
import { badRequest, forbidden, notFound } from '../../lib/errors.js';
import { idOf } from '../../lib/params.js';
import type { SystemSettings } from '../../lib/settings.js';
import { contactAddresses, EMAIL_PREF_KEYS, emailPrefs, NOTIFY_MODES } from '../../jobs/client-email.js';
import { contractBalances } from '../contracts/coverage.js';
import { PERIOD_MONTHS, refreshAutoQuantities } from '../contracts/quantities.js';
import { healthScore, securityHealthParts, securitySnapshot } from '../client-reports/service.js';
import { invoicePdf } from '../billing/routes.js';
import type { PortalContact } from './routes.js';

type Contact = PortalContact;

const prefsSchema = z.object({
  ...(Object.fromEntries(EMAIL_PREF_KEYS.map((k) => [k, z.boolean().optional()])) as Record<(typeof EMAIL_PREF_KEYS)[number], z.ZodOptional<z.ZodBoolean>>),
  /** Second mailbox for ticket e-mails (empty clears it). */
  notifyEmail: z.union([z.literal(''), z.string().trim().toLowerCase().email('Enter a valid e-mail address').max(255)]).optional(),
  /** Where e-mails go: the main address, the second one, or both. */
  notifyMode: z.enum(NOTIFY_MODES).optional(),
});

const round2 = (n: number) => Math.round(n * 100) / 100;
const todayIso = () => new Date().toISOString().slice(0, 10);

function addMonths(iso: string, months: number) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y!, m! - 1 + months, 1));
  const last = new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth() + 1, 0)).getUTCDate();
  dt.setUTCDate(Math.min(d!, last));
  return dt.toISOString().slice(0, 10);
}

/** Next start of a billing period on or after today, counted from the contract start. */
function nextBillingDate(start: string, months: number, end: string | null) {
  const today = todayIso();
  let d = start;
  for (let i = 0; d < today && i < 1200; i++) d = addMonths(start, months * (i + 1));
  return end && d > end ? null : d;
}

export function registerPortalEngagement(
  portal: FastifyInstance,
  app: FastifyInstance,
  helpers: { contactOf: (req: FastifyRequest) => Contact; settings: () => SystemSettings; visibleTickets: (c: Contact) => SQL },
) {
  const { contactOf } = helpers;
  const needManager = (c: Contact, enabled: boolean) => {
    if (!c.isManager || !enabled) throw forbidden('This page is for company managers');
  };

  /* ----------------------------------------------------- company logo */

  portal.get('/company-logo', async (req, reply) => {
    const c = contactOf(req);
    const [logo] = await app.db.select().from(s.logos).where(and(eq(s.logos.entityType, 'company'), eq(s.logos.entityId, c.companyId)));
    if (!logo) throw notFound('Logo');
    return reply
      .header('content-type', logo.mimeType)
      .header('cache-control', 'private, max-age=86400')
      .header('content-security-policy', "default-src 'none'")
      .send(Buffer.from(logo.data, 'base64'));
  });

  /* -------------------------------------------------- e-mail preferences */

  portal.get('/profile/notifications', async (req) => {
    const c = contactOf(req);
    const [row] = await app.db
      .select({ prefs: s.contacts.emailPreferences, email: s.contacts.email, notifyEmail: s.contacts.notifyEmail, notifyMode: s.contacts.notifyMode })
      .from(s.contacts)
      .where(eq(s.contacts.id, c.id));
    return {
      email: row?.email ?? null,
      notifyEmail: row?.notifyEmail ?? null,
      notifyMode: row?.notifyMode ?? 'main',
      sendsTo: row ? contactAddresses(row) : [],
      preferences: emailPrefs(row?.prefs),
      isManager: c.isManager,
      clientEmailsEnabled: helpers.settings().clientEmailsEnabled,
    };
  });

  portal.put('/profile/notifications', async (req) => {
    const c = contactOf(req);
    const input = prefsSchema.parse(req.body);
    const [row] = await app.db.select({ prefs: s.contacts.emailPreferences, email: s.contacts.email }).from(s.contacts).where(eq(s.contacts.id, c.id));
    const flags = Object.fromEntries(EMAIL_PREF_KEYS.filter((k) => typeof input[k] === 'boolean').map((k) => [k, input[k]]));
    const merged = { ...emailPrefs(row?.prefs), ...flags };
    if (!c.isManager) merged.companyTickets = false;
    const data: Partial<typeof s.contacts.$inferInsert> = { emailPreferences: merged };
    if (input.notifyEmail !== undefined) data.notifyEmail = input.notifyEmail || null;
    if (input.notifyMode !== undefined) data.notifyMode = input.notifyMode;
    const mode = data.notifyMode;
    const other = data.notifyEmail;
    if (mode && mode !== 'main' && !(other ?? (await app.db.select({ v: s.contacts.notifyEmail }).from(s.contacts).where(eq(s.contacts.id, c.id)))[0]?.v)) {
      throw badRequest('Enter the second address first', { fields: { notifyEmail: 'Required' } });
    }
    if (!row?.email && mode === 'main') throw badRequest('Your contact has no main e-mail address — use the second address');
    await app.db.update(s.contacts).set(data).where(eq(s.contacts.id, c.id));
    const [after] = await app.db.select({ email: s.contacts.email, notifyEmail: s.contacts.notifyEmail, notifyMode: s.contacts.notifyMode }).from(s.contacts).where(eq(s.contacts.id, c.id));
    return { preferences: merged, notifyEmail: after?.notifyEmail ?? null, notifyMode: after?.notifyMode ?? 'main', sendsTo: after ? contactAddresses(after) : [] };
  });

  /* --------------------------------------------------------- reports */

  portal.get('/reports', async (req) => {
    const c = contactOf(req);
    needManager(c, helpers.settings().portalShowReports);
    return app.db
      .select({
        id: s.clientReports.id,
        period: s.clientReports.period,
        title: s.clientReports.title,
        publishedAt: s.clientReports.publishedAt,
        healthScore: sql<number | null>`(${s.clientReports.data}->'health'->>'score')::int`,
        opened: sql<number | null>`(${s.clientReports.data}->'tickets'->>'opened')::int`,
        resolved: sql<number | null>`(${s.clientReports.data}->'tickets'->>'resolved')::int`,
        minutes: sql<number | null>`(${s.clientReports.data}->'work'->>'minutes')::int`,
      })
      .from(s.clientReports)
      .where(and(eq(s.clientReports.companyId, c.companyId), eq(s.clientReports.status, 'published')))
      .orderBy(desc(s.clientReports.period));
  });

  portal.get('/reports/:id', async (req) => {
    const c = contactOf(req);
    const settings = helpers.settings();
    needManager(c, settings.portalShowReports);
    const [r] = await app.db
      .select()
      .from(s.clientReports)
      .where(and(eq(s.clientReports.id, idOf(req)), eq(s.clientReports.companyId, c.companyId), eq(s.clientReports.status, 'published')));
    if (!r) throw notFound('Report');
    const hidden = new Set(r.hiddenSections);
    if (!settings.portalShowTime) hidden.add('work');
    if (!settings.portalShowDevices) {
      hidden.add('devices');
      hidden.add('security');
    }
    const data = Object.fromEntries(Object.entries(r.data).filter(([k]) => !hidden.has(k)));
    return { id: r.id, period: r.period, title: r.title, summary: r.summary, publishedAt: r.publishedAt, data, hiddenSections: [...hidden] };
  });

  /* ---------------------------------------------------------- billing */

  async function agreements(companyId: number) {
    await refreshAutoQuantities(app.db, { companyId });
    const contracts = await app.db
      .select()
      .from(s.contracts)
      .where(and(eq(s.contracts.companyId, companyId), eq(s.contracts.portalVisible, true), eq(s.contracts.status, 'active')))
      .orderBy(asc(s.contracts.startDate));
    if (!contracts.length) return [];
    const ids = contracts.map((x) => x.id);
    const lines = await app.db
      .select({
        id: s.contractServices.id,
        contractId: s.contractServices.contractId,
        name: s.services.name,
        description: s.services.description,
        period: s.services.period,
        quantitySource: s.services.quantitySource,
        ciTypeName: s.ciTypes.name,
        quantity: s.contractServices.quantity,
        autoQuantity: s.contractServices.autoQuantity,
        unitPrice: s.contractServices.unitPrice,
        startDate: s.contractServices.startDate,
        endDate: s.contractServices.endDate,
      })
      .from(s.contractServices)
      .innerJoin(s.services, eq(s.services.id, s.contractServices.serviceId))
      .leftJoin(s.ciTypes, eq(s.ciTypes.id, s.services.ciTypeId))
      .where(inArray(s.contractServices.contractId, ids))
      .orderBy(asc(s.services.name));
    const balances = await contractBalances(app.db, ids);
    const today = todayIso();
    return contracts.map((k) => {
      const months = PERIOD_MONTHS[k.billingPeriod] ?? 1;
      const services = lines
        .filter((l) => l.contractId === k.id && (!l.endDate || l.endDate >= today))
        .map((l) => {
          const per = PERIOD_MONTHS[l.period];
          const amount = round2(l.unitPrice * l.quantity);
          return {
            ...l,
            amount,
            monthly: per ? round2(amount / per) : null,
            oneTime: !per,
            upcoming: !!l.startDate && l.startDate > today,
          };
        });
      const recurringMonthly = k.recurringAmount ? round2(k.recurringAmount / months) : 0;
      const monthly = round2(services.filter((x) => !x.upcoming).reduce((a, x) => a + (x.monthly ?? 0), 0) + recurringMonthly);
      const b = balances.get(k.id);
      const start = new Date(`${k.startDate}T00:00:00Z`).getTime();
      const end = k.endDate ? new Date(`${k.endDate}T00:00:00Z`).getTime() : null;
      const now = Date.now();
      return {
        id: k.id,
        contractNumber: k.contractNumber,
        name: k.name,
        type: k.type,
        description: k.description,
        startDate: k.startDate,
        endDate: k.endDate,
        autoRenew: k.autoRenew,
        billingPeriod: k.billingPeriod,
        billingMonths: months,
        daysLeft: end ? Math.ceil((end - now) / 86400_000) : null,
        termProgress: end && end > start ? Math.max(0, Math.min(100, Math.round(((now - start) / (end - start)) * 100))) : null,
        nextInvoiceDate: PERIOD_MONTHS[k.billingPeriod] ? nextBillingDate(k.startDate, months, k.endDate) : null,
        recurringAmount: k.recurringAmount,
        fixedAmount: k.fixedAmount,
        hourlyRate: k.hourlyRate,
        overageRate: k.overageRate,
        perTicketRate: k.perTicketRate,
        services,
        totals: { monthly, perPeriod: round2(monthly * months), annual: round2(monthly * 12) },
        hours: b && b.purchasedHours > 0 ? { purchased: b.purchasedHours, used: b.usedHours, remaining: b.remainingHours, low: b.lowBalance } : null,
      };
    });
  }

  portal.get('/billing', async (req) => {
    const c = contactOf(req);
    const settings = helpers.settings();
    needManager(c, settings.portalShowBilling);
    const list = await agreements(c.companyId);
    const invoices = await app.db
      .select({
        id: s.invoices.id,
        invoiceNumber: s.invoices.invoiceNumber,
        status: s.invoices.status,
        issueDate: s.invoices.issueDate,
        dueDate: s.invoices.dueDate,
        periodStart: s.invoices.periodStart,
        periodEnd: s.invoices.periodEnd,
        total: s.invoices.total,
        currency: s.invoices.currency,
      })
      .from(s.invoices)
      .where(and(eq(s.invoices.companyId, c.companyId), inArray(s.invoices.status, ['issued', 'paid'])))
      .orderBy(desc(s.invoices.issueDate), desc(s.invoices.id))
      .limit(60);
    const today = todayIso();
    const rows = invoices.map((i) => ({ ...i, overdue: i.status === 'issued' && !!i.dueDate && i.dueDate < today }));
    const monthly = round2(list.reduce((a, x) => a + x.totals.monthly, 0));
    return {
      currency: settings.currency,
      agreements: list,
      totals: { monthly, annual: round2(monthly * 12) },
      invoices: rows,
      outstanding: round2(rows.filter((i) => i.status === 'issued').reduce((a, i) => a + i.total, 0)),
    };
  });

  portal.get('/invoices/:id/pdf', async (req, reply) => {
    const c = contactOf(req);
    needManager(c, helpers.settings().portalShowBilling);
    const [inv] = await app.db
      .select({ id: s.invoices.id })
      .from(s.invoices)
      .where(and(eq(s.invoices.id, idOf(req)), eq(s.invoices.companyId, c.companyId), ne(s.invoices.status, 'draft'), ne(s.invoices.status, 'void')));
    if (!inv) throw notFound('Invoice');
    const { pdf, invoiceNumber } = await invoicePdf(app.db, inv.id);
    return reply.header('content-type', 'application/pdf').header('content-disposition', `attachment; filename="${invoiceNumber}.pdf"`).send(pdf);
  });

  /* ------------------------------------------------------- home extras */

  /** Health score, device status, work trend, latest report and agreement for the home page. */
  portal.get('/dashboard/insights', async (req) => {
    const c = contactOf(req);
    const settings = helpers.settings();
    const tz = settings.timezone;
    const vis = helpers.visibleTickets(c);
    const out: Record<string, unknown> = {};

    if (settings.portalShowTime) {
      out.trend = (
        await app.db.execute(sql`
          select to_char(m, 'YYYY-MM') as month,
            (select coalesce(sum(te.duration_minutes), 0)::int from time_entries te join tickets on tickets.id = te.ticket_id
              where ${vis} and te.status in ('submitted','approved','billed')
                and te.started_at >= (m::timestamp at time zone ${tz}) and te.started_at < ((m + interval '1 month')::timestamp at time zone ${tz})) as minutes
          from generate_series(date_trunc('month', now() at time zone ${tz}) - interval '5 months', date_trunc('month', now() at time zone ${tz}), interval '1 month') m
          order by m`)
      ).rows;
    }

    // Requests per state over the last 30 days, for everybody.
    const [act] = (
      await app.db.execute(sql`
        select count(*) filter (where tickets.created_at > now() - interval '30 days')::int as opened30,
               count(*) filter (where tickets.resolved_at > now() - interval '30 days')::int as resolved30,
               avg(extract(epoch from (tickets.resolved_at - tickets.created_at)) / 3600) filter (where tickets.resolved_at > now() - interval '90 days') as avg_hours,
               count(*) filter (where tickets.resolved_at > now() - interval '90 days' and tickets.resolution_due_at is not null)::int as sla_total,
               count(*) filter (where tickets.resolved_at > now() - interval '90 days' and tickets.resolution_due_at is not null and not tickets.resolution_breached)::int as sla_met
        from tickets where ${vis}`)
    ).rows as Record<string, unknown>[];
    const slaTotal = Number(act?.sla_total ?? 0);
    const slaMetPct = slaTotal ? Math.round((Number(act?.sla_met ?? 0) / slaTotal) * 100) : null;
    out.activity = {
      opened30: Number(act?.opened30 ?? 0),
      resolved30: Number(act?.resolved30 ?? 0),
      avgResolutionHours: act?.avg_hours == null ? null : Math.round(Number(act.avg_hours) * 10) / 10,
      slaMetPct,
    };

    if (c.isManager) {
      const security = settings.portalShowDevices ? await securitySnapshot(app.db, c.companyId) : null;
      const opened = Number(act?.opened30 ?? 0);
      const resolved = Number(act?.resolved30 ?? 0);
      out.health = healthScore([
        ...securityHealthParts(security),
        slaMetPct == null ? null : { key: 'sla', score: slaMetPct, weight: 25 },
        opened || resolved ? { key: 'resolution', score: Math.min(100, Math.round((resolved / Math.max(opened, 1)) * 100)), weight: 20 } : null,
      ]);
      out.security = security
        ? {
            endpoints: security.endpoints,
            online: security.online,
            patchedPct: security.patchedPct,
            fullyPatchedPct: security.fullyPatchedPct,
            rebootRequired: security.rebootRequired,
            withCriticalUpdates: security.withCriticalUpdates,
            lastSyncAt: security.lastSyncAt,
          }
        : null;
      if (settings.portalShowDevices) {
        out.devices = (
          await app.db.execute(sql`select ct.name, count(*)::int as count from configuration_items ci join ci_types ct on ct.id = ci.ci_type_id
            where ci.company_id = ${c.companyId} and ci.lifecycle_status = 'active' group by ct.name order by count(*) desc limit 6`)
        ).rows;
      }
      if (settings.portalShowReports) {
        const [r] = await app.db
          .select({ id: s.clientReports.id, period: s.clientReports.period, title: s.clientReports.title, healthScore: sql<number | null>`(${s.clientReports.data}->'health'->>'score')::int` })
          .from(s.clientReports)
          .where(and(eq(s.clientReports.companyId, c.companyId), eq(s.clientReports.status, 'published')))
          .orderBy(desc(s.clientReports.period))
          .limit(1);
        out.latestReport = r ?? null;
      }
      if (settings.portalShowBilling) {
        const list = await agreements(c.companyId);
        const a = list[0];
        out.agreement = a
          ? { name: a.name, endDate: a.endDate, daysLeft: a.daysLeft, autoRenew: a.autoRenew, termProgress: a.termProgress, monthly: list.reduce((x, y) => x + y.totals.monthly, 0), nextInvoiceDate: a.nextInvoiceDate, billingPeriod: a.billingPeriod, currency: settings.currency }
          : null;
      }
    }
    return out;
  });
}
