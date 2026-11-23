import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { createTestApp, makeCompany, userClient, type Client, type TestContext } from './helpers.js';
import { schema } from '../src/db/client.js';
import { loadConfig } from '../src/config.js';
import { nameFromSender, processInboundEmail } from '../src/jobs/inbound-email.js';
import { analyzeTicket, detectTopics } from '../src/modules/tickets/insights.js';

let ctx: TestContext;
let admin: Client & { userId: number };
let lookups: any;
const config = loadConfig({ NODE_ENV: 'test', UPLOAD_DIR: './.data/test-uploads' });
let n = 0;
const mail = (from: string, subject: string, text = 'Hello', fromName?: string) =>
  processInboundEmail(ctx.db, config, { messageId: `<match-${++n}@example>`, fromAddress: from, fromName: fromName ?? null, subject, text });

beforeAll(async () => {
  ctx = await createTestApp();
  admin = await userClient(ctx, 'administrator');
  lookups = (await admin.get('/api/v1/lookups')).body;
});
afterAll(async () => ctx.close());

describe('company e-mail domains', () => {
  it('normalizes domains, keeps them unique and refuses public mail domains', async () => {
    const co = await makeCompany(admin, 'Les Aures School');
    const saved = await admin.patch(`/api/v1/companies/${co.id}`, { emailDomains: ['@LesAures.com', 'https://www.lesaures.com/', 'lesaures-school.dz'] });
    expect(saved.body.emailDomains).toEqual(['lesaures.com', 'lesaures-school.dz']);
    const other = await makeCompany(admin, 'Copycat');
    const dup = await admin.patch(`/api/v1/companies/${other.id}`, { emailDomains: ['lesaures.com'] });
    expect(dup.status).toBe(400);
    expect(dup.body.error.message).toContain('Les Aures School');
    expect((await admin.patch(`/api/v1/companies/${other.id}`, { emailDomains: ['gmail.com'] })).status).toBe(400);
  });

  it('opens tickets only for known contacts or company domains, creating the contact', async () => {
    const co = (await admin.get('/api/v1/companies?q=Les%20Aures')).body.data[0];
    const r = await mail('Jean.Dupont@lesaures.com', 'Imprimante en panne', 'Bonjour, l’imprimante ne marche plus.', 'Jean Dupont');
    expect(r.status).toBe('created');
    const ticket = (await admin.get(`/api/v1/tickets/${r.ticketId}`)).body;
    expect(ticket.companyId).toBe(co.id);
    const [contact] = await ctx.db.select().from(schema.contacts).where(eq(schema.contacts.id, ticket.contactId));
    expect(contact).toMatchObject({ firstName: 'Jean', lastName: 'Dupont', email: 'jean.dupont@lesaures.com', companyId: co.id });
    const [log] = await ctx.db.select().from(schema.inboundEmails).where(eq(schema.inboundEmails.ticketId, r.ticketId!));
    expect(log!.detail).toBe('New contact created: Jean Dupont');

    // The same person again: no second contact.
    const again = await mail('jean.dupont@lesaures.com', 'Autre souci');
    expect((await admin.get(`/api/v1/tickets/${again.ticketId}`)).body.contactId).toBe(contact!.id);

    // A contact with a personal address is matched through the contact, not the domain.
    const amina = (await admin.post('/api/v1/contacts', { companyId: co.id, firstName: 'Amina', lastName: 'Belkacem', email: 'amina.b@gmail.com' })).body;
    const viaContact = await mail('amina.b@gmail.com', 'Wi-Fi');
    expect((await admin.get(`/api/v1/tickets/${viaContact.ticketId}`)).body).toMatchObject({ companyId: co.id, contactId: amina.id });

    // Anybody else is refused (no fallback company set).
    expect((await mail('stranger@unknown-domain.example', 'Hi')).status).toBe('rejected');
    expect((await mail('someone@gmail.com', 'Hi')).status).toBe('rejected');
  });

  it('attributes replies to the contact (or technician) who wrote them', async () => {
    const co = (await admin.get('/api/v1/companies?q=Les%20Aures')).body.data[0];
    const r = await mail('karim@lesaures.com', 'Écran noir', 'Mon écran reste noir.', 'Karim Haddad');
    const t = (await admin.get(`/api/v1/tickets/${r.ticketId}`)).body;
    // A colleague from the same school answers on the thread: a contact is created for her.
    const reply = await mail('Sara.Ali@lesaures.com', `RE: [${t.ticketNumber}] Écran noir`, 'Le câble était débranché, merci !\n\nOn Mon, X wrote:\n> old', 'Sara Ali');
    expect(reply).toMatchObject({ status: 'appended', ticketId: t.id });
    const notes = await ctx.db.select().from(schema.ticketNotes).where(and(eq(schema.ticketNotes.ticketId, t.id), eq(schema.ticketNotes.kind, 'email')));
    const sara = await ctx.db.select().from(schema.contacts).where(eq(schema.contacts.email, 'sara.ali@lesaures.com'));
    expect(sara[0]!.companyId).toBe(co.id);
    expect(notes.at(-1)).toMatchObject({ contactId: sara[0]!.id, body: 'Le câble était débranché, merci !', visibility: 'public' });
    const timeline = (await admin.get(`/api/v1/tickets/${t.id}/timeline`)).body;
    expect(timeline.data.find((i: any) => i.kind === 'note' && i.note.kind === 'email').contactName).toBe('Sara Ali');

    // A technician answering from their own mailbox is the author.
    const me = (await admin.get('/api/v1/auth/me')).body;
    await mail(me.user?.email ?? me.email, `RE: [${t.ticketNumber}] Écran noir`, 'Parfait, je clôture.');
    const [staffNote] = await ctx.db.select().from(schema.ticketNotes).where(and(eq(schema.ticketNotes.ticketId, t.id), eq(schema.ticketNotes.userId, admin.userId)));
    expect(staffNote).toMatchObject({ contactId: null, body: 'Parfait, je clôture.' });
  });

  it('builds names for new contacts', () => {
    expect(nameFromSender('jean.dupont@x.com')).toEqual({ firstName: 'Jean', lastName: 'Dupont' });
    expect(nameFromSender('j@x.com', 'Marie Claire Martin')).toEqual({ firstName: 'Marie Claire', lastName: 'Martin' });
    expect(nameFromSender('info@x.com')).toEqual({ firstName: 'Info', lastName: '-' });
  });
});

describe('ticket interpretation', () => {
  it('detects topics in French and English', () => {
    expect(detectTopics("Mon compte AD est verrouillé, je n'arrive plus à me connecter").map((t) => t.key)[0]).toBe('account');
    expect(detectTopics('The printer shows a paper jam').map((t) => t.key)).toContain('printer');
    expect(detectTopics('Mon ordinateur portable est très lent').map((t) => t.key)).toContain('computer');
    expect(detectTopics('Adresse de livraison')).toEqual([]);
  });

  it('adds one internal note, links the device named in the message and flags urgency', async () => {
    const co = await makeCompany(admin, 'Insight Co');
    const ciType = (name: string) => lookups.ciTypes.find((x: { name: string }) => x.name === name).id;
    const contact = (await admin.post('/api/v1/contacts', { companyId: co.id, firstName: 'Lina', lastName: 'Kaci', email: 'lina@insight.example' })).body;
    const printer = (await admin.post('/api/v1/configuration-items', { name: 'PRN-ACCUEIL', ciTypeId: ciType('Printer'), companyId: co.id })).body;
    const laptop = (await admin.post('/api/v1/configuration-items', { name: 'LT-LINA', ciTypeId: ciType('Laptop'), companyId: co.id, contactId: contact.id })).body;
    const past = (await admin.post('/api/v1/tickets', { title: 'Imprimante accueil bourrage papier', companyId: co.id, contactId: contact.id })).body;
    const resolved = lookups.statuses.find((x: { category: string }) => x.category === 'resolved');
    await admin.patch(`/api/v1/tickets/${past.id}`, { statusId: resolved.id, resolution: 'Retiré le papier coincé dans le bac 2.' });

    const t = (await admin.post('/api/v1/tickets', { title: 'Imprimante accueil bloquée', description: 'URGENT : PRN-ACCUEIL affiche bourrage papier, tout le monde est bloqué.', companyId: co.id, contactId: contact.id })).body;
    expect(await analyzeTicket(ctx.db, t.id)).toMatchObject({ added: true, linkedDeviceId: printer.id });
    expect(await analyzeTicket(ctx.db, t.id)).toEqual({ added: false });
    const [note] = await ctx.db.select().from(schema.ticketNotes).where(and(eq(schema.ticketNotes.ticketId, t.id), eq(schema.ticketNotes.kind, 'insight')));
    expect(note!.visibility).toBe('internal');
    expect(note!.body).toContain('Printer / scanner');
    expect(note!.body).toContain('PRN-ACCUEIL (Printer) — linked to the ticket');
    expect(note!.body).toContain('Urgency');
    expect(note!.body).toContain(`${past.ticketNumber} "Imprimante accueil bourrage papier"`);
    expect(note!.body).toContain('Retiré le papier coincé');
    expect(note!.body).toContain('First checks');
    expect((await admin.get(`/api/v1/tickets/${t.id}`)).body.configurationItemId).toBe(printer.id);

    // Not named: the requester's own laptop is suggested, not linked.
    const t2 = (await admin.post('/api/v1/tickets', { title: 'Mon ordinateur portable est très lent', companyId: co.id, contactId: contact.id })).body;
    await analyzeTicket(ctx.db, t2.id);
    const [n2] = await ctx.db.select().from(schema.ticketNotes).where(and(eq(schema.ticketNotes.ticketId, t2.id), eq(schema.ticketNotes.kind, 'insight')));
    expect(n2!.body).toContain('LT-LINA (Laptop) — assigned to the requester');
    expect((await admin.get(`/api/v1/tickets/${t2.id}`)).body.configurationItemId).toBeNull();
    expect(laptop.id).toBeTruthy();

    // French organization: the note is written in French; it can be turned off.
    await admin.put('/api/v1/settings/system', { language: 'fr' });
    const t3 = (await admin.post('/api/v1/tickets', { title: 'Mot de passe oublié', companyId: co.id, contactId: contact.id })).body;
    await analyzeTicket(ctx.db, t3.id);
    const [n3] = await ctx.db.select().from(schema.ticketNotes).where(and(eq(schema.ticketNotes.ticketId, t3.id), eq(schema.ticketNotes.kind, 'insight')));
    expect(n3!.body).toContain('Compte / mot de passe / Active Directory');
    await admin.put('/api/v1/settings/system', { language: 'en', ticketInsightsEnabled: false });
    const t4 = (await admin.post('/api/v1/tickets', { title: 'Printer', companyId: co.id })).body;
    expect(await analyzeTicket(ctx.db, t4.id)).toEqual({ added: false });
    await admin.put('/api/v1/settings/system', { ticketInsightsEnabled: true });
  });
});
