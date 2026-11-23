/**
 * In-app help (Help & Guides). Markdown; internal links (starting with /) open inside Taskora.
 * Keep these short and task-oriented: "how do I …".
 */
export interface HelpArticle {
  slug: string;
  title: string;
  summary: string;
  group: 'Start here' | 'Daily work' | 'Customers & assets' | 'Business' | 'Administration' | 'Automation';
  body: string;
}

export const HELP_ARTICLES: HelpArticle[] = [
  {
    slug: 'getting-started',
    title: 'Getting started',
    group: 'Start here',
    summary: 'The 10-minute tour: what to set up first and where everything lives.',
    body: `
Taskora is a PSA (Professional Services Automation) tool: tickets, customers, assets, time, contracts and invoices in one place.

### First steps for an administrator
1. **Settings → Regional & display** ([open](/settings?tab=org)): pick your currency, default language, date format and time zone.
2. **Settings → General & numbering** ([open](/admin/system)): organization name, logo, ticket number prefix (e.g. \`TKA-\`).
3. **Users & roles** ([open](/admin/users)): invite technicians. *Administrator* is the super admin (every permission).
4. **Ticket settings** ([open](/admin/ticket-settings)): statuses, priorities, queues, issue types — rename or add your own.
5. **E-mail**: outgoing mail in [E-mail (SMTP)](/admin/email) and incoming mail in [E-mail to ticket](/settings?tab=email).
6. **Companies**: create your customers or import them from CSV in [Data import](/admin/import) (Autotask exports work).

### Finding your way
- The **left menu** is grouped by area (Service Desk, Customers, Assets, Business…).
- The **search bar** at the top (or **Ctrl K**) finds tickets, companies, contacts and devices, and jumps to any page.
- The **⚙ gear** at the top right opens **Settings** — every configurable thing is listed there, with a search box.
- The **?** opens these guides.
`,
  },
  {
    slug: 'tickets',
    title: 'Working a ticket',
    group: 'Daily work',
    summary: 'Ticket window, notes, time entries, pasting screenshots, resolving and merging.',
    body: `
### Opening tickets
By default a ticket opens **in its own window**, like Autotask, so you can keep the ticket list open next to it.
- Change this for yourself in [Settings → My preferences](/settings?tab=me) ("When I open a ticket").
- **Ctrl/⌘-click** or middle-click opens a normal browser tab instead.
- If nothing opens, your browser blocked the pop-up: allow pop-ups for the Taskora address.
- Links inside the ticket window (company, contact, device…) open in the main window.

### The ticket page
- **Header**: title (click to edit), status, priority, assignee, queue and SLA — click any of them to change it.
- **Summary strip**: time worked, number of notes, time entries and attachments — click to jump to that tab.
- **Tabs**:
  - **Notes** — write a note at the top. *Internal* notes are for your team; *customer-visible* notes can be e-mailed to the contact.
  - **Time entries** — every piece of logged work with date, technician, work type, duration and whether it is billable or covered by a contract. Use **New time entry** or the **timer**.
  - **Activity** — everything that happened (notes, time, field changes, e-mails) in order.
  - **Attachments**, **Related tickets**, **Knowledge** (linked KB articles), plus any **custom tabs** your administrator created.
- **Right side**: contact, device (CI), classification, contract & SLA, dates, tags, watchers, custom fields.

### Pasting screenshots and images
In a note, the description, the resolution or a time entry, just **paste** (Ctrl V) a screenshot or **drag** an image in. It is uploaded as a ticket attachment and shown inline. Customers receive e-mails with a reference to the image instead of the picture itself.

### Resolving
Set the status to a *resolved* or *complete* status. Taskora asks for a resolution text and can add it as a customer-visible note.

### Merging duplicates
**⋯ → Merge into another ticket** moves notes, time, attachments, checklist and watchers to the ticket you keep and closes this one.
`,
  },
  {
    slug: 'time',
    title: 'Time entries & the timer',
    group: 'Daily work',
    summary: 'Log time, use the timer, approvals and what "billable" and "covered" mean.',
    body: `
- **Log time** from a ticket (**New time entry**), a project task, or [Time entries](/time).
- The **timer** (top bar) runs on one ticket at a time; stopping it opens a pre-filled time entry.
- **Work type** sets the default rate and whether the time is billable.
- **Billable** time appears in [Billing review](/billing) and on invoices. **Covered** time is included in the customer's contract (block hours, retainer, recurring service) and is not billed separately — unless the contract has run out of hours, in which case the excess is billed as overage.
- If your administrator turned on approvals, time must be **approved** before it can be invoiced.
- Time that is already on an invoice cannot be changed; remove it from the draft invoice first.
`,
  },
  {
    slug: 'companies',
    title: 'Companies, contacts and assets',
    group: 'Customers & assets',
    summary: 'Customer records, contacts, locations and configuration items (CIs).',
    body: `
- A **company** page shows everything for that customer: tickets, contacts, assets, contracts, projects, documentation and activity.
- **Contacts** belong to one company; they are the people who raise tickets and receive e-mails.
- **Configuration items (CIs)** are the customer's devices, licences and services. Their types are managed in [CI types](/admin/system?tab=ci-types). Link a CI to a ticket from the ticket's *Device* card.
- **Custom fields** let you store your own information on companies, contacts, CIs, tickets and more — see *Custom fields & ticket tabs*.
- To retire a customer, set it **inactive**. A super administrator can also delete it completely — see *Deleting records*.
`,
  },
  {
    slug: 'contracts',
    title: 'Contracts & billing',
    group: 'Business',
    summary: 'Contract types, block hours, recurring fees, the billing preview and invoices.',
    body: `
### Contract types
| Type | What the customer pays | Time on the contract |
|---|---|---|
| **Time & materials** | Every billable hour at the contract/work-type rate | Billed |
| **Block hours** | A prepaid block of hours (each block can be invoiced) | Deducted from the block; hours beyond the remaining balance are billed at the **overage rate** |
| **Retainer** | A recurring fee | Covered; overage billed at the overage rate where set |
| **Recurring service** | A fixed fee per month/quarter/year | Covered |
| **Fixed price** | One fixed amount, invoiced once | Covered |
| **Per ticket** | A fixed price per resolved ticket | Covered |

### Rates
Hourly rate = the contract's rate for the work type → the contract's hourly rate → the work type's default rate.
**Exclusions**: on a contract you can list work types that stay billable even when the contract would cover them (e.g. on-site travel or project work).

### Hour blocks
The contract page shows each block's purchased, used and remaining hours and its expiry date, with a warning when the balance is low. Mark a block as paid from the contract page.

### Invoicing
1. [Billing review](/billing) lists billable time and expenses waiting to be invoiced, and the **billing preview** shows what the next invoice for a company and period will contain (recurring fees, services, fixed prices, blocks, overage, time, expenses) without creating anything.
2. **Create draft invoice** for a company and period. Recurring fees follow each contract's frequency (monthly, quarterly, yearly) and its start/end dates.
3. Review lines, then **Issue** (time is marked billed), **Mark paid** or **Void** (everything is released again).

The default tax rate and payment terms are in [Settings → Regional & display](/settings?tab=org).
`,
  },
  {
    slug: 'settings',
    title: 'Customizing Taskora',
    group: 'Administration',
    summary: 'Currency, language, statuses, CI types, custom fields and custom ticket tabs.',
    body: `
Everything is listed on the [Settings](/settings) page (⚙ at the top right) — use its search box.

- **Currency, language, date format, tax**: [Regional & display](/settings?tab=org). Each user can choose their own language in [My preferences](/settings?tab=me).
- **Statuses, priorities, queues, ticket types, issue types, sources, templates**: [Ticket settings](/admin/ticket-settings).
- **CI (asset) types**: [CI types](/admin/system?tab=ci-types).
- **SLA targets and business hours**: [SLA policies](/admin/system?tab=sla), [Business hours](/admin/system?tab=hours).
- **Work types and rates, billing codes**: [Work types](/admin/system?tab=work-types), [Billing codes](/admin/system?tab=billing-codes).

### Custom fields & ticket tabs
In [Custom fields](/admin/custom-fields) add a field (text, number, date, picklist, checkbox…) to tickets, companies, contacts, CIs, contracts or projects.
- Leave **Show in tab** empty and the field appears in the *Custom fields* card.
- Fill in **Show in tab** (e.g. *Onboarding*) and all fields with that tab name get their **own tab on the ticket** — handy for checklists of information per ticket type.
- Fields can be required, have help text and be deactivated later without losing data.
`,
  },
  {
    slug: 'email',
    title: 'E-mail to ticket',
    group: 'Administration',
    summary: 'Let customers e-mail support@ and get tickets; replies thread into the same ticket.',
    body: `
1. Open [Settings → E-mail to ticket](/settings?tab=email).
2. Enter the IMAP details of your support mailbox (for Microsoft 365: \`outlook.office365.com\`, port 993, SSL/TLS, and an app password), tick **Turn incoming e-mail into tickets** and **Save**. Use **Test connection** to check.
3. Choose a **company for unknown senders** (otherwise e-mail from unknown addresses is rejected) and a **queue**.

How messages are handled:
- The sender is matched to a **contact**, or to a company by **e-mail domain**.
- A subject containing a ticket number such as **[TKA-000142]** adds the e-mail to that ticket as a customer-visible note (and reopens it if it was waiting or resolved).
- Attachments are saved on the ticket. Every message is listed in the log at the bottom of the page.

**Microsoft 365 / Gmail without IMAP passwords?** Use n8n (or Power Automate) to read the mailbox with OAuth and post each message to Taskora — see *API, webhooks & n8n*.

Outgoing e-mail (notifications, replies from tickets) is configured in [E-mail (SMTP)](/admin/email).
`,
  },
  {
    slug: 'api',
    title: 'API, webhooks & n8n',
    group: 'Automation',
    summary: 'Connect n8n, Power Automate or scripts: API keys, webhooks and inbound e-mail.',
    body: `
### API keys
Create one in [Settings → API & webhooks](/settings?tab=api). Send it as a header:

\`\`\`
Authorization: Bearer tka_…
\`\`\`

The key acts **as you, with your permissions** — create a dedicated user with a limited role for integrations if you prefer. Revoke a key at any time. Everything the web app does goes through the same REST API (\`/api/v1/…\`), so everything can be automated: tickets, notes, time entries, companies, contacts, CIs, contracts, invoices…

### Webhooks (Taskora → n8n)
Add a webhook with your n8n **Webhook** trigger URL and choose events (\`ticket.created\`, \`ticket.updated\`, \`ticket.note_added\`, \`ticket.sla_breached\`, \`time_entry.created\`, \`company.created\`, \`contact.created\`). Taskora POSTs JSON:

\`\`\`json
{ "id": "…", "event": "ticket.created", "occurredAt": "…", "data": { "ticket": { "ticketNumber": "TKA-000142", "title": "…", "companyName": "…", "statusName": "New", "priorityName": "High", "assigneeEmail": "…" } } }
\`\`\`

Each request carries \`X-Taskora-Signature: sha256=…\` (HMAC-SHA256 of the raw body with the webhook's secret). Failed deliveries are retried with back-off; **Send test** checks the connection.

### Inbound e-mail (n8n → Taskora)
\`POST /api/v1/inbound/email\` with \`{ "from", "fromName", "subject", "text", "messageId" }\` creates a ticket or threads a reply, exactly like the mailbox poller.

### Example n8n flows
- **New high-priority ticket → Teams/Slack message**: Webhook trigger (ticket.created) → IF \`data.ticket.priorityName\` = High → Teams node.
- **Close stale tickets**: Schedule → HTTP Request \`GET /api/v1/tickets?…\` → loop → \`PATCH /api/v1/tickets/{id}\` with \`{ "statusId": … }\`.
- **Monitoring alert → ticket**: your RMM's webhook → HTTP Request \`POST /api/v1/tickets\`.

The full endpoint list is in \`docs/api.md\` and a step-by-step guide in \`docs/n8n.md\` in the Taskora repository.
`,
  },
  {
    slug: 'client-portal',
    title: 'Client portal',
    group: 'Customers & assets',
    summary: 'Let your clients open requests, follow their tickets, see the work done and keep their documentation.',
    body: `
The **client portal** is a separate, simpler website for the contacts of your client companies, at \`/portal\` on your Taskora address. The sign-in page has a **Sign in as a client** button; IT staff keep signing in as before.

### Give a client access
1. Open the **contact** (it must belong to one of your companies and have an e-mail address).
2. In the **Client portal** card choose the **access level**, then:
   - **Invite by e-mail**: the contact receives a link (valid 7 days) to choose their own password. Needs [outgoing e-mail](/admin/email).
   - **Grant access with a password**: Taskora shows a password once; share it securely.
3. Or use [Administration → Client portal](/admin/portal) → **Give a contact access**, where you also see everybody who has access.

### Access levels
- **User**: sees the requests they opened and the devices assigned to them.
- **Company manager**: sees every ticket of the company, the work done, the devices and the contracts (remaining hours). The company's **primary contact** is always a manager.

### What clients can do
- Open a **new request** (subject, description, urgency, device, screenshots and files), **reply** and add files. A reply on a *waiting* or *resolved* ticket reopens it.
- See the **status**, who handles it, the **solution** and the **work done** (date, technician, duration and the time entry description — never internal notes or rates).
- **Work & hours**: hours per month and, for managers, contract balances.
- **Documentation**: read the pages you share and write their own (office, suppliers, procedures…).
- They **cannot** change the status, the solution, the time or anything else on a ticket.

### What the IT team does
- Customer-visible notes (*Public* visibility) appear in the portal conversation; internal notes never do.
- Files on a ticket are hidden from the client until you click the **eye** button next to the file. Files the client uploaded are marked *From client*.
- Company documentation pages with visibility **Public (client portal)** and status *Published* are shown to that company. Pages clients write appear in the company's **Documentation** tab, marked *Written by the client*.
- Choose what the portal shows (work, devices, contracts, documentation, priority, attachments) and a welcome message in [Administration → Client portal](/admin/portal).
`,
  },
  {
    slug: 'deleting',
    title: 'Deleting records',
    group: 'Administration',
    summary: 'Why some deletes are refused, and how a super administrator can force them.',
    body: `
Taskora protects history: you cannot normally delete a company that still has tickets, a contract with logged time, or a status that tickets use. Usually it is better to make the record **inactive**.

**Super administrators** (the *Administrator* role, which has every permission) can delete anyway:
1. Click **Delete** as usual. When Taskora answers that the record is still in use, a **Force delete** window opens.
2. It lists exactly what else will be deleted (e.g. 12 tickets, 40 notes, 3 contacts) and which links will simply be cleared.
3. For picklist values (statuses, priorities, queues, types…) you can instead **move everything to another value**, so no ticket is lost.
4. Type **DELETE** to confirm. Everything happens in one step — either all of it is deleted or nothing is — and it is recorded in the audit log.

Force delete cannot be undone. Make a backup first in [Backup & Restore](/admin/backups) if in doubt. Users and roles are never deleted this way; deactivate users instead.
`,
  },
  {
    slug: 'backups',
    title: 'Backups and updates',
    group: 'Administration',
    summary: 'Back up your data and update the server safely.',
    body: `
- [Backup & Restore](/admin/backups) makes a full backup (all data and uploaded files) on the server or as a download, and runs automatic backups on a schedule.
- Keep a copy of your server's \`.env\` file with the backups — it contains the encryption key for stored passwords.

### Moving Taskora to another server (e.g. a VPS)
1. On the old server open [Backup & Restore](/admin/backups) → **Move Taskora to another server**, choose a passphrase and **Download migration package**.
2. Install Taskora on the new server (see \`docs/deployment.md\`), create a temporary administrator with the setup token and sign in.
3. Open Backup & Restore → **Import migration package…**, pick the file, enter the passphrase and type RESTORE.
4. Everybody signs in again with their accounts from the old server. Tickets, settings, users, API keys, webhooks, e-mail and integration passwords and attachments all come along.

Set the new server's address (\`PUBLIC_URL\`), HTTPS and ports in its \`.env\` — those are not part of the package. If n8n or other tools call Taskora, point them at the new address.

### Updating the server
On the server, in the Taskora folder:

\`\`\`
bash scripts/update.sh
\`\`\`

It backs up the database first, pulls the new version, rebuilds the containers and applies database changes automatically. Your data, uploads and settings are kept.
`,
  },
  {
    slug: 'shortcuts',
    title: 'Keyboard shortcuts',
    group: 'Start here',
    summary: 'Move faster with the keyboard.',
    body: `
| Keys | Action |
|---|---|
| **Ctrl K** / **⌘ K** | Search and jump anywhere |
| **?** | Show all shortcuts |
| **Ctrl/⌘ V** in a note | Paste a screenshot |

Use the account menu (top right) → *Keyboard shortcuts* for the full list.
`,
  },
];
