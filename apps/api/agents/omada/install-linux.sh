#!/usr/bin/env bash
# Taskora Omada agent - Linux installer
#
# Run as root on the machine of the Omada controller (or any machine of the same network).
# Taskora shows the exact command on its Omada page, e.g.:
#
#   curl -fsSL https://taskora.example.com/api/v1/integrations/omada/agent/files/install-linux.sh | sudo bash -s -- --url https://taskora.example.com --token tki_xxx
#
# It installs Node.js (official build in /opt, only if Node 16+ is missing), the agent in
# /opt/taskora-omada-agent, its configuration in /etc/taskora-omada-agent (mode 600), tests the
# connections and installs the systemd service "taskora-omada-agent". Run it again to update.
# Options: --client-id ID --client-secret SECRET --omada-url URL --omada-id ID --verify-tls --force --uninstall
set -euo pipefail

URL="" TOKEN="" CLIENT_ID="" CLIENT_SECRET="" OMADA_URL="" OMADA_ID="" VERIFY_TLS=false FORCE=false UNINSTALL=false
while [ $# -gt 0 ]; do
  case "$1" in
    --url) URL="$2"; shift 2 ;;
    --token) TOKEN="$2"; shift 2 ;;
    --client-id) CLIENT_ID="$2"; shift 2 ;;
    --client-secret) CLIENT_SECRET="$2"; shift 2 ;;
    --omada-url) OMADA_URL="$2"; shift 2 ;;
    --omada-id) OMADA_ID="$2"; shift 2 ;;
    --verify-tls) VERIFY_TLS=true; shift ;;
    --force) FORCE=true; shift ;;
    --uninstall) UNINSTALL=true; shift ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done

DIR=/opt/taskora-omada-agent
ETC=/etc/taskora-omada-agent
CFG=$ETC/config.json
UNIT=/etc/systemd/system/taskora-omada-agent.service
USER_NAME=taskora-omada
say() { printf '\033[36m%s\033[0m\n' "$*"; }

[ "$(id -u)" -eq 0 ] || { echo "Run as root (sudo)." >&2; exit 1; }

if $UNINSTALL; then
  systemctl disable --now taskora-omada-agent 2>/dev/null || true
  rm -f "$UNIT"; systemctl daemon-reload || true
  rm -rf "$DIR" "$ETC"
  id "$USER_NAME" >/dev/null 2>&1 && userdel "$USER_NAME" || true
  say "Taskora Omada agent removed."
  exit 0
fi

ask() { # ask VAR "Prompt" [secret]
  local __v
  if [ "${3:-}" = secret ]; then read -r -s -p "$2: " __v </dev/tty; echo >/dev/tty; else read -r -p "$2: " __v </dev/tty; fi
  printf -v "$1" '%s' "$__v"
}
json_get() { [ -f "$CFG" ] && sed -n "s/.*\"$1\": *\"\([^\"]*\)\".*/\1/p" "$CFG" | head -1 || true; }

[ -n "$URL" ] || ask URL "Taskora address (e.g. https://taskora.example.com)"
URL="${URL%/}"
[ -n "$TOKEN" ] || TOKEN="$(json_get token)"; [ -n "$TOKEN" ] || ask TOKEN "Agent token from Taskora (tki_...)"
[ -n "$CLIENT_ID" ] || CLIENT_ID="$(json_get omadaClientId)"; [ -n "$CLIENT_ID" ] || ask CLIENT_ID "Omada Open API Client ID"
[ -n "$CLIENT_SECRET" ] || CLIENT_SECRET="$(json_get omadaClientSecret)"; [ -n "$CLIENT_SECRET" ] || ask CLIENT_SECRET "Omada Open API Client Secret" secret
[ -n "$OMADA_URL" ] || OMADA_URL="$(json_get omadaUrl)"
[ -n "$OMADA_ID" ] || OMADA_ID="$(json_get omadacId)"

mkdir -p "$DIR" "$ETC"

# 1. Node.js 16+ (system one, or the official build in /opt/taskora-omada-agent/node).
NODE=""
if command -v node >/dev/null 2>&1 && [ "$(node -p 'process.versions.node.split(".")[0]')" -ge 16 ]; then NODE="$(command -v node)"; fi
[ -z "$NODE" ] && [ -x "$DIR/node/bin/node" ] && NODE="$DIR/node/bin/node"
if [ -z "$NODE" ]; then
  case "$(uname -m)" in x86_64) ARCH=x64 ;; aarch64|arm64) ARCH=arm64 ;; armv7l) ARCH=armv7l ;; *) echo "Unsupported CPU $(uname -m): install Node.js 18+ and run again." >&2; exit 1 ;; esac
  say "Downloading Node.js (only for the agent)..."
  FILE="$(curl -fsSL https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt | grep -o "node-v[0-9.]*-linux-$ARCH.tar.gz" | head -1)"
  [ -n "$FILE" ] || { echo "Could not find Node.js for $ARCH: install Node.js 18+ and run again." >&2; exit 1; }
  rm -rf "$DIR/node" && mkdir -p "$DIR/node"
  curl -fsSL "https://nodejs.org/dist/latest-v22.x/$FILE" | tar -xz -C "$DIR/node" --strip-components=1
  NODE="$DIR/node/bin/node"
fi
say "Node.js: $NODE ($($NODE --version))"

# 2. The agent.
curl -fsSL "$URL/api/v1/integrations/omada/agent/files/omada-agent.mjs" -o "$DIR/omada-agent.mjs"
say "Agent: $DIR/omada-agent.mjs ($($NODE "$DIR/omada-agent.mjs" --version))"

# 3. Configuration (mode 600, owned by the service user).
id "$USER_NAME" >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin "$USER_NAME"
esc() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }
cat >"$CFG" <<EOF
{
  "taskoraUrl": "$(esc "$URL")",
  "token": "$(esc "$TOKEN")",
  "omadaUrl": "$(esc "$OMADA_URL")",
  "omadaClientId": "$(esc "$CLIENT_ID")",
  "omadaClientSecret": "$(esc "$CLIENT_SECRET")",
  "omadacId": "$(esc "$OMADA_ID")",
  "verifyTls": $VERIFY_TLS,
  "verifyTaskoraTls": true
}
EOF
chown -R "$USER_NAME": "$ETC" && chmod 700 "$ETC" && chmod 600 "$CFG"

# 4. Test both connections.
say "Testing the connection to Omada and to Taskora..."
if ! runuser -u "$USER_NAME" -- "$NODE" "$DIR/omada-agent.mjs" --test --config "$CFG"; then
  $FORCE || { echo "The test failed: fix the problem above and run the command again (add --force to install anyway)." >&2; exit 1; }
fi

# 5. systemd service.
cat >"$UNIT" <<EOF
[Unit]
Description=Taskora Omada agent (sends Omada sites, devices and clients to Taskora)
After=network-online.target
Wants=network-online.target

[Service]
User=$USER_NAME
ExecStart=$NODE $DIR/omada-agent.mjs --config $CFG
Restart=always
RestartSec=30
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=$ETC
ProtectHome=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable taskora-omada-agent >/dev/null
systemctl restart taskora-omada-agent

echo
say "Taskora Omada agent installed and running."
echo "  Status:     systemctl status taskora-omada-agent"
echo "  Logs:       journalctl -u taskora-omada-agent -f   (also $ETC/agent.log)"
echo "  Test again: runuser -u $USER_NAME -- $NODE $DIR/omada-agent.mjs --test --config $CFG"
echo "  Uninstall:  run the install command again with --uninstall"
echo "Next: in Taskora (Omada page > Sites) map each Omada site to its company. The agent sends the data every few minutes."
