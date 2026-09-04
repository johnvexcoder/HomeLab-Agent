<div align="center">

<img src="https://raw.githubusercontent.com/johnvexcoder/HomeLab-OS/main/frontend/public/favicon.svg" width="110" height="110" alt="HomeLab OS icon" />

# HomeLab Agent

**Modular, plugin-based system telemetry agent for [HomeLab OS](https://github.com/johnvexcoder/HomeLab-OS).**

Collects host metrics, Docker containers, Proxmox VE node telemetry, hardware sensors, SMART disk health, and network data — then reports securely to the HomeLab Dashboard.

**v2.0.0**

[![Node 24](https://img.shields.io/static/v1?style=for-the-badge&label=Node%2024%20LTS&message=TypeScript&color=34D399)](https://nodejs.org)
[![Plugins](https://img.shields.io/static/v1?style=for-the-badge&label=Plugins&message=6%20modular&color=34D399)](src/plugins)
[![Platform](https://img.shields.io/static/v1?style=for-the-badge&label=Platform&message=Linux%20%7C%20Proxmox%20%7C%20Docker&color=34D399)](install.sh)
[![License](https://img.shields.io/static/v1?style=for-the-badge&label=License&message=GPLv3&color=blue&logo=gnu&logoColor=white)](LICENSE)

</div>

---

## Table of Contents

- [Overview](#overview)
- [Architecture](#architecture)
- [Plugin System](#plugin-system)
- [Events](#events)
- [Features](#features)
- [Installation](#installation)
- [Setup Guide](#setup-guide)
- [Configuration](#configuration)
- [Security](#security)
- [Maintenance & Monitoring](#maintenance--monitoring)
- [Adding a Plugin](#adding-a-plugin)
- [Extending](#extending)
- [Requirements](#requirements)
- [Author & Credits](#author--credits)
- [License](#license)

---

## Overview

HomeLab Agent runs on every host in your infrastructure and reports **node-local telemetry** that the Proxmox API does **not** expose — temperatures, fan speeds, SMART health, kernel information, local services, and more.

The agent and the Proxmox API are **not competitors**. They are two independent data providers. The HomeLab OS backend merges data from both into a single unified model. The frontend never knows whether information came from the Proxmox API or the agent.

| Proxmox API (authoritative) | HomeLab Agent (enrichment) |
|---|---|
| VM / LXC inventory & runtime metrics | CPU temperature, fan speeds, voltages |
| Cluster information | SMART disk health & remaining life |
| Storage configuration | Docker containers & compose projects |
| Snapshots, HA, replication | Kernel information & package updates |
| Backup jobs & history | Local system services & processes |
| Task history | ZFS / Ceph health (local node) |
| VM CPU / Memory / Disk / Network | Network interface stats & throughput |
| | UPS battery status |
| | Hardware inventory (DMI / SMBIOS) |

> **Ownership rule:** only one component owns a specific type of information. No duplication.

---

## Architecture

```
┌────────────────────────────────────────────────────────────────┐
│                    HomeLab Agent                               │
│      Agent Core  ·  TypeScript / Node 24 LTS                   │
│                                                                │
│   Registry (capabil.) · Shared cache · Event engine            │
│   REST API  ·  X-Agent-Key auth  ·  single endpoint            │
│                                                                │
│            Per-Plugin Poll Scheduler                           │
│        (each plugin runs at its own interval)                  │
└────────────────────────────────────────────────────────────────┘

                              │
                              ▼

┌────────────────────────────────────────────────────────────────┐
│  Plugins · auto-detected, only active ones run                 │
│  ├─ Linux    (1s)   cpu · mem · swap · fs · proc               │
│  ├─ Docker   (5s)   containers · images                        │
│  ├─ Proxmox (10s)   node telemetry · zfs · ceph                │
│  ├─ Sensors  (5s)   temperature · fan · voltage                │
│  ├─ SMART  (10min)  disk_health                                │
│  └─ Network (5s)    ifaces · gw · dns · latency                │
└────────────────────────────────────────────────────────────────┘

                              │
                          report ────►

┌────────────────────────────────────────────────────────────────┐
│              HomeLab OS Dashboard (backend)                    │
│  merges Agent + Proxmox data into a unified model              │
│  telemetry engine · history · alerts · WebSocket               │
└────────────────────────────────────────────────────────────────┘
```

### Plugin System

Every feature is an independent plugin. Plugins **only** collect, normalize, and publish data. They never do HTTP, authentication, WebSocket, or network retries — those responsibilities belong exclusively to the **Agent Core**.

| Plugin | Capabilities | Poll Interval |
|--------|-------------|---------------|
| **Linux** | `cpu`, `memory`, `swap`, `filesystem`, `processes`, `packages`, `services`, `system_info` | 1s |
| **Docker** | `containers`, `images`, `compose_projects` | 5s |
| **Proxmox VE** | `node_telemetry`, `node_events`, `hardware_inventory`, `zfs_health`, `ceph_health` | 10s |
| **Sensors** | `temperature`, `fan`, `voltage` | 5s |
| **SMART** | `disk_health` | 10 min |
| **Network** | `network_interfaces`, `gateway`, `dns`, `public_ip`, `latency`, `packet_loss` | 5s |

### Capability-Based Design

The backend requests data by **capability**, not by plugin. Each plugin declares which capabilities it provides, and the Agent Core maps capabilities to plugins, serving cached data on demand. This decouples the agent's internal plugin structure from the backend's data model.

### Auto-Detection

The agent automatically detects its environment at startup — **zero configuration required**:

- **OS:** Debian, Ubuntu, Fedora, Arch, Proxmox, Raspbian, Alpine, and more
- **Host type:** Bare metal, VM (KVM/QEMU/VMware/VirtualBox/Hyper-V), hypervisor (Proxmox), container (Docker/LXC/K8s)
- **Platform:** Server, laptop, Raspberry Pi
- **Services:** Docker, lm-sensors, smartctl — only active plugins run

### Per-Plugin Poll Scheduling

Not everything runs every second:

- CPU, memory → **1 second**
- Temperature, network → **5 seconds**
- Proxmox node → **10 seconds**
- SMART health → **10 minutes**
- Public IP → **30 minutes**

### Shared Metric Cache

One system call feeds multiple consumers:

```
lm-sensors execution
       ↓
   Shared Cache
       ↓
  ┌────┼────┬────────┬──────────┐
  CPU  Temp  Alerts  Dashboard  Widgets
```

No duplicated system calls — one `sensors -j` execution serves the temperature widget, CPU card, alerts engine, and dashboard overview simultaneously.

---

## Events

The agent generates events for **local operating system and hardware** state changes:

| Event | Severity |
|-------|----------|
| CPU temperature high | warning / critical |
| SMART drive failure | critical |
| Fan stopped (0 RPM) | critical |
| ZFS pool degraded | critical |
| Ceph health warning | warning |
| Container unhealthy | critical |
| Container removed | warning |
| Gateway unreachable | critical |
| DNS resolution failed | critical |
| UPS battery low | critical |
| CPU usage sustained high | warning |
| Memory usage critical | critical |

The backend combines these with Proxmox events into a unified event timeline.

---

## Features

- **6 independent plugins** — Linux, Docker, Proxmox VE, Sensors, SMART, Network
- **Plugin isolation** — one plugin crash does not affect others
- **Auto-detection** — works on any Linux host without configuration
- **Capability-based API** — backend requests data by capability, not plugin
- **Per-plugin polling** — each plugin runs at its own optimal interval
- **Shared metric cache** — one system call, many consumers
- **State-change events** — CPU high, disk failing, container unhealthy, gateway down
- **Secure authentication** — API key via `X-Agent-Key` header, never over WebSocket
- **Delta reporting** — only freshly collected data is sent per cycle
- **Graceful degradation** — missing tools (smartctl, sensors) disable only that plugin
- **Cross-platform** — Debian, Ubuntu, Fedora, Arch, Proxmox, Raspbian, Alpine, Docker, LXC, K8s
- **Low resource usage** — < 1% CPU, < 60 MB RAM

---

## Installation

### Prerequisites

- Node.js ≥ 24 (the installer handles this automatically)
- Linux (any distribution)
- Network access to the HomeLab OS frontend proxy (`https://<dashboard-host>/api`, or explicit private-LAN HTTP)

### Quick Install (recommended)

```bash
# On each host (PVE0, debian02, etc.)
sudo ./install.sh --dashboard-url https://DASHBOARD_HOST/api \
  --api-key-file /secure/path/agent-api-key
```

### Manual Install

```bash
git clone https://github.com/johnvexcoder/HomeLab-Agent.git /opt/homelab-agent
cd /opt/homelab-agent
sudo ./install.sh --dashboard-url https://DASHBOARD_HOST/api \
  --api-key-file /secure/path/agent-api-key
```

### Docker

```bash
git clone https://github.com/johnvexcoder/HomeLab-Agent.git
cd HomeLab-Agent
# Edit docker-compose.yml with your DASHBOARD_URL and API_KEY
docker compose up -d
```

### What the Installer Does

1. Detects your OS (Debian, Proxmox, Ubuntu, Fedora, Arch, Alpine)
2. Installs prerequisites: `git`, `curl`, `lm-sensors`, `vnstat`, `smartmontools`
3. Installs Node.js 24 if not present
4. Clones the agent to `/opt/homelab-agent`
5. Builds TypeScript (`npm ci` + `npx tsc`)
6. Creates `.env` with your dashboard URL and API key
7. Creates and starts the `homelab-agent` systemd service

### Verifying Installation

```bash
sudo systemctl status homelab-agent
sudo journalctl -u homelab-agent -f
```

The agent appears in your dashboard within **10–15 seconds** with status **online**.

---

## Setup Guide

### Step 1: Create an Agent Entry in the Dashboard

Log into your HomeLab OS dashboard at `http://DASHBOARD_IP:3000`, navigate to **Settings → Agents → New Agent**:

| Field | PVE0 Example | debian02 Example |
|-------|-------------|-----------------|
| Host ID | `pve0` | `debian02` |
| Host Name | `PVE0` | `debian02` |

**Save the API key shown on screen.** It is only displayed once. Format: `hl_...`

### Step 2: Install the Agent on Each Host

```bash
# PVE0 (Proxmox)
ssh root@PVE0_IP
sudo ./install.sh --dashboard-url http://192.168.1.31:3000/api \
  --api-key-file /secure/path/agent-api-key --allow-insecure-http

# debian02
ssh j0hn@debian02_IP
sudo ./install.sh --dashboard-url http://192.168.1.31:3000/api \
  --api-key-file /secure/path/agent-api-key --allow-insecure-http
```

### Step 3: Verify

```bash
sudo systemctl status homelab-agent
sudo journalctl -u homelab-agent -f
```

### What Each Host Reports

| Host | Plugins Active |
|------|---------------|
| **PVE0** (Proxmox) | Linux, Proxmox VE (node telemetry, ZFS, Ceph, UPS, HW inventory), Sensors, SMART, Network |
| **debian02** (Debian VM) | Linux, Docker (if installed), Sensors, SMART (if drives visible), Network |

---

## Configuration

All configuration happens via environment variables (set in `.env` or systemd environment):

| Variable | Default | Description |
|----------|---------|-------------|
| `DASHBOARD_URL` | *required* | Dashboard API URL (e.g. `https://homelab.home.arpa/api`) |
| `API_KEY` | *required* | Direct agent key; prefer `API_KEY_FILE` in production |
| `API_KEY_FILE` | empty | Root-readable secret file, re-read for every request to support rotation |
| `ALLOW_INSECURE_HTTP` | `false` | Explicitly permit plaintext HTTP to a trusted private LAN |
| `STATE_DIR` | `/var/lib/homelab-agent` | Durable pending-event queue directory |
| `POLL_INTERVAL` | `10000` | Global fallback poll interval (ms) |
| `EVENT_CHECK_INTERVAL` | `5000` | State-change check interval (ms) |
| `HOST_ID` | auto | Override host identifier |
| `HOST_NAME` | auto | Override display name |
| `DOCKER_SOCKET` | `/var/run/docker.sock` | Docker socket path |
| `LOG_LEVEL` | `info` | Log level: `debug`, `info`, `warn`, `error` |
| `MAX_EVENTS_PER_REPORT` | `50` | Max events per report batch |

---

## Security

- **API key authentication** — every request uses the `X-Agent-Key` header
- **One-way communication** — the agent only talks to the backend, never opens ports
- **No inbound connections** — the agent is purely outbound
- **Key rotation** — admins rotate keys from the dashboard; the old key stops working immediately
- **No secrets in code** — production installs read the API key from a mode `0600` secret file
- **Fail-closed transport** — non-loopback HTTP is refused unless explicitly allowed for a trusted LAN
- **Durable delivery** — pending events survive agent restarts and use idempotent IDs
- **Agent never does HTTP/auth/WebSocket** — only the Agent Core handles network communication

---

## Maintenance & Monitoring

### Local build & run

```bash
npm install
npm run build          # tsc → dist/
npm run typecheck      # run the TypeScript type checker
npm run dev            # run directly via tsx (no build step)
```

### Containerized deployment

```bash
docker compose up -d --build
docker compose logs -f homelab-agent
```

Requires the host root and Docker socket mounted (see `docker-compose.yml`). For SMART monitoring, pass through block devices (`--device /dev/sda:/dev/sda`); for Proxmox API access, run the agent on the Proxmox host directly.

### Checking active capabilities

```bash
curl -s http://localhost:4000/api/admin/agents -H "Authorization: Bearer YOUR_SESSION" | jq
```

---

## Adding a Plugin

1. Create `src/plugins/myplugin/index.ts`
2. Extend the `Plugin` base class:

```typescript
import { Plugin } from '../../core/plugin.js';
import type { PluginMeta, AgentEvent, CollectedMetrics } from '../../types/index.js';

export class MyPlugin extends Plugin {
  meta: PluginMeta = {
    id: 'linux',  // must match PluginId union in types/index.ts
    name: 'My Plugin',
    description: 'What it does',
    version: '1.0.0',
    capabilities: ['my_capability'],
    platform: 'linux',
    recommendedPollMs: 5000,
    recommendedEventMs: 10000,
  };

  async detect(): Promise<boolean> {
    // Return true if this plugin can run on this system
    return true;
  }

  async collect(): Promise<CollectedMetrics> {
    // Collect and return metrics
    return { myMetric: 42 };
  }

  async checkEvents(): Promise<AgentEvent[]> {
    // Return only NEW events (state changes since last check)
    return [];
  }
}
```

3. Register in `src/plugins/index.ts`:

```typescript
import { MyPlugin } from './myplugin/index.js';
registerPlugin(new MyPlugin());
```

4. Add your capability to the `Capability` type union in `src/types/index.ts`

That's it — the registry handles detection, scheduling, and caching automatically.

---

## Extending

### Add a new capability

1. Add the capability string to the `Capability` type in `src/types/index.ts`
2. Add it to your plugin's `meta.capabilities` array
3. The backend can now request data by this capability

### Change polling intervals

Edit `recommendedPollMs` and `recommendedEventMs` in your plugin's `meta`. The Agent Core respects per-plugin intervals — no global tick rate forces everything to run at the same speed.

### Custom event thresholds

Use `observeThresholds()` from `src/core/event-engine.ts`:

```typescript
events.push(...observeThresholds('linux', 'cpu_high', cpuPercent, '%', 80, 95));
// Emits 'warning' at 80%, 'critical' at 95%
```

---

## Requirements

- **Node.js** ≥ 24
- **Linux** (any distribution)
- **Optional:** `lm-sensors` (temperature/fans), `smartctl` (SMART health), Docker (containers)

The agent gracefully degrades — if a tool is missing, only that plugin is disabled.

---

## Author & Credits

Built with care by **[John Vex Coder](https://github.com/johnvexcoder)** ✨

[![GitHub](https://img.shields.io/static/v1?style=for-the-badge&label=GitHub&message=@johnvexcoder&color=181717&logo=github&logoColor=white)](https://github.com/johnvexcoder)
[![Ko-Fi](https://img.shields.io/static/v1?style=for-the-badge&label=Support%20me&message=Ko-Fi&color=FF5E5B&logo=kofi&logoColor=white)](https://ko-fi.com/johnvexcoder)

**Part of the [HomeLab OS](https://github.com/johnvexcoder/HomeLab-OS) ecosystem** — the self-hosted infrastructure dashboard the agent feeds.

---

## License

This project is licensed under the **GNU General Public License v3.0 (GPL-3.0-or-later)**.

You are free to use, modify, and distribute it, provided all derivative works are also distributed under the GPLv3.

See the full text in the [LICENSE](LICENSE) file, or at [gnu.org/licenses/gpl-3.0.html](https://www.gnu.org/licenses/gpl-3.0.html).

---

<div align="center">
<p>Made with ❤️ for self-hosters.</p>
</div>
