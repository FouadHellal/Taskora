import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { Client, createTestApp, makeCompany, userClient, type TestContext } from './helpers.js';
import { schema } from '../src/db/client.js';
import { loadConfig } from '../src/config.js';
import { sendClientReplyAlert, sendReportPublishedEmails, sendTicketCreatedEmails, sendTicketResolvedEmail } from '../src/jobs/client-email.js';
import { runMonthlyReports } from '../src/modules/client-reports/service.js';
import { renderSignature, sanitizeEmailHtml } from '../src/lib/mail-template.js';
import { imapHostFor } from '../src/lib/imap-settings.js';

let ctx: TestContext;
let admin: Client & { userId: number };
let lookups: any;
const smtp = loadConfig({ NODE_ENV: 'test', SMTP_HOST: 'smtp.example.test', SMTP_FROM: 'it@example.test', PUBLIC_URL: 'https://psa.example.test' });
const ciType = (name: string) => lookups.ciTypes.find((t: { name: string }) => t.name === name).id;
const thisMonth = new Date().toISOString().slice(0, 7);

type Mail = { to: string | string[]; subject: string; text: string; html: string };
function mailbox() {
  const sent: Mail[] = [];
  return { sent, transport: { sendMail: async (m: Mail) => void sent.push(m) } as never };
}

beforeAll(async () => {
  ctx = await createTestApp();
  admin = await userClient(ctx, 'administrator');
  lookups = (await admin.get('/api/v1/lookups')).body;
  await admin.put('/api/v1/settings/system', { staffAlertEmails: 'alerts@team.example, Second@Team.example' });
});
afterAll(async () => ctx.close());

async function portalLogin(email: string, password: string) {
  const c = new Client(ctx.app);
  const res = await c.post('/api/portal/login', { email, password });
  if (res.status !== 200) throw new Error(JSON.stringify(res.body));
  c.csrf = res.body.csrfToken;
  return c;
}

/** A company with Mia (manager) and Noah (user), both with portal access. */
async function clientCompany(name: string) {
  const co = await makeCompany(admin, name);
  const slug = name.toLowerCase().replace(/[^a-z]/g, '');
  const mia = (await admin.post('/api/v1/contacts', { companyId: co.id, firstName: 'Mia', lastName: 'Manager', email: `mia@${slug}.example` })).body;
  const noah = (await admin.post('/api/v1/contacts', { companyId: co.id, firstName: 'Noah', lastName: 'User', email: `noah@${slug}.example` })).body;
  const miaPw = (await admin.post(`/api/v1/contacts/${mia.id}/portal`, { enabled: true, role: 'manager' })).body.password;
  const noahPw = (await admin.post(`/api/v1/contacts/${noah.id}/portal`, { enabled: true })).body.password;
  return { co, mia, noah, miaPortal: await portalLogin(mia.email, miaPw), noahPortal: await portalLogin(noah.email, noahPw) };
}

describe('system settings', () => {
  it('saving one setting keeps the others', async () => {
    await admin.put('/api/v1/settings/system', { organizationName: 'Sirius Networking', currency: 'DZD' });
    const saved = (await admin.put('/api/v1/settings/system', { portalShowTime: true })).body;
    expect(saved).toMatchObject({ organizationName: 'Sirius Networking', currency: 'DZD', staffAlertEmails: 'alerts@team.example, Second@Team.example' });
  });
});

describe('proactive e-mails', () => {
  it('alerts the IT team and confirms to the client when a ticket is opened, once', async () => {
    const { co, noah, noahPortal } = await clientCompany('Mail Alpha');
    const { sent, transport } = mailbox();
    const created = await noahPortal.post('/api/portal/tickets', { title: 'Outlook keeps crashing', description: 'Since this morning.' });
    expect(created.status).toBe(201);
    const jobs = await ctx.db.select().from(schema.jobs).where(eq(schema.jobs.type, 'email.ticket_created'));
    expect(jobs.some((j) => j.payload.ticketId === created.body.id)).toBe(true);

    expect(await sendTicketCreatedEmails(ctx.db, smtp, created.body.id, transport)).toEqual({ staff: 2, client: 1 });
    const staff = sent.find((m) => Array.isArray(m.to))!;
    expect(staff.to).toEqual(['alerts@team.example', 'second@team.example']);
    expect(staff.subject).toBe(`[${created.body.ticketNumber}] New ticket – ${co.name}: Outlook keeps crashing`);
    expect(staff.html).toContain('Client portal (Noah User)');
    expect(staff.html).toContain(`https://psa.example.test/tickets/${created.body.id}`);
    const client = sent.find((m) => m.to === noah.email)!;
    expect(client.subject).toBe(`[${created.body.ticketNumber}] We have received your request: Outlook keeps crashing`);
    expect(client.html).toContain('We have received your request');
    expect(client.html).toContain(`https://psa.example.test/portal/tickets/${created.body.id}`);
    expect(client.text).toContain('Since this morning.');

    // A retried job never mails twice.
    expect(await sendTicketCreatedEmails(ctx.db, smtp, created.body.id, transport)).toEqual({ staff: 0, client: 0 });
    // Tickets opened by the IT team are confirmed too, in the organization language.
    await admin.put('/api/v1/settings/system', { language: 'fr' });
    const byTeam = (await admin.post('/api/v1/tickets', { title: 'Nouveau poste', companyId: co.id, contactId: noah.id })).body;
    sent.length = 0;
    await sendTicketCreatedEmails(ctx.db, smtp, byTeam.id, transport);
    await admin.put('/api/v1/settings/system', { language: 'en' });
    expect(sent.find((m) => m.to === noah.email)!.subject).toContain('Nous avons bien reçu votre demande');
    expect(sent.find((m) => Array.isArray(m.to))!.html).toContain('Équipe IT');
  });

  it('respects client preferences and sends manager copies on request', async () => {
    const { co, mia, noah, miaPortal, noahPortal } = await clientCompany('Mail Beta');
    const prefs = await noahPortal.get('/api/portal/profile/notifications');
    expect(prefs.body.preferences).toMatchObject({ ticketCreated: true, ticketResolved: true, companyTickets: false });
    expect((await noahPortal.put('/api/portal/profile/notifications', { ticketCreated: false, companyTickets: true })).body.preferences).toMatchObject({
      ticketCreated: false,
      companyTickets: false, // only managers can ask for copies
    });
    await miaPortal.put('/api/portal/profile/notifications', { companyTickets: true });

    const { sent, transport } = mailbox();
    const t = (await admin.post('/api/v1/tickets', { title: 'VPN down', companyId: co.id, contactId: noah.id })).body;
    await sendTicketCreatedEmails(ctx.db, smtp, t.id, transport);
    expect(sent.map((m) => m.to)).toEqual([['alerts@team.example', 'second@team.example'], mia.email]);
    expect(sent[1]!.html).toContain('New request for Mail Beta');

    // Master switch off: only the IT team is told.
    await admin.put('/api/v1/settings/system', { clientEmailsEnabled: false });
    sent.length = 0;
    const t2 = (await admin.post('/api/v1/tickets', { title: 'Printer', companyId: co.id, contactId: mia.id })).body;
    await sendTicketCreatedEmails(ctx.db, smtp, t2.id, transport);
    await admin.put('/api/v1/settings/system', { clientEmailsEnabled: true });
    expect(sent.map((m) => m.to)).toEqual([['alerts@team.example', 'second@team.example']]);
  });

  it('tells the client when the ticket is resolved, and the IT team when the client replies', async () => {
    const { co, mia, miaPortal } = await clientCompany('Mail Gamma');
    const { sent, transport } = mailbox();
    const t = (await admin.post('/api/v1/tickets', { title: 'Slow laptop', companyId: co.id, contactId: mia.id })).body;
    expect(await sendTicketResolvedEmail(ctx.db, smtp, t.id, transport)).toEqual({ sent: false });
    const resolved = lookups.statuses.find((x: { category: string }) => x.category === 'resolved');
    expect((await admin.patch(`/api/v1/tickets/${t.id}`, { statusId: resolved.id, resolution: 'Replaced the disk with an SSD.' })).status).toBe(200);
    const job = await ctx.db.select().from(schema.jobs).where(and(eq(schema.jobs.type, 'email.ticket_updated'), eq(schema.jobs.dedupeKey, `email.ticket_updated:${t.id}`)));
    expect(job).toHaveLength(1);
    expect(await sendTicketResolvedEmail(ctx.db, smtp, t.id, transport)).toEqual({ sent: true });
    expect(await sendTicketResolvedEmail(ctx.db, smtp, t.id, transport)).toEqual({ sent: false });
    expect(sent[0]).toMatchObject({ to: mia.email, subject: `[${t.ticketNumber}] Your request has been resolved: Slow laptop` });
    expect(sent[0]!.html).toContain('Replaced the disk with an SSD.');

    const reply = await miaPortal.post(`/api/portal/tickets/${t.id}/replies`, { body: 'Still slow when I open Excel.' });
    expect(reply.status).toBe(201);
    const [replyJob] = await ctx.db.select().from(schema.jobs).where(eq(schema.jobs.type, 'email.client_reply'));
    sent.length = 0;
    expect(await sendClientReplyAlert(ctx.db, smtp, Number(replyJob!.payload.noteId), transport)).toEqual({ sent: 2 });
    expect(sent[0]!.subject).toBe(`[${t.ticketNumber}] Client reply from Mia Manager: Slow laptop`);
    expect(sent[0]!.html).toContain('Still slow when I open Excel.');
    expect(await sendClientReplyAlert(ctx.db, smtp, Number(replyJob!.payload.noteId), transport)).toEqual({ sent: 0 });
  });
});

describe('monthly client reports', () => {
  it('prepares, publishes and e-mails a report that only managers see', async () => {
    const { co, mia, miaPortal, noahPortal } = await clientCompany('Report Co');
    await admin.post('/api/v1/configuration-items', { name: 'RC-LT-01', ciTypeId: ciType('Laptop'), companyId: co.id });
    await admin.post('/api/v1/configuration-items', { name: 'RC-SRV-01', ciTypeId: ciType('Server'), companyId: co.id });
    await admin.post('/api/v1/tickets', { title: 'Report ticket', companyId: co.id, contactId: mia.id });

    const r = await admin.post('/api/v1/client-reports', { companyId: co.id, period: thisMonth });
    expect(r.status).toBe(201);
    expect(r.body.status).toBe('draft');
    expect(r.body.data.tickets.opened).toBe(1);
    expect(r.body.data.devices.total).toBe(2);
    expect(r.body.data.work.trend).toHaveLength(6);
    expect(r.body.data.health.score).toBeTypeOf('number');

    // Drafts are invisible to the client.
    expect((await miaPortal.get('/api/portal/reports')).body).toEqual([]);
    expect((await miaPortal.get(`/api/portal/reports/${r.body.id}`)).status).toBe(404);

    await admin.patch(`/api/v1/client-reports/${r.body.id}`, { summary: 'All good this month.', hiddenSections: ['devices'] });
    const pub = await admin.post(`/api/v1/client-reports/${r.body.id}/publish`, { notify: true });
    expect(pub.body.status).toBe('published');
    expect((await admin.post('/api/v1/client-reports', { companyId: co.id, period: thisMonth })).status).toBe(409);

    const list = (await miaPortal.get('/api/portal/reports')).body;
    expect(list).toHaveLength(1);
    const view = (await miaPortal.get(`/api/portal/reports/${r.body.id}`)).body;
    expect(view.summary).toBe('All good this month.');
    expect(view.data.devices).toBeUndefined();
    expect(view.data.tickets.opened).toBe(1);
    expect((await noahPortal.get('/api/portal/reports')).status).toBe(403);

    const { sent, transport } = mailbox();
    expect(await sendReportPublishedEmails(ctx.db, smtp, r.body.id, transport)).toEqual({ sent: 1 });
    expect(sent[0]!.to).toBe(mia.email);
    expect(sent[0]!.html).toContain(`https://psa.example.test/portal/reports/${r.body.id}`);
    expect(await sendReportPublishedEmails(ctx.db, smtp, r.body.id, transport)).toEqual({ sent: 0 });
  });

  it('prepares last month for every client company automatically, without duplicates', async () => {
    await clientCompany('Auto Report Co');
    const first = await runMonthlyReports(ctx.db, smtp, '2026-01');
    expect(first.created).toBeGreaterThan(0);
    expect(first.published).toBe(0); // default mode: drafts for review
    const second = await runMonthlyReports(ctx.db, smtp, '2026-01');
    expect(second.created).toBe(0);
    const listed = (await admin.get('/api/v1/client-reports?period=2026-01')).body;
    expect(listed.data.every((x: { status: string; source: string }) => x.status === 'draft' && x.source === 'auto')).toBe(true);
    expect(listed.automation.mode).toBe('draft');
  });
});

describe('service agreement in the portal', () => {
  it('prices per device, counts devices automatically and shows totals per month, quarter and year', async () => {
    const { co, miaPortal, noahPortal } = await clientCompany('Billing Co');
    const laptopSvc = (await admin.post('/api/v1/services', { name: 'Laptop management', unitPrice: 180, period: 'monthly', quantitySource: 'devices', ciTypeId: ciType('Laptop') })).body;
    const serverSvc = (await admin.post('/api/v1/services', { name: 'Server management', unitPrice: 2000, period: 'monthly', quantitySource: 'devices', ciTypeId: ciType('Server') })).body;
    expect(laptopSvc.quantitySource).toBe('devices');
    for (const n of ['BC-LT-1', 'BC-LT-2']) await admin.post('/api/v1/configuration-items', { name: n, ciTypeId: ciType('Laptop'), companyId: co.id });
    await admin.post('/api/v1/configuration-items', { name: 'BC-SRV-1', ciTypeId: ciType('Server'), companyId: co.id });
    const contract = (
      await admin.post('/api/v1/contracts', { name: 'Managed IT', companyId: co.id, type: 'recurring', startDate: '2026-01-01', endDate: '2026-12-31', billingPeriod: 'quarterly', autoRenew: true })
    ).body;
    expect(contract.autoRenew).toBe(true);
    await admin.post(`/api/v1/contracts/${contract.id}/services`, { serviceId: laptopSvc.id, quantity: 1, autoQuantity: true });
    await admin.post(`/api/v1/contracts/${contract.id}/services`, { serviceId: serverSvc.id, quantity: 1, autoQuantity: true });

    const detail = (await admin.get(`/api/v1/contracts/${contract.id}`)).body;
    expect(detail.services.map((x: { serviceName: string; quantity: number }) => [x.serviceName, x.quantity])).toEqual([
      ['Laptop management', 2],
      ['Server management', 1],
    ]);

    const bill = (await miaPortal.get('/api/portal/billing')).body;
    expect(bill.agreements).toHaveLength(1);
    const a = bill.agreements[0];
    expect(a).toMatchObject({ name: 'Managed IT', billingPeriod: 'quarterly', billingMonths: 3, autoRenew: true });
    expect(a.totals).toEqual({ monthly: 2360, perPeriod: 7080, annual: 28320 });
    expect(a.services.map((x: { name: string; quantity: number; unitPrice: number; ciTypeName: string }) => [x.name, x.quantity, x.unitPrice, x.ciTypeName])).toEqual([
      ['Laptop management', 2, 180, 'Laptop'],
      ['Server management', 1, 2000, 'Server'],
    ]);
    expect(JSON.stringify(bill)).not.toContain('unitCost');

    // A new laptop is counted the next time the page is opened.
    await admin.post('/api/v1/configuration-items', { name: 'BC-LT-3', ciTypeId: ciType('Laptop'), companyId: co.id });
    expect((await miaPortal.get('/api/portal/billing')).body.totals.monthly).toBe(2540);

    // Users cannot see prices; hidden contracts are not shown.
    expect((await noahPortal.get('/api/portal/billing')).status).toBe(403);
    await admin.patch(`/api/v1/contracts/${contract.id}`, { portalVisible: false });
    expect((await miaPortal.get('/api/portal/billing')).body.agreements).toEqual([]);

    const me = (await miaPortal.get('/api/portal/me')).body;
    expect(me.features).toMatchObject({ reports: true, billing: true });
    expect((await noahPortal.get('/api/portal/me')).body.features).toMatchObject({ reports: false, billing: false });
    expect((await miaPortal.get('/api/portal/company-logo')).status).toBe(404);
    const insights = (await miaPortal.get('/api/portal/dashboard/insights')).body;
    expect(insights.devices.length).toBeGreaterThan(0);
    expect(insights.trend).toHaveLength(6);
    expect(insights).toHaveProperty('health');
  });
});

describe('mailboxes and signatures', () => {
  it('sends client e-mails to the main address, a second mailbox or both', async () => {
    const { co, noah, noahPortal } = await clientCompany('Mailbox Co');
    expect((await noahPortal.put('/api/portal/profile/notifications', { notifyMode: 'other' })).status).toBe(400);
    const saved = await noahPortal.put('/api/portal/profile/notifications', { notifyEmail: 'IT-Inbox@Mailbox.example', notifyMode: 'other' });
    expect(saved.body).toMatchObject({ notifyMode: 'other', sendsTo: ['it-inbox@mailbox.example'] });
    const { sent, transport } = mailbox();
    const t1 = (await admin.post('/api/v1/tickets', { title: 'Scanner', companyId: co.id, contactId: noah.id })).body;
    await sendTicketCreatedEmails(ctx.db, smtp, t1.id, transport);
    expect(sent.map((m) => m.to)).toContain('it-inbox@mailbox.example');
    expect(sent.map((m) => m.to)).not.toContain(noah.email);

    await noahPortal.put('/api/portal/profile/notifications', { notifyMode: 'both' });
    sent.length = 0;
    const t2 = (await admin.post('/api/v1/tickets', { title: 'Screen', companyId: co.id, contactId: noah.id })).body;
    await sendTicketCreatedEmails(ctx.db, smtp, t2.id, transport);
    expect(sent.find((m) => Array.isArray(m.to) && m.to.includes(noah.email))!.to).toEqual([noah.email, 'it-inbox@mailbox.example']);
    expect((await noahPortal.put('/api/portal/profile/notifications', { notifyEmail: 'not-an-address' })).status).toBe(400);
  });

  it('renders HTML signatures safely, with placeholders, and keeps the organization name out of subjects', async () => {
    const sig = renderSignature('<table><tr><td><img src="{{logo}}" onerror="x()"><b>{{sender}}</b></td></tr></table><script>alert(1)</script><a href="javascript:alert(1)">x</a>', {
      sender: 'Zakaria <T>',
      organization: 'Sirius',
      logo: 'https://psa.example.test/api/v1/logos/email',
      portal: '',
    })!;
    expect(sig.html).toContain('<b>Zakaria &lt;T&gt;</b>');
    expect(sig.html).toContain('src="https://psa.example.test/api/v1/logos/email"');
    expect(sig.html).not.toMatch(/script|onerror|javascript:/i);
    expect(sig.text).toContain('Zakaria <T>');
    expect(sanitizeEmailHtml('<p style="color:red">ok</p><iframe src="x"></iframe>')).toBe('<p style="color:red">ok</p>');
    expect(renderSignature('Kind regards,\n{{sender}}', { sender: 'Mia', organization: 'O', logo: '', portal: '' })!.text).toBe('Kind regards,\nMia');

    // The stored signature is appended to client e-mails; subjects carry no organization prefix.
    await admin.put('/api/v1/settings/email', { enabled: false, host: '', port: 587, secure: false, from: '', signature: '<div class="sig">Best, <b>{{sender}}</b> — {{organization}}</div>' });
    await admin.put('/api/v1/settings/system', { organizationName: 'Fouad Org', emailHeaderColor: '#0b0b14', emailAccentColor: '#8c52ff' });
    const { co, mia } = await clientCompany('Signature Co');
    const { sent, transport } = mailbox();
    const t = (await admin.post('/api/v1/tickets', { title: 'Wi-Fi', companyId: co.id, contactId: mia.id })).body;
    await sendTicketCreatedEmails(ctx.db, smtp, t.id, transport);
    const client = sent.find((m) => m.to === mia.email)!;
    expect(client.html).toContain('<div class="sig">Best, <b>The Fouad Org team</b> — Fouad Org</div>');
    expect(client.html).toContain('background:#0b0b14');
    expect(client.html).toContain('#8c52ff');
    expect(client.text).toContain('Best, The Fouad Org team');
    expect(sent.every((m) => !m.subject.includes('[Fouad Org]'))).toBe(true);
    expect(imapHostFor('smtp.gmail.com')).toBe('imap.gmail.com');
    expect(imapHostFor('smtp.example.com')).toBe('imap.example.com');
  });
});
