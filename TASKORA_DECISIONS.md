# Architecture decision log

| # | Date | Decision | Rationale |
| --- | --- | --- | --- |
| 1 | 2026-10-20 | npm workspaces monorepo (api, web, shared) | One repo, shared Zod schemas/enums/permissions between API and UI, simple tooling. |
| 2 | 2026-10-20 | Fastify 5 instead of NestJS | Lower overhead, explicit plugins, first-class `inject` for tests; structure kept modular by convention (`modules/*`). |
| 3 | 2026-10-20 | Drizzle ORM + SQL migrations (drizzle-kit) | Type-safe SQL-first queries for reporting-heavy PSA screens; works with node-postgres in production and PGlite in tests. |
| 4 | 2026-10-20 | PostgreSQL job queue instead of Redis/BullMQ | Fewer moving parts for self-hosting; `FOR UPDATE SKIP LOCKED`, dedupe keys and backoff are sufficient at MSP scale. |
| 5 | 2026-10-20 | Session cookies + CSRF token (no JWT) | Revocable sessions, httpOnly cookies, simple and safe for a same-origin SPA. |
| 6 | 2026-10-20 | Centralised permission check via route `config.perm` | Authorization cannot be forgotten in a handler; secure by default (routes private unless `public`). |
| 7 | 2026-10-20 | First-run setup token instead of default admin credentials | No shipped credentials; token logged once or provided via env. |
| 8 | 2026-10-20 | Integer identity keys + human-readable numbers from a `sequences` table | Readable URLs/IDs like Autotask, prefixes configurable. |
| 9 | 2026-10-20 | Custom fields as validated JSONB | Flexible per-entity fields without schema migrations; validated server-side. |
| 10 | 2026-10-20 | SLA computed server-side in business minutes with pause accounting | Matches Autotask SLA event model (first response / resolution, waiting pauses) and stays correct across time zones/DST. |
| 11 | 2026-10-20 | Action1 integration strictly read-only, explicit org→company mapping | Safety requirement; never auto-link across companies; no deletion when devices disappear. |
| 12 | 2026-10-20 | Only the documented Action1 org dashboard deep link is used | No per-endpoint console link is documented (see docs/research/action1-api.md). |
| 13 | 2026-10-20 | REA toolkit not used | It reverse-engineers live web apps; inappropriate for a vendor product with customer data (see docs/research/rea-evaluation.md). |
| 14 | 2026-10-20 | Autotask research from public documentation only | Data-protection requirement: no access to the authorized tenant's records or UI data was needed. |
| 15 | 2026-10-20 | Native `<select>` + Radix primitives, custom SVG charts | Accessible, fast, no heavy chart dependency; consistent design tokens in light/dark. |
| 16 | 2026-10-20 | Embedded PostgreSQL (`embedded-postgres`) for local dev, PGlite for tests | Development works without Docker; tests run anywhere (incl. CI) without a database service. |
| 17 | 2026-10-20 | nginx web container with build-time CSP hashes, per-request upstream DNS | Strict CSP without breaking the inline theme script; resilient to API container restarts. |
| 18 | 2026-10-20 | Licence not chosen yet | Left to the project owner (see TASKORA_NEXT_STEPS.md). |
| 19 | 2026-10-20 | Logical JSON backups produced by PostgreSQL (`json_agg`) and restored with `json_populate_recordset`, foreign keys dropped/re-created inside one transaction | Exact type round-trip without pg_dump in the app image; works on PostgreSQL and PGlite (tests); restore is all-or-nothing and re-validates every relation; tolerant of backups from older schema versions (missing columns take defaults). |
| 20 | 2026-10-20 | SMTP settings stored in `system_settings` (`smtp` key, AES-GCM password), precedence over SMTP_* env | Admins can configure mail without shell access; existing env-based installs keep working unchanged. |
| 21 | 2026-10-20 | Logos stored as base64 in a `logos` table, raster formats only; the browser rescales to 256 px | Included in backups automatically; no SVG (script risk); small payloads. |
| 22 | 2026-10-20 | Navigation grouped into collapsible sections with sub-menus; compact sidebar uses one flyout per section | ~45 links reduced to 8 section headers; the section of the current page opens automatically. |
| 23 | 2026-11-03 | atlas integration: atlas pushes (incidents `PUT`, inventory `POST`) with scoped integration tokens; Taskora → atlas lifecycle is a pull feed (`ticket-events?after=`) | Taskora stores no atlas credentials and never connects into the homelab (no SSRF surface); atlas stays read-only toward infrastructure and exposes no write endpoint; a cursor feed survives either side being down. |
| 24 | 2026-11-03 | Integration tokens (`tki_…`, SHA-256 hashed, scopes `atlas.incidents` / `atlas.cmdb`, revocable, optional expiry) instead of a service user | Least privilege: a token cannot sign in, use the UI or any other route; checked in the same central auth hook as permissions (`config.scope`), so it cannot be forgotten in a handler. |
| 25 | 2026-11-03 | Incident idempotency = unique `<instance>:<incidentId>` + row lock + monotonic `revision`; atlas-originated ticket events tagged `origin: atlas` and excluded from the feed | Retries, duplicate deliveries, replays and reordering never create a second ticket or undo a newer state; no echo loops. Recovery is atlas's call: a technician resolving a ticket while atlas still sees the failure produces a `persisting` reopen/note, never a "healthy" state. |
| 26 | 2026-11-03 | CMDB field ownership: atlas observations live in `atlas_entities`; atlas writes CI fields only for CIs it created and Action1 does not manage; Action1 adopts an atlas CI by MAC (new matching step) | No duplicate CIs when an agent is installed later; Action1 stays the source of truth for managed devices; manual fields are never overwritten. |
| 27 | 2026-11-03 | atlas matching: strong identifiers (MAC incl. Action1's, serial) link; name-only = proposal; ambiguity = conflict; complete snapshots flag missing, never delete; relations carry provenance (`source`, `source_detail`, `observed_at`) | Reconciliation must be reviewable and reversible; manual relations and CIs are never removed by an integration. |
