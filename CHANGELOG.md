# Changelog

## [Unreleased]

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
