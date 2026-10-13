#!/usr/bin/env bash
# One-time setup on a fresh Hostinger VPS (Ubuntu 22.04/24.04). Run as root or with sudo.
# Usage: sudo bash deploy/setup-vps.sh pump.example.com you@email.com
set -euo pipefail
DOMAIN="${1:?usage: setup-vps.sh <domain> <email>}"
EMAIL="${2:?usage: setup-vps.sh <domain> <email>}"
APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"

echo "==> Node.js 20"
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi

echo "==> Nginx, Certbot, PM2"
apt-get install -y nginx certbot python3-certbot-nginx
npm install -g pm2

echo "==> Build"
cd "$APP_DIR"
npm ci
npm run build
if [ ! -f .env ]; then
  cp .env.example .env
  SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
  sed -i "s/^MCP_SECRET=.*/MCP_SECRET=$SECRET/" .env
  echo "    created .env with a random MCP_SECRET"
fi
chmod 600 .env

echo "==> Nginx site"
sed "s/pump.example.com/$DOMAIN/" deploy/nginx-pumpfun-mcp.conf > /etc/nginx/sites-available/pumpfun-mcp
ln -sf /etc/nginx/sites-available/pumpfun-mcp /etc/nginx/sites-enabled/pumpfun-mcp
nginx -t && systemctl reload nginx

echo "==> HTTPS"
certbot --nginx -d "$DOMAIN" -m "$EMAIL" --agree-tos --non-interactive --redirect

echo "==> Firewall"
if command -v ufw >/dev/null; then ufw allow OpenSSH; ufw allow 'Nginx Full'; ufw --force enable; fi

echo "==> Start"
pm2 start deploy/ecosystem.config.cjs
pm2 save
pm2 startup systemd -u "$(whoami)" --hp "$HOME" | tail -1 | bash || true

SECRET=$(grep ^MCP_SECRET= .env | cut -d= -f2)
echo
echo "Done. Health:      https://$DOMAIN/health"
echo "claude.ai URL:     https://$DOMAIN/mcp/$SECRET"
echo "Keep that URL private — it is the password."
