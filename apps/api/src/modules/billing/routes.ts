import type { FastifyInstance } from 'fastify';
import { and, asc, desc, eq, gte, inArray, isNull, lte, ne, sql } from 'drizzle-orm';
import PDFDocument from 'pdfkit';
import { expenseSchema, formatMoney, formatNumber, invoiceDraftSchema, invoiceLineSchema, invoiceUpdateSchema } from '@taskora/shared';
import * as s from '../../db/schema/index.js';
import { audit } from '../../lib/audit.js';
import { badRequest, forbidden, notFound, inUse } from '../../lib/errors.js';
import { idOf } from '../../lib/params.js';
import { countAll, intParam, nextSequence, paginated, parseList, searchAny, whereAll } from '../../lib/query.js';
import { can, currentUser } from '../../lib/context.js';
import { getSystemSettings } from '../../lib/settings.js';
import type { Tx } from '../../db/client.js';

const round2 = (n: number) => Math.round(n * 100) / 100;

async function recalcInvoice(tx: Tx, invoiceId: number) {
  const [inv] = await tx.select().from(s.invoices).where(eq(s.invoices.id, invoiceId));
  if (!inv) throw notFound('Invoice');
  const [{ subtotal }] = (await tx
    .select({ subtotal: sql<number>`coalesce(sum(${s.invoiceLines.amount}),0)::float` })
    .from(s.invoiceLines)
    .where(eq(s.invoiceLines.invoiceId, invoiceId))) as [{ subtotal: number }];
  const tax = round2((subtotal * inv.taxRate) / 100);
  await tx
    .update(s.invoices)
    .set({ subtotal: round2(subtotal), taxAmount: tax, total: round2(subtotal + tax) })
    .where(eq(s.invoices.id, invoiceId));
}

/** Releases time entries and expenses reserved by an invoice (on delete or void). */
async function releaseInvoice(tx: Tx, invoiceId: number) {
  await tx.update(s.timeEntries).set({ invoiceId: null, status: 'approved' }).where(eq(s.timeEntries.invoiceId, invoiceId));
  await tx.update(s.expenses).set({ invoiceId: null }).where(eq(s.expenses.invoiceId, invoiceId));
}

export async function billingRoutes(app: FastifyInstance) {
  /* ------------------------------------------------------------- expenses */

  app.get('/expenses', { config: { perm: ['billing.read', 'time.write'] } }, async (req) => {
    const q = parseList(req.query);
    const me = currentUser(req);
    const where = whereAll(
      can(req, 'billing.read') ? undefined : eq(s.expenses.userId, me.id),
      intParam(q.companyId) ? eq(s.expenses.companyId, intParam(q.companyId)!) : undefined,
      intParam(q.ticketId) ? eq(s.expenses.ticketId, intParam(q.ticketId)!) : undefined,
      intParam(q.projectId) ? eq(s.expenses.projectId, intParam(q.projectId)!) : undefined,
      q.unbilled === 'true' ? isNull(s.expenses.invoiceId) : undefined,
      searchAny(q.q, [s.expenses.description, s.companies.name]),
    );
    const rows = await app.db
      .select({
        expense: s.expenses,
        companyName: s.companies.name,
        userName: sql<string>`${s.users.firstName} || ' ' || ${s.users.lastName}`,
        billingCodeName: s.billingCodes.name,
        ticketNumber: s.tickets.ticketNumber,
        invoiceNumber: s.invoices.invoiceNumber,
      })
      .from(s.expenses)
      .innerJoin(s.companies, eq(s.companies.id, s.expenses.companyId))
      .innerJoin(s.users, eq(s.users.id, s.expenses.userId))
      .leftJoin(s.billingCodes, eq(s.billingCodes.id, s.expenses.billingCodeId))
      .leftJoin(s.tickets, eq(s.tickets.id, s.expenses.ticketId))
      .leftJoin(s.invoices, eq(s.invoices.id, s.expenses.invoiceId))
      .where(where)
      .orderBy(desc(s.expenses.expenseDate), desc(s.expenses.id))
      .limit(q.pageSize)
      .offset((q.page - 1) * q.pageSize);
    const [{ n }] = (await app.db.select({ n: countAll }).from(s.expenses).innerJoin(s.companies, eq(s.companies.id, s.expenses.companyId)).where(where)) as [
      { n: number },
    ];
    return paginated(
      rows.map((r) => ({ ...r.expense, companyName: r.companyName, userName: r.userName, billingCodeName: r.billingCodeName, ticketNumber: r.ticketNumber, invoiceNumber: r.invoiceNumber })),
      n,
      q,
    );
  });

  app.post('/expenses', { config: { perm: ['billing.write', 'time.write'] } }, async (req, reply) => {
    const input = expenseSchema.parse(req.body);
    if (input.ticketId) {
      const [t] = await app.db.select({ companyId: s.tickets.companyId, contractId: s.tickets.contractId }).from(s.tickets).where(eq(s.tickets.id, input.ticketId));
      if (!t || t.companyId !== input.companyId) throw badRequest('The ticket belongs to another company');
      input.contractId ??= t.contractId;
    }
    const [row] = await app.db.insert(s.expenses).values({ ...input, userId: currentUser(req).id }).returning();
    await audit(app.db, req, { action: 'create', entityType: 'expense', entityId: row!.id, summary: `${input.description} ${input.amount}` });
    return reply.status(201).send(row);
  });

  app.delete('/expenses/:id', { config: { perm: ['billing.write', 'time.write'], forceDelete: { table: 'expenses' } } }, async (req) => {
    const id = idOf(req);
    const [row] = await app.db.select().from(s.expenses).where(eq(s.expenses.id, id));
    if (!row) throw notFound('Expense');
    if (row.invoiceId) throw badRequest('This expense is on an invoice');
    if (row.userId !== currentUser(req).id && !can(req, 'billing.write')) throw forbidden();
    await app.db.delete(s.expenses).where(eq(s.expenses.id, id));
    await audit(app.db, req, { action: 'delete', entityType: 'expense', entityId: id });
    return { ok: true };
  });

  /* ------------------------------------------------------- billing review */

  /** Unbilled billable work and expenses per company, ready for invoicing. */
  app.get('/billing/review', { config: { perm: 'billing.read' } }, async (req) => {
    const q = req.query as { from?: string; to?: string };
    const from = q.from ?? '1970-01-01';
    const to = q.to ?? '2999-12-31';
    const rows = await app.db.execute(sql`
      with t as (
        select company_id,
          sum(duration_minutes) filter (where billable and not contract_covered and status = 'approved')::int as billable_minutes,
          sum(duration_minutes) filter (where billable and not contract_covered and status in ('draft','submitted'))::int as pending_minutes,
          sum(duration_minutes) filter (where contract_covered)::int as covered_minutes,
          coalesce(sum(duration_minutes * coalesce(hourly_rate,0) / 60.0) filter (where billable and not contract_covered and status = 'approved'),0)::float as billable_amount
        from time_entries
        where invoice_id is null and started_at::date between ${from}::date and ${to}::date
        group by company_id
      ), e as (
        select company_id, count(*)::int as expense_count, coalesce(sum(amount),0)::float as expense_amount
        from expenses where invoice_id is null and billable and expense_date between ${from}::date and ${to}::date
        group by company_id
      )
      select c.id as "companyId", c.name as "companyName",
        coalesce(t.billable_minutes,0) as "billableMinutes", coalesce(t.pending_minutes,0) as "pendingApprovalMinutes",
        coalesce(t.covered_minutes,0) as "contractCoveredMinutes", coalesce(t.billable_amount,0) as "billableAmount",
        coalesce(e.expense_count,0) as "expenseCount", coalesce(e.expense_amount,0) as "expenseAmount"
      from companies c left join t on t.company_id = c.id left join e on e.company_id = c.id
      where t.company_id is not null or e.company_id is not null
      order by coalesce(t.billable_amount,0) + coalesce(e.expense_amount,0) desc`);
    return { data: rows.rows };
  });

  /* ------------------------------------------------------------- invoices */

  app.get('/invoices', { config: { perm: 'billing.read' } }, async (req) => {
    const q = parseList(req.query);
    const where = whereAll(
      intParam(q.companyId) ? eq(s.invoices.companyId, intParam(q.companyId)!) : undefined,
      q.status ? inArray(s.invoices.status, String(q.status).split(',')) : undefined,
      searchAny(q.q, [s.invoices.invoiceNumber, s.companies.name]),
    );
    const rows = await app.db
      .select({ invoice: s.invoices, companyName: s.companies.name })
      .from(s.invoices)
      .innerJoin(s.companies, eq(s.companies.id, s.invoices.companyId))
      .where(where)
      .orderBy(desc(s.invoices.createdAt))
      .limit(q.pageSize)
      .offset((q.page - 1) * q.pageSize);
    const [{ n }] = (await app.db.select({ n: countAll }).from(s.invoices).innerJoin(s.companies, eq(s.companies.id, s.invoices.companyId)).where(where)) as [
      { n: number },
    ];
    return paginated(rows.map((r) => ({ ...r.invoice, companyName: r.companyName })), n, q);
  });

  const loadInvoice = async (id: number) => {
    const [row] = await app.db
      .select({ invoice: s.invoices, companyName: s.companies.name, company: s.companies })
      .from(s.invoices)
      .innerJoin(s.companies, eq(s.companies.id, s.invoices.companyId))
      .where(eq(s.invoices.id, id));
    if (!row) throw notFound('Invoice');
    const lines = await app.db.select().from(s.invoiceLines).where(eq(s.invoiceLines.invoiceId, id)).orderBy(asc(s.invoiceLines.sortOrder), asc(s.invoiceLines.id));
    return { ...row.invoice, companyName: row.companyName, company: row.company, lines };
  };

  app.get('/invoices/:id', { config: { perm: 'billing.read' } }, async (req) => loadInvoice(idOf(req)));

  /** Builds a draft invoice from unbilled approved time, billable expenses and recurring services. */
  app.post('/invoices/draft', { config: { perm: 'billing.write' } }, async (req, reply) => {
    const input = invoiceDraftSchema.parse(req.body);
    if (input.periodEnd < input.periodStart) throw badRequest('Period end is before period start');
    const me = currentUser(req);
    const id = await app.db.transaction(async (tx) => {
      const settings = await getSystemSettings(tx);
      const [company] = await tx.select().from(s.companies).where(eq(s.companies.id, input.companyId));
      if (!company) throw badRequest('Unknown company');
      const [invoice] = await tx
        .insert(s.invoices)
        .values({
          invoiceNumber: formatNumber(settings.invoicePrefix, await nextSequence(tx, 'invoice')),
          companyId: input.companyId,
          periodStart: input.periodStart,
          periodEnd: input.periodEnd,
          taxRate: input.taxRate,
          currency: settings.currency,
          notes: input.notes,
          createdById: me.id,
        })
        .returning();
      const lines: (typeof s.invoiceLines.$inferInsert)[] = [];
      let order = 0;

      if (input.includeRecurring) {
        const contracts = await tx
          .select()
          .from(s.contracts)
          .where(and(eq(s.contracts.companyId, input.companyId), eq(s.contracts.status, 'active'), inArray(s.contracts.type, ['recurring', 'retainer', 'fixed_price'])));
        for (const c of contracts) {
          // Skip contracts already invoiced for an overlapping period.
          const [dup] = await tx
            .select({ id: s.invoices.id })
            .from(s.invoiceLines)
            .innerJoin(s.invoices, eq(s.invoices.id, s.invoiceLines.invoiceId))
            .where(
              and(
                ne(s.invoices.status, 'void'),
                ne(s.invoices.id, invoice!.id),
                sql`${s.invoiceLines.description} like ${`[${c.contractNumber}]%`}`,
                lte(s.invoices.periodStart, input.periodEnd),
                gte(s.invoices.periodEnd, input.periodStart),
              ),
            )
            .limit(1);
          if (dup) continue;
          if (c.recurringAmount) {
            lines.push({ invoiceId: invoice!.id, kind: 'service', description: `[${c.contractNumber}] ${c.name} — ${c.billingPeriod} fee`, quantity: 1, unitPrice: c.recurringAmount, amount: c.recurringAmount, sortOrder: order++ });
          }
          const svcs = await tx
            .select({ line: s.contractServices, name: s.services.name })
            .from(s.contractServices)
            .innerJoin(s.services, eq(s.services.id, s.contractServices.serviceId))
            .where(eq(s.contractServices.contractId, c.id));
          for (const sv of svcs) {
            lines.push({
              invoiceId: invoice!.id,
              kind: 'service',
              description: `[${c.contractNumber}] ${sv.name}`,
              quantity: sv.line.quantity,
              unitPrice: sv.line.unitPrice,
              amount: round2(sv.line.quantity * sv.line.unitPrice),
              contractServiceId: sv.line.id,
              sortOrder: order++,
            });
          }
        }
      }

      if (input.includeTime) {
        const entries = await tx
          .select({ e: s.timeEntries, ticketNumber: s.tickets.ticketNumber, workType: s.workTypes.name, task: s.projectTasks.title })
          .from(s.timeEntries)
          .leftJoin(s.tickets, eq(s.tickets.id, s.timeEntries.ticketId))
          .leftJoin(s.workTypes, eq(s.workTypes.id, s.timeEntries.workTypeId))
          .leftJoin(s.projectTasks, eq(s.projectTasks.id, s.timeEntries.projectTaskId))
          .where(
            and(
              eq(s.timeEntries.companyId, input.companyId),
              eq(s.timeEntries.billable, true),
              eq(s.timeEntries.contractCovered, false),
              eq(s.timeEntries.status, 'approved'),
              isNull(s.timeEntries.invoiceId),
              sql`${s.timeEntries.startedAt}::date between ${input.periodStart}::date and ${input.periodEnd}::date`,
            ),
          )
          .orderBy(asc(s.timeEntries.startedAt));
        for (const { e, ticketNumber, workType, task } of entries) {
          const hours = round2(e.durationMinutes / 60);
          const rate = e.hourlyRate ?? 0;
          const ref = ticketNumber ?? task ?? '';
          lines.push({
            invoiceId: invoice!.id,
            kind: 'time',
            description: `${e.startedAt.toISOString().slice(0, 10)} ${ref}${workType ? ` (${workType})` : ''}: ${e.description}`.slice(0, 500),
            quantity: hours,
            unitPrice: rate,
            amount: round2(hours * rate),
            timeEntryId: e.id,
            sortOrder: order++,
          });
        }
        if (entries.length) {
          await tx.update(s.timeEntries).set({ invoiceId: invoice!.id }).where(inArray(s.timeEntries.id, entries.map((x) => x.e.id)));
        }
      }

      if (input.includeExpenses) {
        const exps = await tx
          .select()
          .from(s.expenses)
          .where(
            and(
              eq(s.expenses.companyId, input.companyId),
              eq(s.expenses.billable, true),
              isNull(s.expenses.invoiceId),
              sql`${s.expenses.expenseDate} between ${input.periodStart}::date and ${input.periodEnd}::date`,
            ),
          );
        for (const x of exps) {
          lines.push({ invoiceId: invoice!.id, kind: 'expense', description: `${x.expenseDate} ${x.description}`, quantity: 1, unitPrice: x.amount, amount: x.amount, expenseId: x.id, sortOrder: order++ });
        }
        if (exps.length) await tx.update(s.expenses).set({ invoiceId: invoice!.id }).where(inArray(s.expenses.id, exps.map((x) => x.id)));
      }

      if (lines.length) await tx.insert(s.invoiceLines).values(lines);
      await recalcInvoice(tx, invoice!.id);
      await audit(tx, req, { action: 'create', entityType: 'invoice', entityId: invoice!.id, summary: `${invoice!.invoiceNumber} draft with ${lines.length} lines` });
      return invoice!.id;
    });
    return reply.status(201).send(await loadInvoice(id));
  });

  app.patch('/invoices/:id', { config: { perm: 'billing.write' } }, async (req) => {
    const id = idOf(req);
    const input = invoiceUpdateSchema.parse(req.body);
    await app.db.transaction(async (tx) => {
      const [inv] = await tx.select().from(s.invoices).where(eq(s.invoices.id, id));
      if (!inv) throw notFound('Invoice');
      const data: Partial<typeof inv> = {};
      if (input.notes !== undefined) data.notes = input.notes;
      if (input.dueDate !== undefined) data.dueDate = input.dueDate;
      if (input.taxRate !== undefined) {
        if (inv.status !== 'draft') throw badRequest('Only draft invoices can be changed');
        data.taxRate = input.taxRate;
      }
      if (input.status && input.status !== inv.status) {
        const allowed: Record<string, string[]> = { draft: ['issued', 'void'], issued: ['paid', 'void'], paid: [], void: [] };
        if (!allowed[inv.status]?.includes(input.status)) throw badRequest(`An invoice cannot move from ${inv.status} to ${input.status}`);
        data.status = input.status;
        if (input.status === 'issued') {
          const settings = await getSystemSettings(tx);
          const issue = new Date().toISOString().slice(0, 10);
          data.issueDate = issue;
          data.dueDate ??= new Date(Date.now() + settings.invoicePaymentTermsDays * 86400_000).toISOString().slice(0, 10);
          await tx.update(s.timeEntries).set({ status: 'billed' }).where(eq(s.timeEntries.invoiceId, id));
        }
        if (input.status === 'void') await releaseInvoice(tx, id);
      }
      await tx.update(s.invoices).set(data).where(eq(s.invoices.id, id));
      await recalcInvoice(tx, id);
      await audit(tx, req, { action: 'update', entityType: 'invoice', entityId: id, changes: data as Record<string, unknown> });
    });
    return loadInvoice(id);
  });

  app.delete('/invoices/:id', { config: { perm: 'billing.write', forceDelete: { table: 'invoices' } } }, async (req) => {
    const id = idOf(req);
    await app.db.transaction(async (tx) => {
      const [inv] = await tx.select().from(s.invoices).where(eq(s.invoices.id, id));
      if (!inv) throw notFound('Invoice');
      if (inv.status !== 'draft') throw inUse('Only draft invoices can be deleted; void issued invoices instead');
      await releaseInvoice(tx, id);
      await tx.delete(s.invoices).where(eq(s.invoices.id, id));
      await audit(tx, req, { action: 'delete', entityType: 'invoice', entityId: id, summary: inv.invoiceNumber });
    });
    return { ok: true };
  });

  app.post('/invoices/:id/lines', { config: { perm: 'billing.write' } }, async (req, reply) => {
    const id = idOf(req);
    const input = invoiceLineSchema.parse(req.body);
    await app.db.transaction(async (tx) => {
      const [inv] = await tx.select().from(s.invoices).where(eq(s.invoices.id, id));
      if (!inv || inv.status !== 'draft') throw badRequest('Lines can only be added to draft invoices');
      await tx.insert(s.invoiceLines).values({ invoiceId: id, kind: 'manual', ...input, amount: round2(input.quantity * input.unitPrice), sortOrder: 9999 });
      await recalcInvoice(tx, id);
    });
    return reply.status(201).send(await loadInvoice(id));
  });

  app.delete('/invoices/:id/lines/:lineId', { config: { perm: 'billing.write' } }, async (req) => {
    const id = idOf(req);
    await app.db.transaction(async (tx) => {
      const [inv] = await tx.select().from(s.invoices).where(eq(s.invoices.id, id));
      if (!inv || inv.status !== 'draft') throw badRequest('Lines can only be removed from draft invoices');
      const [line] = await tx.delete(s.invoiceLines).where(and(eq(s.invoiceLines.id, idOf(req, 'lineId')), eq(s.invoiceLines.invoiceId, id))).returning();
      if (line?.timeEntryId) await tx.update(s.timeEntries).set({ invoiceId: null }).where(eq(s.timeEntries.id, line.timeEntryId));
      if (line?.expenseId) await tx.update(s.expenses).set({ invoiceId: null }).where(eq(s.expenses.id, line.expenseId));
      await recalcInvoice(tx, id);
    });
    return loadInvoice(id);
  });

  app.get('/invoices/:id/pdf', { config: { perm: 'billing.read' } }, async (req, reply) => {
    const inv = await loadInvoice(idOf(req));
    const settings = await getSystemSettings(app.db);
    const doc = new PDFDocument({ size: 'A4', margin: 50, info: { Title: `Invoice ${inv.invoiceNumber}` } });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    const done = new Promise<Buffer>((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));
    const money = (n: number) => formatMoney(n, inv.currency);

    doc.fontSize(20).text(settings.organizationName, 50, 50);
    if (settings.companyAddress) doc.fontSize(9).fillColor('#555').text(settings.companyAddress, 50, 76, { width: 250 });
    doc.fillColor('#000').fontSize(22).text(inv.status === 'draft' ? 'DRAFT INVOICE' : 'INVOICE', 300, 50, { width: 245, align: 'right' });
    doc.fontSize(10).text(`Invoice: ${inv.invoiceNumber}`, 300, 80, { width: 245, align: 'right' });
    doc.text(`Issue date: ${inv.issueDate ?? '—'}`, { width: 245, align: 'right' });
    doc.text(`Due date: ${inv.dueDate ?? '—'}`, { width: 245, align: 'right' });
    doc.text(`Period: ${inv.periodStart} – ${inv.periodEnd}`, { width: 245, align: 'right' });

    const c = inv.company;
    doc.fontSize(10).text('Bill to', 50, 150).fontSize(12).text(c.name);
    doc.fontSize(9).fillColor('#555');
    for (const line of [c.address1, c.address2, [c.postalCode, c.city].filter(Boolean).join(' '), c.country]) if (line) doc.text(line);
    doc.fillColor('#000');

    let y = 240;
    const header = () => {
      doc.fontSize(9).font('Helvetica-Bold');
      doc.text('Description', 50, y).text('Qty', 360, y, { width: 50, align: 'right' }).text('Unit price', 410, y, { width: 65, align: 'right' }).text('Amount', 480, y, { width: 65, align: 'right' });
      doc.font('Helvetica');
      y += 16;
      doc.moveTo(50, y - 4).lineTo(545, y - 4).strokeColor('#ccc').stroke();
    };
    header();
    for (const l of inv.lines) {
      const h = doc.heightOfString(l.description, { width: 300 });
      if (y + h > 760) {
        doc.addPage();
        y = 50;
        header();
      }
      doc.fontSize(9).text(l.description, 50, y, { width: 300 });
      doc.text(String(l.quantity), 360, y, { width: 50, align: 'right' }).text(money(l.unitPrice), 410, y, { width: 65, align: 'right' }).text(money(l.amount), 480, y, { width: 65, align: 'right' });
      y += Math.max(h, 12) + 6;
    }
    y += 10;
    doc.moveTo(350, y).lineTo(545, y).strokeColor('#ccc').stroke();
    y += 8;
    const totalLine = (label: string, value: string, bold = false) => {
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(10).text(label, 350, y, { width: 120 }).text(value, 470, y, { width: 75, align: 'right' });
      y += 16;
    };
    totalLine('Subtotal', money(inv.subtotal));
    totalLine(`Tax (${inv.taxRate}%)`, money(inv.taxAmount));
    totalLine('Total', money(inv.total), true);
    if (inv.notes) doc.font('Helvetica').fontSize(9).text(inv.notes, 50, y + 20, { width: 495 });
    if (settings.invoiceFooter) doc.fontSize(8).fillColor('#777').text(settings.invoiceFooter, 50, 780, { width: 495, align: 'center' });
    doc.end();
    const pdf = await done;
    return reply
      .header('content-type', 'application/pdf')
      .header('content-disposition', `attachment; filename="${inv.invoiceNumber}.pdf"`)
      .send(pdf);
  });
}
