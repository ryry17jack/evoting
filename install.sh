#!/usr/bin/env bash
#
# E-Voting Kiosk — Linux server installer (Ubuntu/Debian)
#
# Installs everything needed to run the system with a USB Thai ID card reader:
#   - Node.js 20 LTS + build tools (to compile @pokusew/pcsclite)
#   - PC/SC smart-card stack (pcscd + CCID driver) — plug-and-play USB readers
#   - MariaDB server, database schema imported, dedicated app user
#   - systemd service so the app starts on boot and restarts on failure
#
# Usage:
#   1) Edit the variables below (at minimum REPO_URL)
#   2) chmod +x install.sh
#   3) sudo ./install.sh
#
set -euo pipefail

# ----------------------------- configuration --------------------------------
REPO_URL="https://github.com/ryry17jack/evoting.git"
APP_DIR="/opt/e-voting"              # where the app will live
APP_PORT="3000"
DB_NAME="evoting_db"
DB_USER="evoting"
DB_PASS="$(openssl rand -hex 16)"    # random password, written to .env for you
DEMO_MODE="0"                        # 1 = enable F2 card simulation (dev only)
SERVICE_NAME="e-voting"
DOMAIN=""                            # e.g. evote.skatc.ac.th — leave empty to skip nginx/HTTPS
CERTBOT_EMAIL=""                     # email for Let's Encrypt expiry notices (required if DOMAIN set)
# -----------------------------------------------------------------------------

if [[ $EUID -ne 0 ]]; then
  echo "Please run as root: sudo ./install.sh" >&2
  exit 1
fi

if [[ -z "$REPO_URL" ]]; then
  echo "REPO_URL is empty. Edit install.sh and set your GitHub repo URL first." >&2
  exit 1
fi

echo "==> [1/7] Installing base packages..."
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y curl git build-essential python3 openssl ca-certificates

echo "==> [2/7] Installing PC/SC smart-card stack (USB card reader support)..."
apt-get install -y pcscd libpcsclite1 libpcsclite-dev libccid pcsc-tools
systemctl enable --now pcscd
# pcscd + libccid give plug-and-play support for CCID-compliant USB readers
# (ACS ACR38/ACR39/ACR122, Identiv, etc.) — no per-device driver needed.

echo "==> [3/7] Installing Node.js 20 LTS..."
if ! command -v node >/dev/null 2>&1 || [[ "$(node -v | cut -c2-3)" -lt 18 ]]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi
echo "    node $(node -v), npm $(npm -v)"

echo "==> [4/7] Installing MariaDB and creating database..."
apt-get install -y mariadb-server
systemctl enable --now mariadb

mysql <<SQL
CREATE DATABASE IF NOT EXISTS \`${DB_NAME}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS '${DB_USER}'@'localhost' IDENTIFIED BY '${DB_PASS}';
GRANT ALL PRIVILEGES ON \`${DB_NAME}\`.* TO '${DB_USER}'@'localhost';
FLUSH PRIVILEGES;
SQL

echo "==> [5/7] Cloning application from GitHub..."
if [[ -d "$APP_DIR/.git" ]]; then
  git -C "$APP_DIR" pull
else
  git clone "$REPO_URL" "$APP_DIR"
fi

echo "    Importing database schema..."
mysql "$DB_NAME" < "$APP_DIR/database.sql"

echo "==> [6/7] Installing Node dependencies..."
cd "$APP_DIR"
npm install
# @pokusew/pcsclite is an optionalDependency — npm may skip it silently if the
# native build fails. Install it explicitly so a failure is loud, not silent.
npm install @pokusew/pcsclite

# Write .env (only if one doesn't already exist, so re-runs don't clobber it)
if [[ ! -f "$APP_DIR/.env" ]]; then
  cat > "$APP_DIR/.env" <<ENV
DB_HOST=localhost
DB_USER=${DB_USER}
DB_PASS=${DB_PASS}
DB_NAME=${DB_NAME}
PORT=${APP_PORT}
DEMO_MODE=${DEMO_MODE}
ENV
  chmod 600 "$APP_DIR/.env"
  echo "    .env created (DB password: ${DB_PASS})"
else
  echo "    .env already exists — left untouched."
fi

echo "==> [7/7] Creating systemd service..."
# Dedicated unprivileged user for the app
id -u evoting >/dev/null 2>&1 || useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin evoting
chown -R evoting:evoting "$APP_DIR"

cat > "/etc/systemd/system/${SERVICE_NAME}.service" <<UNIT
[Unit]
Description=E-Voting Kiosk Server
After=network.target mariadb.service pcscd.service
Wants=pcscd.service

[Service]
Type=simple
User=evoting
WorkingDirectory=${APP_DIR}
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable --now "$SERVICE_NAME"

# --------------------- optional: domain + HTTPS (nginx) ----------------------
if [[ -n "$DOMAIN" ]]; then
  echo "==> [8/8] Setting up nginx reverse proxy + HTTPS for ${DOMAIN}..."

  if [[ -z "$CERTBOT_EMAIL" ]]; then
    echo "CERTBOT_EMAIL is empty. Set it in install.sh when using DOMAIN." >&2
    exit 1
  fi

  apt-get install -y nginx certbot python3-certbot-nginx

  cat > "/etc/nginx/sites-available/${SERVICE_NAME}" <<NGINX
server {
    listen 80;
    server_name ${DOMAIN};

    location / {
        proxy_pass http://127.0.0.1:${APP_PORT};
        proxy_http_version 1.1;

        # Required for Socket.IO (websocket upgrade)
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";

        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 86400;
    }
}
NGINX

  ln -sf "/etc/nginx/sites-available/${SERVICE_NAME}" "/etc/nginx/sites-enabled/${SERVICE_NAME}"
  rm -f /etc/nginx/sites-enabled/default
  nginx -t
  systemctl enable --now nginx
  systemctl reload nginx

  # Get the certificate and let certbot rewrite the config for HTTPS + redirect.
  # This requires the DNS A record for ${DOMAIN} to already point at this server
  # and port 80/443 to be reachable from the internet.
  certbot --nginx -d "$DOMAIN" -m "$CERTBOT_EMAIL" --agree-tos --non-interactive --redirect

  # Certbot installs a systemd timer that renews automatically; verify with:
  #   systemctl list-timers | grep certbot

  # Once behind nginx, the app itself no longer needs to be reachable directly.
  if command -v ufw >/dev/null 2>&1; then
    ufw allow 'Nginx Full' >/dev/null 2>&1 || true
  fi
fi

echo
echo "=============================================================="
echo " Installation complete!"
echo "=============================================================="
if [[ -n "$DOMAIN" ]]; then
  echo "  App URL      : https://${DOMAIN}"
else
  echo "  App URL      : http://$(hostname -I | awk '{print $1}'):${APP_PORT}"
fi
echo "  App dir      : ${APP_DIR}"
echo "  DB user/pass : ${DB_USER} / ${DB_PASS}  (also saved in ${APP_DIR}/.env)"
echo "  Service      : systemctl status ${SERVICE_NAME}"
echo "  Logs         : journalctl -u ${SERVICE_NAME} -f"
echo
echo "  Card reader  : just plug the USB reader in — pcscd detects it"
echo "                 automatically. Verify with:  pcsc_scan"
echo "=============================================================="
