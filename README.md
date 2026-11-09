# Taskora

**Taskora** is an open, self-hosted **Professional Services Automation (PSA)** platform for MSPs, independent IT professionals and internal IT teams. It covers the day-to-day work of an IT service provider — service desk, CRM, CMDB, contracts & SLAs, time tracking, billing, projects and knowledge — with a modern, information-dense interface and a read-only **Action1** integration that discovers devices automatically.

> Functional reference: Datto Autotask PSA. Taskora is an independent implementation with its own code, design and branding.

## Highlights

- **Service desk** – tickets with configurable statuses, priorities, queues, types, issue/sub-issue classification and sources; internal & customer-visible notes; activity timeline; watchers; related tickets; duplicate detection; saved views; bulk updates; ticket templates; CSV export with a column chooser and CSV import with notes ([docs/ticket-import.md](docs/ticket-import.md)).
- **SLA engine** – server-side business-hours calendars (time zones, holidays), first-response and resolution targets per priority, automatic pause on waiting statuses, breach and at-risk monitoring with notifications.
- **CRM** – companies (workspace with live KPIs), contacts, locations, activities, opportunities.
- **CMDB** – configuration items with hardware/OS/network/warranty data, relationships, software, assigned contacts, ticket history.
- **atlas integration** – homelab incidents become tickets (idempotent, recovery-aware, technician activity fed back), CMDB reconciliation with field ownership and conflict review, scoped integration tokens. See [docs/integrations/atlas.md](docs/integrations/atlas.md).
- **Action1 integration (read-only)** – OAuth client, pagination, retries, explicit organization→company mapping, serial/hostname matching within a company only, conflict review, CI auto-creation, rename tracking, live device panel on CIs and tickets (agent status, last seen, reboot required, missing updates).
- **Business** – contracts (T&M, fixed price, block hours, retainer, recurring, per ticket) with rates, blocks and services; time entries with timer and approvals; expenses; billing review; invoice drafts with PDF export.
- **Projects** – projects, milestones, tasks, progress from logged time.
- **Knowledge** – knowledge base and company documentation (Markdown), linked to tickets.
- **Automation** – workflow rules (on create/update/status age/SLA breach) with conditions, actions, execution history and loop prevention.
- **Customer portal** – contacts sign in at `/portal` (separate authentication realm) to follow their tickets, raise requests, reply and read public KB articles; primary contacts see all company tickets. Internal notes and staff data are never exposed.
- **E-mail** – SMTP configurable in the UI (or via environment), notifications, **send e-mail from a ticket** (To/Cc/Bcc, ticket attachments, signature, kept as a customer-visible note) and IMAP inbound e-mail → ticket with reply threading on `[TKA-…]` subjects.
- **Backup & restore** – full backups of all data (tickets, CRM, CMDB, Action1 sync data, settings, users, files) saved on the server on a schedule or downloaded on demand; all-or-nothing restore from the UI.
- **Branding** – logos for client companies (lists, company workspace, tickets) and for your own organization (sidebar, sign-in page).
- **Platform** – role-based access control enforced in the API, audit log, custom fields, notifications, global search (Ctrl+K), keyboard shortcuts, light/dark themes, a compact grouped navigation (collapsible sections and sub-menus, flyout menus in the narrow sidebar), background worker with a Postgres job queue.

## Quick start (Docker, Ubuntu Server)

```bash
git clone https://github.com/FouadHELLAL7/Taskora.git taskora
cd taskora
cp .env.example .env        # set POSTGRES_PASSWORD and TASKORA_ENCRYPTION_KEY (openssl rand -hex 32)
docker compose up -d --build
docker compose logs api | grep "setup token"
```

Open `http://<server>:8080`, enter the setup token and create the first administrator. A guided installer is available: `bash scripts/install.sh`. See **[docs/deployment.md](docs/deployment.md)** for reverse proxy/HTTPS, backups, updates and troubleshooting.

## Local development (no Docker required)

Requirements: Node.js ≥ 22 (`nvm use` reads `.nvmrc`).

```bash
git clone https://github.com/FouadHELLAL7/Taskora.git taskora
cd taskora
```

```bash
npm install
npm run dev            # embedded PostgreSQL + API + worker + web with auto-reload
npm run db:seed:demo   # optional: fictional demo data (development only)
```

The web app runs on <http://localhost:5173> (API on :3000, PostgreSQL on :54329, data in `.data/`). On first start, the API logs a one-time setup token.

| Command | Purpose |
| --- | --- |
| `npm run typecheck` | Type-check all workspaces |
| `npm test` | API integration tests (in-process PostgreSQL via PGlite) |
| `npm run build` | Build API bundle and web app |
| `npm run test:e2e` | Playwright browser tests against a running instance (`E2E_BASE_URL`, `E2E_EMAIL`, `E2E_PASSWORD`; first run `npx playwright install chromium`) |
| `npm run db:generate` | Generate a migration after schema changes |

## Repository layout

```
apps/api        Fastify API, background worker, Drizzle schema & migrations, tests
apps/web        React + Vite single-page app
packages/shared Shared Zod schemas, enums, permissions and formatting helpers
deploy/         nginx configuration and container entrypoint
scripts/        dev launcher, install/backup/restore/update helpers
docs/           research, deployment guide
```

## Documentation

- [docs/api.md](docs/api.md) – REST API reference (generated: `npm run docs:api -w @taskora/api`)
- [TASKORA_ARCHITECTURE.md](TASKORA_ARCHITECTURE.md) – architecture and data model overview
- [TASKORA_DECISIONS.md](TASKORA_DECISIONS.md) – architecture decision log
- [TASKORA_ROADMAP.md](TASKORA_ROADMAP.md) – phases and scope
- [TASKORA_PROGRESS.md](TASKORA_PROGRESS.md) – what is implemented and verified
- [TASKORA_NEXT_STEPS.md](TASKORA_NEXT_STEPS.md) – prioritised next tasks
- [CHANGELOG.md](CHANGELOG.md)
- [docs/research](docs/research) – Autotask functional analysis, feature matrix, data model, workflows, Action1 API

## Security

Secrets come from the environment and are never committed. Integration credentials are encrypted at rest (AES-256-GCM). Passwords are hashed with Argon2id; sessions use httpOnly cookies with CSRF tokens; login is rate limited with account lockout. Taskora is private to your network by default — do not expose it to the internet without a TLS reverse proxy.

## License

[MIT](LICENSE)
