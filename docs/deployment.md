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

## 6. Action1

Administration → Integrations → Action1: choose the region, enter an API client ID/secret (Action1 → API credentials), test the connection, map each Action1 organization to a Taskora company, enable the integration and run a sync. The worker then syncs on the configured interval. The integration only reads data from Action1.

## Troubleshooting

- **`POSTGRES_PASSWORD is not set`** – create `.env` (step 2).
- **API unhealthy** – `docker compose logs api`; usually a wrong `DATABASE_URL`/password after changing `.env` for an existing volume (the DB password is fixed at first initialisation).
- **Cannot log in after enabling HTTPS** – set `COOKIE_SECURE=true` only when users reach Taskora via HTTPS.
- **Uploads fail** – increase `MAX_UPLOAD_MB` and `NGINX_CLIENT_MAX_BODY_SIZE` together.
- **Uploading a backup to restore fails with 413** – raise `NGINX_CLIENT_MAX_BODY_SIZE` (and `MAX_RESTORE_MB` if needed), or copy the file into the `taskora-backups` volume and restore it from the list instead.
