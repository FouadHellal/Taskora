import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { noteImageIds, noteImageMarkdown, noteImagesToText, PORTAL_IMAGE_URL_RE, splitNoteImages } from '@taskora/shared';
import { Client, createTestApp, makeCompany, userClient, type TestContext } from './helpers.js';
import { schema } from '../src/db/client.js';
import { sendCustomerNote } from '../src/jobs/email.js';

interface Sent {
  to: string | string[];
  subject: string;
  text: string;
  attachments?: { filename: string; content: Buffer }[];
}

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4cf0000000049454e44ae426082', 'hex');
const uploads = mkdtempSync(join(tmpdir(), 'taskora-note-images-'));
const sent: Sent[] = [];
const transport = { sendMail: async (m: Sent) => void sent.push(m) } as never;
const api = (p: string) => `/api/v1${p}`;

let ctx: TestContext;
let admin: Client & { userId: number };
let tech: Client & { userId: number };

async function uploadImage(c: Client, ticketId: number, name: string, type = 'image/png') {
  const boundary = '----taskora-image-boundary';
  const payload = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: ${type}\r\n\r\n`),
    PNG,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const res = await ctx.app.inject({
    method: 'POST',
    url: api(`/attachments/ticket/${ticketId}`),
    payload,
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, cookie: c.cookie, 'x-csrf-token': c.csrf },
  });
  expect(res.statusCode).toBe(201);
  return (res.json() as { data: { id: number; fileName: string }[] }).data[0]!;
}

beforeAll(async () => {
  ctx = await createTestApp({ UPLOAD_DIR: uploads }, { mailTransport: transport });
  admin = await userClient(ctx, 'administrator');
  tech = await userClient(ctx, 'technician');
  await admin.put(api('/settings/email'), { enabled: true, host: 'smtp.example.test', port: 587, secure: false, user: '', password: '', from: 'support@example.test', replyTo: '', signature: '' });
});
afterAll(async () => {
  await ctx.close();
  rmSync(uploads, { recursive: true, force: true });
});

describe('note image helpers', () => {
  it('only treats attachment URLs as images', () => {
    const text = `Before\n${noteImageMarkdown('shot [1].png', 12)}\n![x](https://evil.example/a.png) ![y](/api/v1/attachments/file/7) after`;
    const segs = splitNoteImages(text);
    expect(segs.filter((s) => s.type === 'image')).toEqual([
      { type: 'image', alt: 'shot  1 .png', url: '/api/v1/attachments/file/12?inline=true' },
      { type: 'image', alt: 'y', url: '/api/v1/attachments/file/7' },
    ]);
    expect(segs.map((s) => (s.type === 'text' ? s.text : '')).join('')).toContain('![x](https://evil.example/a.png)');
    expect(noteImageIds(text)).toEqual([12, 7]);
    expect(noteImagesToText(text)).toBe('Before\n[image: shot  1 .png]\n![x](https://evil.example/a.png) [image: y] after');
    expect(splitNoteImages('![p](/api/portal/tickets/1/images/2)', [PORTAL_IMAGE_URL_RE])[0]).toMatchObject({ type: 'image' });
    expect(splitNoteImages('![p](/api/portal/tickets/1/images/2)')[0]).toMatchObject({ type: 'text' });
  });
});

describe('pasted images in e-mails and notifications', () => {
  it('e-mails customer notes with the images attached and named in the text', async () => {
    const co = await makeCompany(admin, 'Image Mail Co');
    const contact = await admin.post(api('/contacts'), { companyId: co.id, firstName: 'Ivy', lastName: 'Image', email: 'ivy@image.example' });
    const { body: t } = await tech.post(api('/tickets'), { title: 'Screen flickers', companyId: co.id, contactId: contact.body.id, assignedUserId: tech.userId });
    const img = await uploadImage(tech, t.id, 'screenshot-20261120-101500.png');
    await tech.post(api(`/tickets/${t.id}/watch`), {});
    // Without an admin template the notification carries the note text itself.
    await ctx.db.delete(schema.notificationTemplates).where(eq(schema.notificationTemplates.event, 'ticket.note_added'));

    const body = `See the error:\n${noteImageMarkdown(img.fileName, img.id)}\nPlease restart.`;
    const note = await admin.post(api(`/tickets/${t.id}/notes`), { body, visibility: 'public', notifyContact: true });
    expect(note.status).toBe(201);
    expect(note.body.body).toBe(body);

    expect(await sendCustomerNote(ctx.db, ctx.app.config, note.body.id, transport)).toEqual({ sent: true });
    const m = sent.at(-1)!;
    expect(m.text).toContain('[image: screenshot-20261120-101500.png]');
    expect(m.text).not.toContain('![');
    expect(m.attachments?.map((a) => a.filename)).toEqual(['screenshot-20261120-101500.png']);
    expect(m.attachments![0]!.content.equals(PNG)).toBe(true);

    // The in-app notification (and its e-mail) shows a placeholder, not markdown.
    const rows = await ctx.db.select().from(schema.notifications).where(eq(schema.notifications.userId, tech.userId));
    const n = rows.find((r) => r.type === 'ticket.note_added');
    expect(n?.body).toContain('[image: screenshot-20261120-101500.png]');
  });

  it('sends images pasted into a ticket e-mail as attachments, ignoring files of other tickets', async () => {
    const co = await makeCompany(admin, 'Image Send Co');
    const { body: t } = await tech.post(api('/tickets'), { title: 'Outlook crash', companyId: co.id });
    const { body: other } = await tech.post(api('/tickets'), { title: 'Other', companyId: co.id });
    const mine = await uploadImage(tech, t.id, 'crash.png');
    const foreign = await uploadImage(tech, other.id, 'secret.png');
    const res = await tech.post(api(`/tickets/${t.id}/email`), {
      to: ['user@send.example'],
      subject: 'Crash',
      body: `Here it is ${noteImageMarkdown('crash.png', mine.id)} and ${noteImageMarkdown('secret.png', foreign.id)}`,
      attachmentIds: [mine.id],
    });
    expect(res.status).toBe(201);
    const m = sent.at(-1)!;
    expect(m.text).toContain('Here it is [image: crash.png] and [image: secret.png]');
    expect(m.attachments?.map((a) => a.filename)).toEqual(['crash.png']);
    // The note keeps the image so it renders in the ticket.
    const [noteRow] = await ctx.db.select().from(schema.ticketNotes).where(eq(schema.ticketNotes.id, res.body.noteId));
    expect(noteRow!.body).toContain(`/api/v1/attachments/file/${mine.id}?inline=true`);
  });
});

describe('pasted images in the customer portal', () => {
  it('serves images referenced in customer-visible texts of the contact’s own tickets only', async () => {
    const co = await makeCompany(admin, 'Portal Image Co');
    const ann = (await admin.post(api('/contacts'), { companyId: co.id, firstName: 'Ann', lastName: 'Portal', email: 'ann@portalimg.example' })).body;
    const bob = (await admin.post(api('/contacts'), { companyId: co.id, firstName: 'Bob', lastName: 'Portal', email: 'bob@portalimg.example' })).body;
    const access = await admin.post(api(`/contacts/${ann.id}/portal`), { enabled: true });
    const portal = new Client(ctx.app);
    const login = await portal.post('/api/portal/login', { email: 'ann@portalimg.example', password: access.body.password });
    portal.csrf = login.body.csrfToken;

    const { body: t } = await tech.post(api('/tickets'), { title: 'Printer jam', companyId: co.id, contactId: ann.id });
    const shown = await uploadImage(tech, t.id, 'jam.png');
    const internal = await uploadImage(tech, t.id, 'internal.png');
    const unreferenced = await uploadImage(tech, t.id, 'loose.png');
    await tech.patch(api(`/tickets/${t.id}`), { description: `It jams:\n${noteImageMarkdown('jam.png', shown.id)}` });
    await tech.post(api(`/tickets/${t.id}/notes`), { body: `Internal ${noteImageMarkdown('internal.png', internal.id)}`, visibility: 'internal' });

    const detail = (await portal.get(`/api/portal/tickets/${t.id}`)).body;
    expect(detail.description).toBe(`It jams:\n![jam.png](/api/portal/tickets/${t.id}/images/${shown.id})`);
    expect(JSON.stringify(detail)).not.toContain('/api/v1/attachments');

    const img = await ctx.app.inject({ method: 'GET', url: `/api/portal/tickets/${t.id}/images/${shown.id}`, headers: { cookie: portal.cookie } });
    expect(img.statusCode).toBe(200);
    expect(img.headers['content-type']).toBe('image/png');
    expect(img.rawPayload.equals(PNG)).toBe(true);

    expect((await portal.get(`/api/portal/tickets/${t.id}/images/${internal.id}`)).status).toBe(404);
    expect((await portal.get(`/api/portal/tickets/${t.id}/images/${unreferenced.id}`)).status).toBe(404);

    // Another contact's ticket, and a file of another ticket, are not reachable.
    const { body: bobs } = await tech.post(api('/tickets'), { title: 'Bob ticket', companyId: co.id, contactId: bob.id });
    const bobImg = await uploadImage(tech, bobs.id, 'bob.png');
    await tech.post(api(`/tickets/${bobs.id}/notes`), { body: noteImageMarkdown('bob.png', bobImg.id), visibility: 'public' });
    expect((await portal.get(`/api/portal/tickets/${bobs.id}/images/${bobImg.id}`)).status).toBe(404);
    expect((await portal.get(`/api/portal/tickets/${t.id}/images/${bobImg.id}`)).status).toBe(404);
    expect((await new Client(ctx.app).get(`/api/portal/tickets/${t.id}/images/${shown.id}`)).status).toBe(401);
  });
});
