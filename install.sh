#!/usr/bin/env bash
set -euo pipefail

# HomeLab Agent Installer
# Usage: sudo ./install.sh --dashboard-url http://IP:4000/api --api-key hl_xxxx
#
# This script:
# 1. Detects the OS and installs prerequisites (lm-sensors, vnstat, curl)
# 2. Installs Node.js 20 if not present
# 3. Clones (or updates) the agent to /opt/homelab-agent
# 4. Creates a systemd service that runs as root

INSTALL_DIR="/opt/homelab-agent"
SERVICE_NAME="homelab-agent"
REPO_URL="https://github.com/johnvexcoder/HomeLab-Agent.git"
MIN_NODE_MAJOR=18

# ── Parse args ──
DASHBOARD_URL=""
API_KEY=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dashboard-url) DASHBOARD_URL="$2"; shift 2 ;;
    --api-key)       API_KEY="$2"; shift 2 ;;
    *) echo "Unknown arg: $1"; exit 1 ;;
  esac
done

if [[ -z "$DASHBOARD_URL" || -z "$API_KEY" ]]; then
  echo "Usage: sudo ./install.sh --dashboard-url http://IP:4000/api --api-key hl_xxxx"
  exit 1
fi

# ── Detect OS ──
detect_os() {
  if [[ -f /etc/os-release ]]; then
    . /etc/os-release
    echo "$ID"
  else
    echo "unknown"
  fi
}

OS_ID=$(detect_os)
echo "[installer] Detected OS: $OS_ID"

# ── Install prerequisites ──
install_prereqs() {
  case "$OS_ID" in
    debian|ubuntu|linuxmint|pop)
      echo "[installer] Installing prerequisites via apt..."
      apt-get update -qq
      apt-get install -y -qq git curl lm-sensors vnstat smartmontools build-essential
      ;;
    fedora|rhel|centos|rocky|alma)
      echo "[installer] Installing prerequisites via dnf..."
      dnf install -y git curl lm_sensors vnstat smartmontools gcc gcc-c++ make
      ;;
    arch|manjaro)
      echo "[installer] Installing prerequisites via pacman..."
      pacman -Sy --noconfirm git curl lm_sensors vnstat smartmontools base-devel
      ;;
    alpine)
      echo "[installer] Installing prerequisites via apk..."
      apk add --no-cache git curl lm_sensors vnstat smartmontools build-base python3
      ;;
    proxmox|pve)
      echo "[installer] Installing prerequisites for Proxmox..."
      apt-get update -qq
      apt-get install -y -qq git curl lm-sensors vnstat smartmontools build-essential
      ;;
    *)
      echo "[installer] Unknown OS ($OS_ID). Attempting apt..."
      apt-get update -qq && apt-get install -y -qq git curl lm-sensors vnstat smartmontools build-essential 2>/dev/null || \
      dnf install -y git curl lm_sensors vnstat smartmontools gcc gcc-c++ make 2>/dev/null || \
      { echo "[installer] ERROR: Could not install prerequisites. Install manually: git curl lm-sensors vnstat smartmontools"; exit 1; }
      ;;
  esac
}

# ── Install Node.js ──
install_node() {
  if command -v node &>/dev/null; then
    local node_major
    node_major=$(node -v | sed 's/v\([0-9]*\).*/\1/')
    if [[ "$node_major" -ge "$MIN_NODE_MAJOR" ]]; then
      echo "[installer] Node.js $(node -v) already installed"
      return
    fi
    echo "[installer] Node.js v$(node -v) is too old (need >= $MIN_NODE_MAJOR)"
  fi

  echo "[installer] Installing Node.js 20..."
  case "$OS_ID" in
    debian|ubuntu|linuxmint|pop|proxmox|pve)
      curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
      apt-get install -y -qq nodejs
      ;;
    fedora|rhel|centos|rocky|alma)
      curl -fsSL https://rpm.nodesource.com/setup_20.x | bash -
      dnf install -y nodejs
      ;;
    *)
      # Fallback: use nvm or direct binary
      local ARCH
      ARCH=$(uname -m)
      case "$ARCH" in
        x86_64)  ARCH="x64" ;;
        aarch64) ARCH="arm64" ;;
        armv7l)  ARCH="armv7l" ;;
      esac
      local NODE_URL="https://nodejs.org/dist/v20.18.0/node-v20.18.0-linux-${ARCH}.tar.xz"
      echo "[installer] Downloading Node.js binary..."
      curl -fsSL "$NODE_URL" | tar -xJ -C /usr/local --strip-components=1
      ;;
  esac

  echo "[installer] Node.js $(node -v) installed"
}

# ── Clone / update agent ──
install_agent() {
  if [[ -d "$INSTALL_DIR/.git" ]]; then
    echo "[installer] Updating existing agent at $INSTALL_DIR..."
    cd "$INSTALL_DIR"
    git pull --ff-only 2>/dev/null || echo "[installer] git pull failed, continuing with existing code"
  else
    echo "[installer] Cloning agent to $INSTALL_DIR..."
    rm -rf "$INSTALL_DIR"
    git clone "$REPO_URL" "$INSTALL_DIR"
    cd "$INSTALL_DIR"
  fi

  echo "[installer] Installing npm dependencies..."
  npm ci --omit=dev 2>/dev/null || npm install --omit=dev
  echo "[installer] Building TypeScript..."
  npx tsc
}

# ── Create systemd service ──
create_service() {
  local ENV_FILE="$INSTALL_DIR/.env"
  cat > "$ENV_FILE" <<EOF
DASHBOARD_URL=$DASHBOARD_URL
API_KEY=$API_KEY
POLL_INTERVAL=10000
EVENT_CHECK_INTERVAL=5000
LOG_LEVEL=info
EOF
  chmod 600 "$ENV_FILE"

  cat > "/etc/systemd/system/${SERVICE_NAME}.service" <<EOF
[Unit]
Description=HomeLab Agent
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/bin/node $INSTALL_DIR/dist/index.js
WorkingDirectory=$INSTALL_DIR
EnvironmentFile=$ENV_FILE
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal
SyslogIdentifier=homelab-agent

[Install]
WantedBy=multi-user.target
EOF

  systemctl daemon-reload
  systemctl enable "$SERVICE_NAME"
  systemctl restart "$SERVICE_NAME"
  echo "[installer] Service '$SERVICE_NAME' created and started"
}

# ── Main ──
echo "========================================="
echo "  HomeLab Agent Installer"
echo "========================================="
echo ""

install_prereqs
install_node
install_agent
create_service

echo ""
echo "========================================="
echo "  Installation complete!"
echo "========================================="
echo ""
echo "  Dashboard: $DASHBOARD_URL"
echo "  Service:   systemctl status $SERVICE_NAME"
echo "  Logs:      journalctl -u $SERVICE_NAME -f"
echo "  Config:    $INSTALL_DIR/.env"
echo ""
echo "  The agent will appear in your dashboard"
echo "  within 10-15 seconds."
echo ""
