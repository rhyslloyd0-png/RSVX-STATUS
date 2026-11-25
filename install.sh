#!/usr/bin/env bash
# Sets RSVX Status up as a service on this VPS so it starts on boot and
# restarts itself if it ever stops.   Usage:  sudo ./install.sh
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUN_AS="${SUDO_USER:-root}"

if [ "$(id -u)" -ne 0 ]; then echo "Run this with sudo: sudo ./install.sh"; exit 1; fi

NODE="$(command -v node || true)"
if [ -z "$NODE" ]; then NODE="$(sudo -iu "$RUN_AS" bash -lc 'command -v node' 2>/dev/null || true)"; fi
if [ -z "$NODE" ]; then echo "Node.js is not installed. Install Node 18 or newer, then run this again."; exit 1; fi
MAJOR="$("$NODE" -p 'process.versions.node.split(".")[0]')"
if [ "$MAJOR" -lt 18 ]; then echo "Node $MAJOR is too old. Node 18 or newer is needed."; exit 1; fi

if [ ! -f "$DIR/.env" ]; then
  cp "$DIR/.env.example" "$DIR/.env"
  chown "$RUN_AS" "$DIR/.env"
  echo "Created $DIR/.env. Fill it in (nano $DIR/.env), then run this again."
  exit 0
fi
chmod 600 "$DIR/.env"
mkdir -p "$DIR/data" && chown -R "$RUN_AS" "$DIR/data"

cat > /etc/systemd/system/rsvx-status.service <<UNIT
[Unit]
Description=RSVX Status
After=network-online.target
Wants=network-online.target

[Service]
User=$RUN_AS
WorkingDirectory=$DIR
ExecStart=$NODE $DIR/server.js
Restart=always
RestartSec=5
Environment=PATH=$(dirname "$NODE"):/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable rsvx-status >/dev/null
systemctl restart rsvx-status
sleep 2
systemctl --no-pager --lines=5 status rsvx-status || true
PORT="$(grep -E '^PORT=' "$DIR/.env" | cut -d= -f2)"
echo
echo "RSVX Status is running on port ${PORT:-8787}."
echo "Logs:    journalctl -u rsvx-status -f"
echo "Update:  git pull && sudo systemctl restart rsvx-status"
