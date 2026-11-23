# Deploying Taskora on Ubuntu Server

Taskora runs as four containers: `postgres` (internal network only), `api`, `worker` and `web` (nginx, the only published port). Tested target: Ubuntu Server 22.04/24.04 LTS, 2 vCPU, 2–4 GB RAM, 20 GB disk.

## 1. Install Docker Engine

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl git
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" | sudo tee /etc/apt/sources.list.d/docker.list
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo usermod -aG docker $USER   # log out and back in
```

**Proxmox:** prefer a VM. In an LXC container Docker needs `nesting=1,keyctl=1` (unprivileged containers may still hit overlayfs limitations).

## 2. Get the code and configure

```bash
git clone https://github.com/FouadHellal/Taskora.git taskora
cd taskora
bash scripts/install.sh        # creates .env with generated secrets, builds, starts, prints setup token
```

Manual alternative:

```bash
cp .env.example .env
chmod 600 .env
sed -i "s/^POSTGRES_PASSWORD=.*/POSTGRES_PASSWORD=$(openssl rand -hex 32)/" .env
sed -i "s/^TASKORA_ENCRYPTION_KEY=.*/TASKORA_ENCRYPTION_KEY=$(openssl rand -hex 32)/" .env
docker compose up -d --build
```

Important `.env` settings (all documented in `.env.example`):

| Variable | Purpose |
| --- | --- |
| `POSTGRES_PASSWORD` | Database password (required) |
| `TASKORA_ENCRYPTION_KEY` | 64 hex chars, encrypts integration secrets (required). **Back it up** — losing it means re-entering Action1 credentials. |
| `TASKORA_BIND_ADDRESS` / `TASKORA_HTTP_PORT` | Where the UI listens (default `0.0.0.0:8080` = LAN). Use `127.0.0.1` behind a reverse proxy on the same host. |
| `COOKIE_SECURE` | `auto` (default) / `true` behind HTTPS |
| `TASKORA_SETUP_TOKEN` | Optional fixed first-run token |
| `IMAP_HOST`, `IMAP_PORT`, `IMAP_SECURE`, `IMAP_USER`, `IMAP_PASSWORD`, `IMAP_MAILBOX` | Optional inbound e-mail → ticket (fallback company and queue in System Settings) |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM`, `PUBLIC_URL` | Optional e-mail notifications through your SMTP relay (links use `PUBLIC_URL`). Can instead be configured in the UI: Administration → E-mail (UI settings take precedence). |
| `MAX_RESTORE_MB` | Largest backup file accepted by an uploaded restore (default 512). Restoring a backup kept on the server has no size limit. |

## 3. First-run setup

```bash
docker compose ps                         # all services healthy
docker compose logs api | grep "setup token"
```

Browse to `http://<server-ip>:8080`, enter the token and create the administrator. The token stops working once an administrator exists.

Restrict access to your LAN with the firewall:

```bash
sudo ufw allow from 192.168.1.0/24 to any port 8080 proto tcp
sudo ufw enable
```

## 4. HTTPS with a reverse proxy

Set `TASKORA_BIND_ADDRESS=127.0.0.1` and `COOKIE_SECURE=true` in `.env`, then `docker compose up -d`.

**Caddy** (automatic certificates):

```
psa.example.com {
    reverse_proxy 127.0.0.1:8080
}
```

**nginx**:

```nginx
server {
    listen 443 ssl http2;
    server_name psa.example.com;
    ssl_certificate     /etc/letsencrypt/live/psa.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/psa.example.com/privkey.pem;
    client_max_body_size 30m;
    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
    }
}
```

If the proxy runs on another machine, set `TASKORA_TRUSTED_PROXY` to its address so client IPs are logged correctly.

## 5. Operations

| Task | Command |
| --- | --- |
| Status / health | `docker compose ps` · `bash scripts/healthcheck.sh` |
| Logs | `docker compose logs -f api worker web` |
| Backup (DB + uploads) | `bash scripts/backup.sh` → `./backups/<timestamp>/` |
| Restore | `bash scripts/restore.sh backups/<timestamp>` |
| Update | `bash scripts/update.sh` (pulls, optional backup, rebuilds, restarts) |
| Reset a password | `docker compose exec api node dist/cli/reset-password.js user@example.com` |
| Run migrations manually | `docker compose exec api node dist/db/migrate-cli.js` |
| Demo data (non-production only) | `docker compose exec -e TASKORA_ALLOW_DEMO_SEED=true api node dist/db/seed/demo-cli.js` |

Nightly backups with cron (as the user owning the checkout):

```
30 2 * * * cd /opt/taskora && bash scripts/backup.sh >> backups/backup.log 2>&1
```

Copy `backups/` and your `.env` off the server regularly.

### Backups from the web UI

Administration → System → **Backup & Restore** (permission `backups.manage`, administrators by default):

- **Save backup on the server** writes one compressed file (`taskora-backup-<UTC timestamp>.json.gz`) with every table — tickets, notes, companies, contacts, CIs, contracts, time, invoices, projects, KB, Action1 organizations/endpoints and sync history, settings, users and roles, audit log, logos — plus, optionally, all uploaded files. It is stored in the `taskora-backups` Docker volume (`/app/data/backups`).
- **Download a backup now** streams the same file to your browser without keeping a copy.
- **Automatic backups**: the worker saves a backup every *N* hours (default 24) and keeps the last *M* (default 7). Manual backups are never pruned.
- **Restore** (from the list or from an uploaded file) replaces all data in one transaction — either everything is restored or nothing changes — and saves a *pre-restore* backup first. Everyone is signed out afterwards.

Integration secrets (Action1, SMTP) inside a backup are encrypted with `TASKORA_ENCRYPTION_KEY`; keep that key with your backups. To copy UI backups off the host:

```
docker run --rm -v taskora_taskora-backups:/b -v "$PWD":/out alpine cp -r /b /out/ui-backups
```

The `pg_dump` scripts above remain the right tool for disaster recovery of the whole stack; UI backups are portable between Taskora installations of the same or a newer version.

### Moving to another server (VM → VPS)

A **migration package** contains everything — all tables (tickets, companies, users and roles, settings, custom fields, workflows, API keys, webhooks, integrations, logos…) and all uploaded files — with the stored passwords (SMTP, IMAP, Action1, webhook secrets) re-encrypted with a passphrase you choose, so they work on a server with a different `TASKORA_ENCRYPTION_KEY`.

1. **Old server**: Administration → Backup & Restore → *Move Taskora to another server* → passphrase → **Download migration package** (or **Save it on this server**, or from a shell:
   `docker compose exec -e TASKORA_MIGRATION_PASSPHRASE='…' api node dist/cli/migration.js export`).
2. **New server**: install Taskora (sections 1–4), create a temporary administrator with the setup token.
3. **New server**: Backup & Restore → **Import migration package…** → same passphrase → type RESTORE. Everybody signs in again with their old accounts.

Large packages (above `MAX_RESTORE_MB`, default 512 MB): copy the file into the backups volume and import it from the list or the shell:

```bash
docker run --rm -v taskora_taskora-backups:/b -v "$PWD":/in alpine sh -c 'cp /in/taskora-migration-*.json.gz /b/ && chown 1000:1000 /b/*'
docker compose exec -e TASKORA_MIGRATION_PASSPHRASE='…' api node dist/cli/migration.js import taskora-migration-YYYYMMDD-HHMMSS.json.gz --yes
```

Not included: the `.env` file (set `PUBLIC_URL`, HTTPS and ports on the new server; it keeps its own `TASKORA_ENCRYPTION_KEY`), sign-in sessions and old backups. Point n8n and other tools that call Taskora at the new address.

## 6. Client portal, e-mails, reports and billing

Contacts of your client companies sign in at `https://<your-address>/portal` (also the **Sign in as a client** button on the sign-in page). Give access on a contact (**Client portal** card) or in **Administration → Client portal**: send an invitation e-mail (needs outgoing e-mail and `PUBLIC_URL` so the link points to the right address) or share a generated password. What clients see is set on the same page.

### Outgoing e-mail with Gmail

Taskora sends every e-mail (IT alerts, client confirmations, monthly reports, invitations) through one SMTP account. With a Gmail or Google Workspace address:

1. Sign in to the Google account, turn on **2-Step Verification** (myaccount.google.com → Security).
2. Create an **app password** at myaccount.google.com/apppasswords (name it "Taskora") and copy the 16 letters.
3. In Taskora, **Administration → E-mail**: click **Use Gmail settings** (host `smtp.gmail.com`, port `587`, TLS unticked = STARTTLS), user = the full Gmail address, password = the app password, From = the same address (optionally `Your IT team <address>`). Save, then **Send test e-mail**.
4. Make sure `PUBLIC_URL` in `.env` is the address clients use (e.g. `https://51.103.217.132`), so the buttons in e-mails open the right page.

Gmail limits a normal account to about 500 messages a day, which is plenty for a service desk. The same can be set with `SMTP_HOST=smtp.gmail.com`, `SMTP_PORT=587`, `SMTP_SECURE=false`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM` in `.env`; the UI settings take precedence.

### One mailbox for sending and receiving

Use the same Gmail account for everything so the whole conversation stays on the tickets:

1. **Administration → E-mail**: the Gmail account and app password (above). Leave *Reply-To* empty so clients answer the same address.
2. **Settings → E-mail to ticket**: tick *Turn incoming e-mail into tickets* and *Use the same mailbox as outgoing e-mail*, save, then *Test connection*. Taskora reads `imap.gmail.com` with the same user and app password every minute: a reply with `[TKA-…]` in the subject becomes a note on that ticket, any other e-mail becomes a new ticket.

### Which e-mails open tickets

Taskora matches each incoming e-mail to a client company by its sender: an existing **contact** with that address (personal addresses such as gmail.com work too), otherwise the company whose **E-mail domains** contain the sender's domain (set on the company, e.g. `lesaures.com`). A new sender from a known domain becomes a contact automatically. Leave *Company for unknown senders* empty so that everybody else is refused (they appear in the inbound log with the reason). Replies with `[TKA-…]` in the subject are added to their ticket under the name of the contact — or technician — who wrote them.

Every new ticket also gets an internal *Automatic analysis* note (topic, device, urgency, similar tickets, first checks). Both options are in *Settings → E-mail to ticket → Matching*.

### Look of the e-mails and signature

**Administration → E-mail → Look of the e-mails and signature**: upload the e-mail logo (a version made for the header colour), pick the header and accent colours, add a footer line and the signature (plain text or HTML with `{{sender}}`, `{{organization}}`, `{{logo}}`, `{{portal}}`). The preview shows a client e-mail as it will be sent. Images in the signature must be reachable from the internet, so `PUBLIC_URL` must be the public HTTPS address.

### Alerts, reports and billing

- **Administration → Client portal → E-mail notifications**: the IT team addresses alerted about every new ticket and client reply, and the switch for e-mails to clients.
- **Monthly reports**: prepared on the chosen day for every company with an active contract or portal users (as drafts by default). Review and publish them in **Insights → Client reports**. The worker container does this; nothing else to schedule.
- **Contract & billing**: put your price list in **Services** (per device of a type, per user, or a fixed quantity), add the services to each client's contract with **Count automatically**, and set the billing period (quarterly, annual…). Company managers see it in the portal.

## 7. TP-Link Omada (Wi-Fi access points)

1. In the Omada controller: **Global View → Settings → Platform Integration → Open API → Add New App**, name `Taskora`, mode **Client** (client credentials), no redirect URL, read access (Viewer) to the sites to synchronise. Copy the Client ID and Client Secret.
2. Taskora must reach the controller: on-premise controllers listen on `https://<ip>:8043` (OC200/OC300 often `:443`). If Taskora runs in Azure and the controller on a client LAN, publish the controller (VPN, port forward restricted to the Taskora server's public IP) or use the Omada cloud-based controller's northbound address.
3. **Administration → Integrations → TP-Link Omada → Settings**: controller address, Client ID and secret, leave *Verify the TLS certificate* unticked for a factory certificate, *Test connection*, tick *Synchronise* and save.
4. **Sites** tab: map each Omada site to its company, then **Synchronise now**. Access points appear as configuration items of the company, with their status and connected clients on the CI page.

## 8. Action1

Administration → Integrations → Action1: choose the region, enter an API client ID/secret (Action1 → API credentials), test the connection, map each Action1 organization to a Taskora company, enable the integration and run a sync. The worker then syncs on the configured interval. The integration only reads data from Action1.

## Troubleshooting

- **`POSTGRES_PASSWORD is not set`** – create `.env` (step 2).
- **API unhealthy** – `docker compose logs api`; usually a wrong `DATABASE_URL`/password after changing `.env` for an existing volume (the DB password is fixed at first initialisation).
- **Cannot log in after enabling HTTPS** – set `COOKIE_SECURE=true` only when users reach Taskora via HTTPS.
- **Uploads fail** – increase `MAX_UPLOAD_MB` and `NGINX_CLIENT_MAX_BODY_SIZE` together.
- **Uploading a backup to restore fails with 413** – raise `NGINX_CLIENT_MAX_BODY_SIZE` (and `MAX_RESTORE_MB` if needed), or copy the file into the `taskora-backups` volume and restore it from the list instead.
