#!/usr/bin/env bash
# SoniqPlayer API — Oracle Cloud (Ubuntu) one-shot setup.
# Run ON the VM as the default user (ubuntu):  bash oracle_setup.sh
# Expects server.py + requirements.txt + .env already in the current directory
# (scp them up first), or git-clone the repo into /opt/soniq.
set -euo pipefail

APP_DIR=/opt/soniq
PORT=8000
SRC_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "==> Installing system packages"
sudo apt-get update -y
sudo apt-get install -y python3 python3-venv python3-pip ffmpeg git curl

echo "==> Setting up $APP_DIR"
sudo mkdir -p "$APP_DIR"
sudo chown -R "$USER:$USER" "$APP_DIR"

# Copy app files if we're not already inside APP_DIR
if [ "$SRC_DIR" != "$APP_DIR" ]; then
  cp -f "$SRC_DIR/server.py" "$SRC_DIR/requirements.txt" "$APP_DIR/" 2>/dev/null || true
  [ -f "$SRC_DIR/.env" ] && cp -f "$SRC_DIR/.env" "$APP_DIR/" || true
fi

cd "$APP_DIR"
[ -f server.py ] || { echo "ERROR: server.py missing in $APP_DIR"; exit 1; }
[ -f requirements.txt ] || { echo "ERROR: requirements.txt missing"; exit 1; }

echo "==> Python venv + dependencies"
python3 -m venv venv
./venv/bin/pip install --upgrade pip -q
./venv/bin/pip install -r requirements.txt -q

echo "==> API key env file"
if [ ! -f .env ]; then
  KEY="$(python3 -c 'import secrets;print(secrets.token_urlsafe(32))')"
  printf 'SONIQ_API_KEY=%s\nPORT=%s\n' "$KEY" "$PORT" > .env
  echo "    Generated SONIQ_API_KEY=$KEY  <-- save this, it goes in the app build"
fi

echo "==> systemd service (auto-start + auto-restart)"
sudo tee /etc/systemd/system/soniq-api.service > /dev/null <<EOF
[Unit]
Description=SoniqPlayer yt-dlp API
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$USER
WorkingDirectory=$APP_DIR
EnvironmentFile=$APP_DIR/.env
ExecStart=$APP_DIR/venv/bin/python server.py
Restart=always
RestartSec=3
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now soniq-api

echo "==> Firewall (OS level — Oracle images block everything by default)"
sudo iptables -C INPUT -p tcp --dport "$PORT" -j ACCEPT 2>/dev/null \
  || sudo iptables -I INPUT -p tcp --dport "$PORT" -j ACCEPT
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -q iptables-persistent >/dev/null 2>&1 || true
sudo netfilter-persistent save >/dev/null 2>&1 || true

echo ""
echo "============================================================"
echo " DONE. Service status:"
systemctl status soniq-api --no-pager | head -6 || true
echo ""
PUBLIC_IP="$(curl -s --max-time 5 ifconfig.me || echo '<vm-public-ip>')"
echo " Public API URL:  http://$PUBLIC_IP:$PORT"
echo " Test it:         curl http://$PUBLIC_IP:$PORT/api/status"
echo ""
echo " REMEMBER: also add an ingress rule for TCP $PORT in the"
echo " Oracle console → Networking → VCN → Security List (see guide)."
echo "============================================================"
