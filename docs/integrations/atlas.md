# atlas integration

[atlas](https://github.com/FouadHellal/Homelab-Docs) is a read-only homelab discovery and
monitoring tool (Proxmox, UniFi, Linux/Docker hosts, NAS, Jellyfin). With this integration:

- each atlas **incident** becomes exactly one Taskora **ticket**, kept up to date while it lasts;
- what technicians do on that ticket (acknowledge, assign, re-prioritise, resolve) flows back to
  atlas, without echoing atlas's own changes;
- atlas's **inventory** reconciles with the CMDB: existing CIs are linked, unmanaged
  infrastructure can be created, ambiguities wait for an administrator.

atlas → Taskora only. Taskora never connects to atlas, stores no atlas credential, and atlas
exposes no write endpoint. Contract version: **v1** (path prefix `/api/v1/integrations/atlas/v1`).

## Source of truth

| Data | Owner | Rule |
| --- | --- | --- |
| Health, incident state, recovery, evidence | atlas | Only atlas declares an incident resolved. Closing a ticket never marks infrastructure healthy. |
| Observations (IPs, MACs, Proxmox placement, VLAN, uplink, apps, freshness) | atlas | Stored on `atlas_entities`, shown on the CI's atlas panel. |
| CI fields of a CI atlas created (`source = atlas`, no Action1 link) | atlas | Name, hostname, IP, MAC, OS refreshed on every sync. |
| CI fields of an Action1-managed CI | Action1 | atlas never writes them. Action1 takes over a CI atlas created when the agent appears (MAC match). |
| CI fields of a manual CI, contacts, contracts, notes, custom fields | Taskora | atlas only attaches observations. |
| Ticket status, priority, assignee, notes | Taskora (technicians) | atlas sets the initial priority and follows severity only until a person changes it. |
| Relations | creator | `ci_relations.source`: `atlas` relations are refreshed and removed by atlas (complete snapshots only); `manual` ones are never touched. |

## Setup

1. **Update Taskora** to 0.3.0 or later (the migration `0008_atlas_integration` runs on start).
2. *Integrations → atlas → Settings*: choose the **company** atlas tickets and CIs belong to,
   optionally the queue, ticket type, assignee and priority per severity. Keep **CMDB** on
   *Link to existing CIs* for the first syncs. Tick *Accept incidents and inventory from atlas*.
3. *Tokens → New token*: name `atlas`, scopes `atlas.incidents` and `atlas.cmdb` (or one token
   per scope). Copy it: it is shown once and stored as a SHA-256 hash.
4. In atlas, *Integrations → Taskora*: Taskora address + token, *Test connection*, *Send a test
   incident* (creates no ticket), then *Preview CMDB sync* (writes nothing) and review.
5. *Apply CMDB sync* from atlas, review **CMDB reconciliation** (conflicts and proposals first),
   then switch CMDB to *Link, and create unmanaged infrastructure* if you want atlas to add the
   devices nothing else manages.

Revoke a token at any time (*Tokens → Revoke*): the next atlas call gets 401 and atlas keeps
its deliveries queued until a new token is configured.

## Authentication

`Authorization: Bearer tki_<43 base64url chars>` on every machine call.

- Tokens carry **scopes**; a missing scope is 403, an unknown, revoked or expired token 401.
- Tokens are not users: no session, no CSRF, no UI or other API access. Session cookies are
  ignored on these routes. `lastUsedAt` and the source IP are recorded (at most once a minute).
- Token management requires `integrations.manage`; every create/revoke is audited.
- Rate limits: 600 requests/minute per client on the incident routes, 60/minute for inventory.
  Bodies: 256 KB per incident, 2 MB per inventory sync.

## Endpoints

### `GET /api/v1/integrations/atlas/v1/health`

Either scope. Returns `{ ok, integration: "atlas", apiVersion: 1, enabled, companyConfigured,
autoCreateTickets, cmdbMode, scopes }`. atlas uses it for *Test connection*.

### `PUT` or `POST /api/v1/integrations/atlas/v1/incidents/:key` (`atlas.incidents`)

Both verbs have identical semantics (atlas uses POST: its HTTP client sends only GET and
registered POST requests). `key` = `<instance>:<incidentId>` (`^[a-z0-9][a-z0-9._-]{0,63}:[0-9]{1,18}$`), equal to the body's
`instance` and `incidentId`. The body is the **full current state** of the incident
(`atlasIncidentEventSchema` in `packages/shared/src/atlas.ts`):

```json
{
  "instance": "atlas-home",
  "incidentId": 42,
  "revision": 7,
  "fingerprint": "media.storage:media",
  "kind": "media.storage",
  "title": "Jellyfin runs, but its media storage is not mounted",
  "summary": "…",
  "severity": "warning",
  "state": "open",
  "persisting": false,
  "firstObservedAt": "2026-11-03T01:00:00Z",
  "lastObservedAt": "2026-11-03T01:05:00Z",
  "resolvedAt": null,
  "acknowledgedBy": null,
  "lastHealthyAt": "2026-11-03T00:50:00Z",
  "entity": { "key": "pve:lxc:homelab/204", "name": "media01", "kind": "pve-lxc", "ips": ["10.0.20.55"], "macs": ["bc:24:11:00:02:04"], "pveNode": "pve2", "vmid": 204 },
  "checks": [{ "name": "Library folders are on mounted network storage", "state": "fail", "detail": "…" }],
  "evidence": ["…"],
  "recentChanges": ["…"],
  "link": "https://atlas.lan/incidents",
  "test": false
}
```

Severity: `info | notice | warning`; state: `open | acknowledged | resolved`. Text fields are
length-capped, lists bounded (20 checks, 20 evidence lines, 15 changes, 16 IPs/MACs), links
must be `http(s)`. atlas sends no secrets and no raw command output (it redacts first).

Response `200` (updated or no-op) or `201` (ticket created):

```json
{ "externalKey": "atlas-home:42", "applied": true, "created": true, "test": false,
  "ticket": { "id": 311, "number": "TKA-000311", "title": "…", "status": "New", "statusCategory": "new",
              "priority": "High", "assignee": null, "path": "/tickets/311", "configurationItemId": 18, "ciNumber": "CI-000018" },
  "note": "…" }
```

Errors: `400` validation (or key mismatch), `401/403` token, `409 integration_disabled`,
`409 not_configured` (no company), `413` too large, `429` rate limit. atlas retries 429/5xx
and network errors with backoff, and treats other 4xx as permanent (shown in atlas).

**Idempotency and ordering.** One row per `externalKey` (unique), locked `FOR UPDATE` while an
event is applied. `revision` is monotonic per incident: anything `<=` the stored revision is a
no-op (`applied: false`), so retries, duplicate deliveries, replays after a restore and
out-of-order arrivals never create a second ticket or undo a newer state. One exception: an
open incident that has **no ticket** (it arrived while *Create tickets automatically* was off,
or its ticket was deleted) gets one from any delivery, even of a revision already applied
(`created: true`, `applied: false`); only the ticket is attached, the stored state is kept. A
response with `ticket: null` for an open incident tells atlas to send it again later.

**What an event does**

| Situation | Effect |
| --- | --- |
| first open event, `autoCreateTickets` | ticket in the configured company/queue/type, source *Monitoring Alert*, tags `atlas` + kind, priority from the severity map, CI from the entity if atlas's entity is linked; workflow rules run as for any new ticket; required ticket custom fields are not enforced (left for a technician) |
| open event, `autoCreateTickets` off | accepted, no ticket, `note` says why; the ticket is created by a later delivery once it is on |
| meaningful change (title, summary, severity, checks, evidence, changes) | one **internal** note; heartbeats (`lastObservedAt` only) add nothing |
| severity change | priority follows only if nobody changed it on the ticket |
| `state: resolved` | internal recovery note; with *recoveryPolicy = resolve* the ticket moves to the resolved status |
| open again after resolution | with *reopenPolicy = reopen* the ticket reopens, else a note |
| `persisting: true` (ticket resolved by a person, atlas still sees the failure) | note "still failing" and reopen per policy; the ticket panel shows *Still failing* |
| `test: true` | validates the path, records contact, creates nothing |

Ticket events written by these updates carry `origin: "atlas"` and never appear in the feed.

### `GET /api/v1/integrations/atlas/v1/incidents/:key` (`atlas.incidents`)

`{ externalKey, revision, state, ticket }` — lets atlas reconcile after a lost response.

### `GET /api/v1/integrations/atlas/v1/ticket-events?after=<cursor>&limit=<1..200>` (`atlas.incidents`)

Technician activity on atlas tickets, oldest first:

```json
{ "events": [ { "id": 9012, "externalKey": "atlas-home:42", "type": "assigned", "at": "…",
                "actor": "Sam Tech", "automation": false, "ticket": { … snapshot … } } ],
  "nextCursor": 9012, "more": false }
```

Types: `status_changed`, `resolved`, `reopened`, `assigned`, `field_changed` (priority only),
`note_added` (with `visibility`). Events caused by atlas itself are excluded (loop prevention).
atlas stores `nextCursor` and polls; it treats the first human status change out of *New* or an
assignment as an **acknowledgement from Taskora** (notifications stop, the incident stays open
until atlas sees recovery).

### `POST /api/v1/integrations/atlas/v1/inventory` (`atlas.cmdb`)

```json
{ "instance": "atlas-home", "mode": "preview", "complete": true,
  "entities": [ { "key": "pve:vm:homelab/105", "name": "zabbix", "kind": "pve-vm", "hostname": "zabbix",
                  "ips": ["10.10.10.221"], "macs": ["bc:24:11:00:01:05"], "pveNode": "pve1", "vmid": 105,
                  "status": "running", "os": "Debian 12", "observedAt": "…", "apps": [{ "name": "zabbix-server" }] } ],
  "relations": [ { "from": "pve:vm:homelab/105", "to": "pve:node:homelab/pve1", "type": "hosted_on" },
                 { "from": "pve:vm:homelab/105", "to": "unifi:dev:f4:92:bf:00:00:02", "type": "connected_to", "detail": "port 5" } ] }
```

Up to 500 entities and 2000 relations per call. Kinds atlas sends: `pve-node`, `pve-vm`,
`pve-lxc`, `linux-host`, `nas`, `unifi-switch`, `unifi-ap`, `unifi-gateway`, `client`.
Relation types: `hosted_on`, `connected_to`, `depends_on`, `runs_on`.

- `mode: preview` writes nothing (no entity, CI, relation or run) and returns the plan.
- `mode: apply` stores observations and acts according to the CMDB mode (`off` → observations
  only; `link_only`; `link_and_create`). Each apply is a *sync run* (Sync history).
- `complete: true` means "this is everything": entities not included are flagged **missing**
  (never deleted) and atlas relations not included are removed (manual relations stay).

Response: `{ mode, cmdbMode, stats, plan: [{ key, name, action, ciId, ciNumber, note }], runId }`
with actions `create | link | update | propose | conflict | unmatched | skip`.

**Matching** (always within the configured company):

1. an entity already linked keeps its CI (renames and IP changes follow; previous names kept);
2. **MAC address** (CI MAC or the linked Action1 endpoint's MAC) or **serial** — one free CI →
   `link`; several → `conflict`; the CI already carries another atlas entity → `conflict`;
3. **hostname/name** only → `propose` (never linked automatically);
4. nothing → `create` (only in `link_and_create`, CI `source = atlas`, type from the per-kind
   map, else *Virtual Machine*/*Server*/*NAS*/*Network Switch*/*Wireless Access Point*/*Router*,
   else the default type).

If Action1 later reports the same device under another CI, the sync reports a `conflict`
("also managed by Action1") instead of merging: an administrator re-links the entity to the
Action1 CI. Since 0.3.0 Action1 itself matches by MAC before creating a CI, so this is rare.

Admin actions on an entity (*CMDB reconciliation*): **Link** to a chosen CI, **Create CI**,
**Unlink**, **Ignore** (future syncs skip it), **Decommissioned** (for missing ones). All audited.

## Administration API (session + permissions)

| Route | Permission |
| --- | --- |
| `GET/PUT /integrations/atlas/settings` | `integrations.read` / `integrations.manage` |
| `GET/POST /integrations/tokens`, `DELETE /integrations/tokens/:id` | `integrations.manage` |
| `GET /integrations/atlas/entities?status&q&page`, `POST …/entities/:id/resolve` | `integrations.read` / `integrations.manage` |
| `GET /integrations/atlas/incidents?open=true`, `GET /integrations/atlas/runs` | `integrations.read` |
| `GET /tickets/:id/atlas`, `GET /configuration-items/:id/atlas` | `tickets.read`, `cis.read` |

## Security notes

- Everything from atlas is untrusted: Zod-validated, size-capped, rendered as text; links are
  rendered only when `http(s)`. Taskora never fetches a URL atlas sends.
- No secrets cross the integration: atlas redacts before sending; Taskora stores token hashes only.
- Writes are scoped by token scope and the configured company; atlas cannot touch other
  companies' tickets or CIs, delete anything, or change permissions.
- Every ticket created or updated by atlas and every CMDB decision is in the audit log with the
  token name.

## Testing

`apps/api/test/atlas.test.ts` covers token scopes/revocation/expiry, incident idempotency
(replay, concurrent duplicates, stale revisions), lifecycle policies, the feed (no echo),
CMDB preview/apply, Action1 ownership, conflicts, proposals, missing flags and panels.
`apps/api/test/action1.test.ts` covers the Action1 MAC match that adopts an atlas CI.
