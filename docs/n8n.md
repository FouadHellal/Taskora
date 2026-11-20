# Automating Taskora with n8n (and other tools)

Taskora exposes everything through its REST API (`/api/v1`, see [api.md](api.md)). Three building blocks make it easy to automate:

| Block | Direction | Where |
| --- | --- | --- |
| **API keys** (`Bearer tka_…`) | n8n → Taskora | Settings → API & webhooks |
| **Webhooks** (signed JSON POST) | Taskora → n8n | Settings → API & webhooks (permission `integrations.manage`) |
| **Inbound e-mail endpoint** (`POST /api/v1/inbound/email`) | mailbox → n8n → Taskora | Settings → E-mail to ticket |

## 1. API key

1. In Taskora: **Settings → API & webhooks → New API key**. Copy the key (shown once).
2. In n8n: **Credentials → New → Header Auth**: name `Authorization`, value `Bearer tka_…`.
3. Use the **HTTP Request** node with that credential, base URL `https://<your-taskora>/api/v1`.

The key acts as its owner with the owner's role permissions (CSRF does not apply). For integrations, create a dedicated user with a limited role (e.g. *Technician*) and create the key while signed in as that user. Revoking the key or deactivating the user stops it immediately.

Useful endpoints:

| Purpose | Request |
| --- | --- |
| List tickets | `GET /tickets?statusCategory=open&q=printer&page=1&pageSize=50` |
| Ticket details | `GET /tickets/{id}` |
| Create ticket | `POST /tickets` `{ "title", "companyId", "contactId?", "description?", "priorityId?", "queueId?", "assignedUserId?" }` |
| Update ticket | `PATCH /tickets/{id}` with any changed fields (`statusId`, `assignedUserId`, `priorityId`, `dueAt`, `tags`, `customFields`…) |
| Add note | `POST /tickets/{id}/notes` `{ "body", "visibility": "internal" \| "public", "notifyContact?" }` |
| Log time | `POST /time-entries` `{ "ticketId", "startedAt", "durationMinutes", "description", "workTypeId?" }` |
| Companies / contacts | `GET/POST /companies`, `GET/POST /contacts` |
| Picklist ids (statuses, priorities, queues, users…) | `GET /lookups` |

Errors are JSON: `{ "error": { "code", "message", "details": { "fields" } } }`.

## 2. Webhooks

1. In n8n add a **Webhook** trigger (method POST) and copy its production URL.
2. In Taskora: **Settings → API & webhooks → New webhook**, paste the URL, pick events, save and copy the signing secret.
3. **Send test** delivers a `webhook.test` event.

Events: `ticket.created`, `ticket.updated`, `ticket.note_added`, `ticket.sla_breached`, `time_entry.created`, `company.created`, `contact.created` (or `*`).

Body:

```json
{
  "id": "6c1e…",
  "event": "ticket.created",
  "occurredAt": "2026-11-20T09:12:00.000Z",
  "data": {
    "ticket": {
      "id": 142, "ticketNumber": "TKA-000142", "title": "Printer offline",
      "companyId": 7, "companyName": "Northstar", "contactName": "Emma Smith", "contactEmail": "emma@…",
      "statusName": "New", "priorityName": "High", "queueName": "Service Desk",
      "assigneeName": "", "assigneeEmail": null, "tags": [], "customFields": {}
    }
  }
}
```

`ticket.note_added` adds `data.note`; `time_entry.created` sends `data.timeEntry`.

Headers: `X-Taskora-Event`, `X-Taskora-Delivery` (unique id — use it to ignore duplicates), and `X-Taskora-Signature: sha256=<hex>` = HMAC-SHA256 of the raw body with the secret. In n8n, verify it with a **Crypto** node (HMAC, SHA256, hex) on the raw body (enable *Raw body* on the Webhook node) and an **IF** node.

Non-2xx answers and timeouts (15 s) are retried by the worker with exponential back-off (up to 6 attempts). The last status and error are shown in the webhook list.

## 3. E-mail to ticket through n8n

Use this when the mailbox does not allow IMAP passwords (Microsoft 365, Google Workspace with OAuth only):

1. n8n trigger: **Microsoft Outlook Trigger**, **Gmail Trigger** or **Email Trigger (IMAP)**.
2. **HTTP Request**: `POST https://<your-taskora>/api/v1/inbound/email` with the API-key credential and JSON body:

```json
{
  "from": "{{ $json.from.value[0].address }}",
  "fromName": "{{ $json.from.value[0].name }}",
  "subject": "{{ $json.subject }}",
  "text": "{{ $json.text }}",
  "messageId": "{{ $json.messageId }}",
  "attachments": []
}
```

`attachments` is optional: `[{ "fileName", "contentType", "contentBase64" }]`.

The response is `{ "status": "created" | "appended" | "rejected" | "duplicate", "ticketId" }`. A subject containing a ticket number (e.g. `[TKA-000142]`) appends a customer-visible note to that ticket; otherwise a ticket is created for the sender's contact/company (or the fallback company from Settings → E-mail to ticket). Sending the same `messageId` twice is ignored.

## Example flows

- **High-priority ticket → Teams**: Webhook (`ticket.created`) → IF `{{$json.body.data.ticket.priorityName}}` is `High`/`Critical` → Microsoft Teams node.
- **SLA breach → SMS / on-call**: Webhook (`ticket.sla_breached`) → your paging tool.
- **RMM alert → ticket**: RMM webhook → HTTP Request `POST /api/v1/tickets` → `POST /api/v1/tickets/{id}/notes` with the alert details.
- **Weekly time report**: Schedule → HTTP Request `GET /api/v1/reports/time?…` (CSV) → e-mail.
