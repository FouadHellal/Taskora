# Changelog

## [0.10.1] — 2026-11-24

### Fixed
- Omada: works with the **Omada cloud Open API** (`https://<region>-omada-northbound.tplinkcloud.com`): no call to `/api/info` there, the Omada ID is required, and region shortcuts (Europe, United States, Asia Pacific) fill the address. Setup errors are explained in plain words (unknown Omada ID, refused credentials, web-interface address used instead of the Open API address, missing site access).

## [0.10.0] — 2026-11-23

### Added
- **TP-Link Omada integration** (*Administration → Integrations → TP-Link Omada*, also *Assets → Omada Wi-Fi*), read-only, through the controller's Open API (client-credentials app):
  - controller address, Client ID / secret (encrypted), optional Omada ID (read from `/api/info` otherwise), TLS verification switch for self-signed controllers, sync interval, which devices become CIs (access points by default, optionally switches and gateways), *Test connection*;
  - **sites mapped explicitly to companies**; devices of mapped sites are linked to configuration items — matched by MAC address, then serial number, then name within the company, otherwise created (type *Wireless Access Point*, *Network Switch* or *Router*, manufacturer TP-Link) — and the CI's IP, firmware, serial and last-seen stay current;
  - per device: status, uptime, CPU / memory, firmware, uplink and link speed, clients per band;
  - **connected clients** per access point (name, host name, IP, vendor, OS, SSID, channel, signal, traffic, connection time) shown on the CI page; clients not seen for 30 days are forgotten, devices that disappear are flagged, never deleted;
  - scheduled synchronisation by the worker, manual *Synchronise now*, token renewal, rate-limit back-off and the v1 client list for controllers without v2.

### Upgrade notes
- `bash scripts/update.sh`. Migration `0015_omada_integration` only adds three tables (`omada_sites`, `omada_devices`, `omada_clients`); no existing data is changed.

## [0.9.0] — 2026-11-23

### Added
- **Company e-mail domains** (company form, *E-mail domains*, e.g. `lesaures.com`): incoming e-mail is matched to a company by the sender — an existing contact first (also personal addresses such as gmail.com), then the company owning the sender's domain. A domain belongs to one company only; public mail domains (gmail.com, outlook.com…) cannot be used.
- **New contacts from known domains**: a sender from a company's domain who is not a contact yet becomes one (name taken from the e-mail), so the ticket has a requester. Can be turned off in *Settings → E-mail to ticket*.
- Only clients open tickets: with no *Company for unknown senders*, e-mail from anybody else is refused and listed in the inbound log with the reason.
- **Replies attributed to their author**: an e-mail reply (`[TKA-…]` in the subject) is recorded under the contact who wrote it — a colleague from the same company becomes a contact — or under the technician when it comes from a staff mailbox (technician replies do not reopen the ticket). Portal replies are recorded under the contact too. The ticket timeline shows the client's name with a *Client · e-mail / portal* badge.
- **Automatic ticket analysis**: every new ticket (e-mail, portal or IT team) gets an internal note from *Taskora assistant* in the organization language: what it is about (computer, printer, account / Active Directory, e-mail, Microsoft 365, network, server, backup, security, software, access rights, phone, cameras, new employee, purchase) with the words found, the requester and their other open requests, repeat requests on the same topic, the device named in the message (linked to the ticket) or the requester's own device of that kind with its Action1 status, signs of urgency or wide impact, similar resolved tickets of the company with their solution, and first checks. Runs on the server; no text leaves it. Can be turned off in *Settings → E-mail to ticket*.

### Upgrade notes
- `bash scripts/update.sh`. Migration `0014_inbound_matching` only adds `companies.email_domains` and `ticket_notes.contact_id`; no existing data is changed.
- Add the e-mail domain of each client company (Companies → edit → *E-mail domains*), and empty *Company for unknown senders* if only clients should open tickets.

## [0.8.0] — 2026-11-23

### Added
- **Redesigned e-mails**: every e-mail (client confirmations, replies, resolved notices, monthly reports, IT alerts, staff notifications, ticket e-mails, portal invitations and password resets, test e-mail) uses one branded layout: header with your **e-mail logo** and **header colour**, accent colour, ticket card with reference and status, quote, button, signature and footer line. Set them in *Administration → E-mail → Look of the e-mails and signature*, with a live preview.
- **HTML signatures**: the signature accepts HTML (tables, inline styles, images; scripts and event handlers are removed) and the variables `{{sender}}` (the technician, or "the … team" for automatic e-mails), `{{organization}}`, `{{logo}}` (public address of the e-mail logo) and `{{portal}}`. It is added to every client-facing e-mail and shown in the *Send e-mail* dialog. *Start from a template* gives a ready-made layout.
- **E-mail logo** (separate from the organization logo, e.g. a version for a dark header), served publicly at `/api/v1/logos/email` for signatures.
- **One mailbox for everything**: *Settings → E-mail to ticket → Use the same mailbox as outgoing e-mail* reads replies from the account that sends (same user and app password; Gmail's IMAP server is filled in automatically), so client answers land in their tickets.
- **Client mailboxes**: in the portal (*My account → E-mails I receive*) a client can add a **second address** and choose where ticket e-mails go: their own address, the second address only, or both.

### Changed
- E-mail subjects no longer start with the organization name (`[Org] …`).
- Ticket e-mails sent with *Send e-mail* are HTML with the signature added automatically; the draft no longer ends with the technician's name when a signature is set.
- Signatures can be up to 20,000 characters.

### Upgrade notes
- `bash scripts/update.sh`. Migration `0013_client_mailbox` only adds two columns to `contacts` (`notify_email`, `notify_mode`); no existing data is changed.
- Set `PUBLIC_URL` to the address clients use (e.g. `https://taskora.example.com`): signature images and buttons point there.

## [0.7.0] — 2026-11-23

### Added
- **Proactive e-mails** (professional HTML, in the organization language, with your logo):
  - the **IT team** is alerted about every new ticket — opened by a client, by e-mail or by a technician — and when a client replies in the portal (addresses in *Administration → Client portal*);
  - **clients** receive a confirmation with the reference when a request is opened (also when the IT team opens it for them), the technician's reply, a notice with the solution when the request is **resolved**, and the monthly report;
  - each client chooses what they receive in the portal (*My account → E-mails I receive*); managers can ask for a copy of every new request of their company. Recurring maintenance tickets are not announced to clients. Every e-mail is logged on the ticket and never sent twice.
- **Monthly client reports** (*Insights → Client reports*, and a **Reports** tab on each company): requests opened/resolved, resolution time, response times met, time spent with a 6-month trend, equipment and warranties ending soon, **Action1** patch status and devices needing attention, and an **IT health score** (0–100). Prepare manually or automatically on a chosen day of the month (drafts for review, or published and e-mailed), add a message, hide sections, publish. Managers read them in the portal (*Monthly reports*) and can print them as PDF.
- **Contract & billing in the client portal** (managers): agreement term and renewal, billing frequency (monthly, quarterly, yearly) and next invoice, every service with its price per unit and quantity, totals per month, per billing period and per year, prepaid hours, rates for work outside the agreement, and invoices with PDF download. Clients cannot change anything.
- **Per-device / per-user pricing**: a service can be priced *per device* (of a CI type, e.g. Laptop, Desktop, Server) or *per user*; contract lines with **Count automatically** follow the client's active devices or contacts (refreshed daily and whenever the contract is opened).
- Contracts: **Renews automatically** and **Show in the client portal** options.
- Client portal: the client's **company logo and name** at the top of the menu; a new **home page** with the IT health gauge, requests waiting for an answer, average resolution time, work trend, device protection, agreement and latest report.
- Administration → E-mail: **Use Gmail settings** button and app-password instructions.

### Fixed
- Saving one settings page (e.g. *Administration → Client portal*) no longer resets the other system settings (organization name, currency, time zone…) to their defaults.

### Upgrade notes
- `bash scripts/update.sh`. Migration `0012_client_engagement` only adds a table (`client_reports`) and columns (`contacts.email_preferences`, `services.quantity_source`, `services.ci_type_id`, `contract_services.auto_quantity`, `contracts.auto_renew`, `contracts.portal_visible`); no existing data is changed. Existing service lines keep their fixed quantity until you tick *Count automatically*.
- **Check your system settings after the update** (*Administration → System*, *Regional & display*): if you saved the Client portal page in 0.6.0, the organization name, currency or time zone may have been reset to their defaults by the bug fixed above.
- Set the IT team addresses and turn automatic reports on or off in *Administration → Client portal*.

## [0.6.0] — 2026-11-23

### Added
- **Client portal** (`/portal`, *Sign in as a client* on the sign-in page): contacts of your client companies sign in with their own account to
  - open requests (subject, description, urgency, device, screenshots and files — pasted screenshots become attachments), reply and add files;
  - follow their tickets: status, progress, who handles it, the solution, the conversation and the **work done** (date, technician, duration, description — never internal notes or rates);
  - see **Work & hours** (hours per month, details per month) and, for managers, **contracts and remaining block hours**;
  - see their **devices** and report a problem on one;
  - read the company **documentation** the IT team shares and **write their own pages** (templates included); pages written by the IT team stay read-only;
  - read help articles, change their password, language and theme.
  Clients cannot change a ticket's status, solution or time.
- Access levels per contact: **User** (own tickets) or **Company manager** (every ticket, work, devices and contracts of the company; the primary contact is always a manager).
- **Invitations by e-mail**: the contact chooses their own password (link valid 7 days), or share a generated password.
- **Administration → Client portal** (`/admin/portal`): turn the portal and each part on or off, welcome message, list of everybody with access and their access level, *Give a contact access*.
- Ticket files: an **eye button** shares a file with the client portal; files uploaded by clients are marked *From client*.
- Companies: **Documentation** tab listing IT and client-written pages and whether the client sees them.

### Changed
- The staff sign-in page says *Sign in to Taskora* (instead of the organization name).
- Knowledge-base visibility is labelled *Internal (IT team only)* / *Public (client portal)*.
- Markdown tables in documentation and articles have borders.

### Upgrade notes
- `bash scripts/update.sh`. Migration `0011_client_portal` only adds columns (`contacts.portal_role`, `attachments.portal_visible`, `attachments.uploaded_by_contact_id`, `kb_articles.portal_author_contact_id`, `kb_articles.portal_updated_by_contact_id`); no existing data is changed. Contacts who already had portal access keep it; existing ticket files stay hidden from clients until shared.

## [0.5.0] — 2026-11-22

### Added
- **Move Taskora to another server** (Administration → Backup & Restore): a *migration package* holds all data, settings, users, API keys, webhooks, integrations and uploaded files, with stored passwords (SMTP, IMAP, Action1, webhook secrets) re-encrypted with a passphrase, so they keep working on a server with a different `TASKORA_ENCRYPTION_KEY`. Download it or save it on the server; import it on the new server with the passphrase (all-or-nothing, with a safety backup first). Also from a shell: `node dist/cli/migration.js export|import`. See [docs/deployment.md](docs/deployment.md#moving-to-another-server-vm--vps).
- nginx accepts larger uploads (default 1024 MB, `NGINX_RESTORE_MAX_BODY_SIZE`) for restoring backups and importing migration packages only, streamed to the API.

### Changed
- Restoring a migration package as a normal backup is refused with a pointer to *Import migration package*.

## [0.4.0] — 2026-11-20

### Added
- **Settings hub** (⚙ in the top bar, `/settings`): a searchable index of every setting, *My preferences* (language, ticket window, theme, time zone), *Regional & display* (currency picker, default language, date format, default tax rate, time rounding), *E-mail to ticket* and *API & webhooks*.
- **Languages**: French, Dutch, German and Spanish besides English — per user or as the organization default; dates follow the language and the chosen date format.
- **Tickets open in their own window** (like Autotask; per-user and organization setting). Links inside the ticket window open in the main window.
- **Clearer ticket page**: summary strip (status, priority, SLA, worked vs estimate, counts), prominent *New note* / *New time entry* actions and tabs for Notes, Time entries (with totals and edit/delete), Activity, Attachments, Related tickets, Knowledge and **custom tabs** made from custom fields (*Show in tab*).
- **Paste or drop images** into notes, the description, the resolution, time entries and e-mails; e-mails get the images as attachments and the portal shows them.
- **Force delete for super administrators**: a refused delete shows exactly what else would be removed and lets an Administrator delete it anyway (or move picklist references to another value), in one transaction, recorded in the audit log.
- **API keys** (`Authorization: Bearer tka_…`), **outgoing webhooks** (signed, retried) and `POST /api/v1/inbound/email` for n8n / Power Automate — see [docs/n8n.md](docs/n8n.md).
- The inbound mailbox (IMAP) can be configured in the UI (password encrypted); `IMAP_*` variables remain a fallback.
- **Help & Guides** (`/help`): in-app how-to articles.
- Contracts: block balance per block with low-balance warning, billing preview, contract exclusions (work types that stay billable), per-ticket rate, editable hour blocks, service end dates.

### Fixed
- Contract billing: block-hour overage is now billed at the overage rate; fixed-price amounts, unpaid hour blocks and per-ticket charges are invoiced; recurring fees and services follow their frequency and the contract dates (prorated partial periods); services on every contract type are billed; time on an invoice can no longer be changed; time can no longer be covered by another company's contract; consistent "hours used"; amounts no longer rounded before multiplying; billing periods use the organization time zone; no empty draft invoices.

### Changed
- Taskora is released under the MIT license (`LICENSE`).
- Deletes refused because a record is in use answer HTTP 409 `in_use` (was 400 for a few guards).

### Upgrade notes
- `bash scripts/update.sh` (backs up first). Migrations 0009 and 0010 only add tables and columns; existing data is not changed. Contracts, blocks and fixed prices that started before the upgrade are not billed again.

## [0.3.3] — 2026-11-09

### Fixed
- atlas incidents that Taskora accepted without a ticket never got one: an incident sent while
  *Create tickets automatically* was off, or whose ticket was deleted, now gets its ticket the
  next time atlas sends it (atlas 0.12.1 re-sends such incidents every 30 minutes; *Re-send all*
  works too). A ticket is still never created for an incident that has already recovered.
- A required ticket custom field no longer makes Taskora refuse every atlas incident: tickets
  atlas opens skip the required check (types are still validated; people fill the field in).
- Refused atlas incidents (validation errors, ticket creation errors) are shown as the last
  error on Integrations → atlas, with the incident key and the fields concerned.

## [0.3.2] — 2026-11-05

### Changed
- Integrations → atlas refreshes its counts and incident list every 30 seconds (edits in the
  settings form are kept).

## [0.3.1] — 2026-11-05

### Fixed
- Integrations → atlas: atlas's *Test connection* now counts as a contact (*Last contact*), and
  refused incidents (integration disabled, no company chosen) show as the last error, even if
  the atlas settings were never saved.

## [0.3.0] — 2026-11-03

### Added
- **atlas integration** (Integrations → atlas, [docs/integrations/atlas.md](docs/integrations/atlas.md)):
  atlas homelab incidents become one ticket each (idempotent, revision-ordered), with internal
  notes on meaningful changes, recovery/reopen policies, priority per severity that respects
  technician changes, and a "still failing" flag when a ticket is closed while atlas still sees
  the problem. Technician activity flows back to atlas through a feed without echo.
- **CMDB reconciliation with atlas**: preview/apply inventory syncs, MAC/serial matching within
  the configured company, proposals for name-only matches, conflicts for ambiguity, optional
  creation of unmanaged infrastructure, missing flags (no deletion), observed relations with
  provenance, admin actions (link, create, unlink, ignore, decommissioned).
- atlas panels on tickets (incident state, checks, evidence) and configuration items
  (observations, Proxmox placement, network, relations, incidents, freshness).
- **Integration tokens**: scoped, hashed, revocable, optionally expiring credentials for
  machine clients (`Authorization: Bearer tki_…`), managed by `integrations.manage`.
- Action1 sync matches existing CIs by MAC address (after serial, before host name) and takes
  over CIs atlas created, so installing the agent later never duplicates a device.
- The incident route accepts `POST` as well as `PUT` (same idempotent upsert).
- `ci_relations` record their source (`manual`, `atlas`), detail and observation time.

### Upgrade notes
- Migration `0008_atlas_integration` adds `integration_tokens`, `atlas_incident_links`,
  `atlas_entities` and three columns on `ci_relations` (existing relations become `manual`).
  Rebuild and restart api and worker (`docker compose up -d --build`).

## Earlier unreleased changes

### Added
- Ticket CSV import (Tickets → Import, or Admin → Data Import) with notes, hours worked, created/resolved dates, status/priority mapping, optional creation of missing companies/contacts/picklist values, and safe re-import; ticket CSV export with a column chooser (adds description, notes, resolution and more). See [docs/ticket-import.md](docs/ticket-import.md).
- Phone layout: below 768 px the sidebar becomes a slide-in menu (☰) and the header turns compact; below 640 px every list shows one card per row with a sort selector, and list filters fold behind a "Filters" button. Wide tables scroll inside their card instead of the page, dialogs use the dynamic viewport height, and form fields use 16 px text on touch screens so iOS Safari no longer zooms in. The customer portal header and ticket list wrap on phones.
- "Add to Home Screen": web app manifest and app icons, so Taskora opens full-screen like an app on iPhone and Android.

### Fixed
- Re-importing a ticket CSV no longer duplicates rows that have no ticket number: they match an existing ticket with the same company, title and "Created" date.
- Docker: the worker has a heartbeat healthcheck, so `docker compose up --wait` works.

## [0.2.0] — 2026-10-20

### Added
- Backup & Restore (Administration → System): full backups of every table and uploaded file, saved on the server or downloaded; scheduled automatic backups with retention; all-or-nothing restore from a server backup or an uploaded file with an automatic pre-restore backup. New permission `backups.manage`.
- E-mail settings page: SMTP host/port/TLS/credentials/sender/reply-to/signature configurable in the UI (password encrypted), test e-mail; environment variables remain a fallback.
- Send e-mail from a ticket: To/Cc/Bcc, pre-filled contact and `[TKA-…]` subject, ticket attachments, signature, optional status change; recorded as a customer-visible note and timeline event.
- Logos for client companies (companies list, company workspace, ticket contact card) and for the organization (sidebar, sign-in page).
- Grouped navigation: collapsible sections and sub-menus; the compact sidebar shows one flyout menu per section.

### Fixed
- Action1 organization mapping tab was always empty: the UI read the organization list as `{ data: [...] }` although the API returns a plain array.

### Upgrade notes
- Rebuild and restart all services (`docker compose up -d --build`): the database migration adds the `logos` table, and a new `taskora-backups` volume is mounted on api and worker.

## [Unreleased] — branch `develop/taskora-platform`

### Added
- Monorepo foundation, PostgreSQL schema (40+ tables) and migrations.
- Authentication (setup token, Argon2id, sessions, CSRF, lockout), RBAC with four built-in roles, audit log.
- CRM: companies with workspace and KPIs, contacts, locations, activities, opportunities.
- Service desk: tickets with full lifecycle, SLA engine, notes, timeline, watchers, relations, duplicates, saved views, bulk updates, templates, CSV export, service calls, calendar.
- CMDB: configuration items, relations, software, device workspace.
- Action1 read-only integration with sync, mapping, matching, review and device panels.
- Contracts, time tracking with timer and approval, expenses, billing review, invoices with PDF.
- Projects, milestones, tasks; knowledge base and documentation API.
- Workflow automation engine, notifications, global search, custom fields, reports and dashboards.
- Background worker with Postgres job queue.
- Docker images, docker-compose, nginx, Ubuntu install/backup/restore/update scripts, CI workflow.
- Fictional demo data seed (development only).
- E-mail: SMTP notifications, customer replies from notes, IMAP inbound e-mail to ticket.
- Recurring tickets, ticket checklists, dispatch board.
- Session management, CSV import, generated API reference.
- Ticket merge, portal password reset, system health view.
- Customer portal MVP; contract renewal and warranty reminders; ticket list column chooser.
- Playwright end-to-end tests.
