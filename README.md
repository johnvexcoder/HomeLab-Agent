<p align="center">
  <img src="https://raw.githubusercontent.com/johnvexcoder/HomeLab-OS/main/frontend/public/favicon.svg" width="72" alt="HomeLab OS icon" />
</p>

<h1 align="center">HomeLab Agent</h1>

<p align="center">
  A modular, plugin-based <b>system telemetry agent</b> for
  <a href="https://github.com/johnvexcoder/HomeLab-OS">HomeLab OS</a>.
  Collects host metrics, Docker containers, Proxmox VE node telemetry, hardware sensors,
  SMART disk health, and network data — then reports securely to the HomeLab Dashboard.
</p>

<p align="center">
  <b>v2.0.0</b> ·
  <img src="https://img.shields.io/badge/Node_20-TypeScript-34D399" alt="Node.js 20 · TypeScript" />
  <img src="https://img.shields.io/badge/Plugin_Arch-6_Plugins-34D399" alt="Plugin Architecture · 6 Plugins" />
  <img src="https://img.shields.io/badge/Linux-Proxmox-Docker-34D399" alt="Linux · Proxmox · Docker" />
</p>

---

## What It Does

HomeLab Agent runs on every host in your infrastructure and reports node-local telemetry
that the **Proxmox API does not expose** — temperatures, fan speeds, SMART health, kernel
information, local services, and more.

The agent and the Proxmox API are **not competitors**. They are two independent data
providers. The HomeLab OS backend merges data from both into a single unified model. The
frontend never knows whether information came from the Proxmox API or the agent.

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
┌──────────────────────────────────────────────────────────────────┐
│                       HomeLab Agent Core                         │
│                                                                  │
│  ┌─────────┐  ┌─────────┐  ┌──────────┐  ┌─────────┐           │
│  │ Registry │  │  Cache  │  │  Events  │  │   API   │           │
│  │ (capab.) │  │ (shared)│  │ (state)  │  │ (REST)  │           │
│  └────┬─────┘  └────┬────┘  └────┬─────┘  └────┬────┘           │
│       │              │            │              │                │
│  ┌────┴──────────────┴────────────┴──────────────┴────┐          │
│  │              Per-Plugin Poll Scheduler              │          │
│  │         (each plugin runs at its own interval)      │          │
│  └────┬──────┬──────┬──────┬──────┬──────┬────────────┘          │
│       │      │      │      │      │      │                       │
│  ┌────┴──┐┌──┴───┐┌─┴──┐┌──┴───┐┌─┴──┐┌──┴───┐                  │
│  │ Linux ││Docker││PVE ││Sensors││SMART││Network│                 │
│  └───────┘└──────┘└────┘└──────┘└────┘└──────┘                  │
└──────────────────────────────────────────────────────────────────┘
          │
          │  X-Agent-Key auth
          ▼
┌──────────────────────────┐
│  HomeLab OS Backend       │
│  (merges with Proxmox API)│
└──────────────────────────┘
```

### Plugin System

Every feature is an independent plugin. Plugins **only** collect, normalize, and publish
data. They never do HTTP, authentication, WebSocket, or network retries — those
responsibilities belong exclusively to the Agent Core.

| Plugin | Capabilities | Poll Interval |
|--------|-------------|---------------|
| **Linux** | `cpu`, `memory`, `swap`, `filesystem`, `processes`, `packages`, `services`, `system_info` | 1s |
| **Docker** | `containers`, `images`, `compose_projects` | 5s |
| **Proxmox VE** | `node_telemetry`, `node_events`, `hardware_inventory`, `zfs_health`, `ceph_health` | 10s |
| **Sensors** | `temperature`, `fan`, `voltage` | 5s |
| **SMART** | `disk_health` | 10 min |
| **Network** | `network_interfaces`, `gateway`, `dns`, `public_ip`, `latency`, `packet_loss` | 5s |

### Capability-Based Design

The backend requests data by **capability**, not by plugin. Each plugin declares which
capabilities it provides. The agent core maps capabilities to plugins and serves cached
data on demand. This decouples the agent's internal plugin structure from the backend's
data model.

### Auto-Detection

The agent automatically detects its environment at startup — **zero configuration required**:

- **OS:** Debian, Ubuntu, Fedora, Arch, Proxmox, Raspbian, Alpine, and more
- **Host type:** Bare metal, VM (KVM/QEMU/VMware/VirtualBox/Hyper-V), hypervisor (Proxmox), container (Docker/LXC/K8s)
- **Platform:** Server, laptop, Raspberry Pi
- **Services:** Docker, lm-sensors, smartctl — only active plugins run

The same binary works everywhere.

### Per-Plugin Poll Scheduling

Not everything runs every second. Each plugin defines its own polling interval:

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

No duplicated system calls. One `sensors -j` execution serves the temperature widget,
the CPU card, the alerts engine, and the dashboard overview simultaneously.

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

- Node.js ≥ 18 (installer handles this automatically)
- Linux (any distribution)
- Network access to the HomeLab OS backend (`http://<dashboard-ip>:4000/api`)

### Quick Install (recommended)

```bash
# On each host (PVE0, debian02, etc.)
curl -fsSL https://raw.githubusercontent.com/johnvexcoder/HomeLab-Agent/main/install.sh | \
  sudo bash -s -- --dashboard-url http://DASHBOARD_IP:4000/api --api-key YOUR_API_KEY
```

### Manual Install

```bash
git clone https://github.com/johnvexcoder/HomeLab-Agent.git /opt/homelab-agent
cd /opt/homelab-agent
sudo ./install.sh --dashboard-url http://DASHBOARD_IP:4000/api --api-key YOUR_API_KEY
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
3. Installs Node.js 20 if not present
4. Clones the agent to `/opt/homelab-agent`
5. Builds TypeScript (`npm ci` + `npx tsc`)
6. Creates `.env` with your dashboard URL and API key
7. Creates and starts `homelab-agent` systemd service

### Verifying Installation

```bash
# Check service status
sudo systemctl status homelab-agent

# Watch live logs
sudo journalctl -u homelab-agent -f

# Check what capabilities are active
curl -s http://localhost:4000/api/admin/agents -H "Authorization: Bearer YOUR_SESSION" | jq
```

The agent appears in your dashboard within 10–15 seconds with status **online**.

---

## Setup Guide

### Step 1: Create Agent Entry in Dashboard

Log into your HomeLab OS dashboard at `http://DASHBOARD_IP:3000`.

Navigate to **Settings → Agents → New Agent** and create an entry for each host:

| Field | PVE0 Example | debian02 Example |
|-------|-------------|-----------------|
| Host ID | `pve0` | `debian02` |
| Host Name | `PVE0` | `debian02` |

**Save the API key shown on screen.** It is only displayed once. Format: `hl_...`

### Step 2: Install Agent on Each Host

```bash
# PVE0 (Proxmox)
ssh root@PVE0_IP
curl -fsSL https://raw.githubusercontent.com/johnvexcoder/HomeLab-Agent/main/install.sh | \
  sudo bash -s -- --dashboard-url http://192.168.1.31:4000/api --api-key hl_YOUR_KEY

# debian02
ssh j0hn@debian02_IP
sudo ./install.sh --dashboard-url http://192.168.1.31:4000/api --api-key hl_YOUR_KEY
```

### Step 3: Verify

```bash
sudo systemctl status homelab-agent
sudo journalctl -u homelab-agent -f
```

On the dashboard, the agent should appear within 10–15 seconds with status **online**.

### What Each Host Reports

| Host | Plugins Active |
|------|---------------|
| **PVE0** (Proxmox) | Linux, Proxmox VE (node telemetry, ZFS, Ceph, UPS, HW inventory), Sensors, SMART, Network |
| **debian02** (Debian VM) | Linux, Docker (if installed), Sensors, SMART (if drives visible), Network |

---

## Configuration

All configuration via environment variables (set in `.env` or systemd environment):

| Variable | Default | Description |
|----------|---------|-------------|
| `DASHBOARD_URL` | *required* | Dashboard API URL (e.g. `http://192.168.1.31:4000/api`) |
| `API_KEY` | *required* | Agent API key from Dashboard → Settings → Agents |
| `POLL_INTERVAL` | `10000` | Global fallback poll interval (ms) |
| `EVENT_CHECK_INTERVAL` | `5000` | State-change check interval (ms) |
| `HOST_ID` | auto | Override host identifier |
| `HOST_NAME` | auto | Override display name |
| `DOCKER_SOCKET` | `/var/run/docker.sock` | Docker socket path |
| `LOG_LEVEL` | `info` | Log level: `debug`, `info`, `warn`, `error` |
| `MAX_EVENTS_PER_REPORT` | `50` | Max events per report batch |

---

## Project Structure

```
├── src/
│   ├── core/
│   │   ├── agent.ts              Main agent orchestrator (poll + event loops)
│   │   ├── plugin.ts             Abstract Plugin base class
│   │   ├── registry.ts           Plugin discovery, capability mapping, scheduling
│   │   ├── detection.ts          Environment auto-detection
│   │   ├── event-engine.ts       State-change tracking & threshold events
│   │   ├── config.ts             Configuration from environment variables
│   │   ├── api.ts                REST communication with backend
│   │   ├── cache.ts              Shared metric cache
│   │   └── logger.ts             Structured logging
│   ├── plugins/
│   │   ├── linux/                CPU, memory, swap, disk, processes, packages, services
│   │   ├── docker/               Containers, images, networks, volumes, compose
│   │   ├── proxmox/              Node telemetry, ZFS, Ceph, UPS, hardware inventory
│   │   ├── sensors/              Temperature, fans, voltages (lm-sensors / sysfs)
│   │   ├── smart/                Drive health, temperature, life, power-on hours
│   │   └── network/              Interfaces, gateway, DNS, public IP, latency
│   ├── types/
│   │   └── index.ts              Shared TypeScript interfaces & capabilities
│   └── index.ts                  Entry point
├── Dockerfile                    Multi-stage Node.js 20 build
├── docker-compose.yml            Container deployment
├── install.sh                    Native host installer (systemd)
├── package.json                  v2.0.0
└── tsconfig.json                 ES2022, NodeNext
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

That's it. The registry handles detection, scheduling, and caching automatically.

---

## Extending

### Add a new capability

1. Add the capability string to the `Capability` type in `src/types/index.ts`
2. Add it to your plugin's `meta.capabilities` array
3. The backend can now request data by this capability

### Change polling intervals

Edit `recommendedPollMs` and `recommendedEventMs` in your plugin's `meta`. The agent core
respects per-plugin intervals — no global tick rate forces everything to run at the same speed.

### Custom event thresholds

Use `observeThresholds()` from `src/core/event-engine.ts`:

```typescript
events.push(...observeThresholds('linux', 'cpu_high', cpuPercent, '%', 80, 95));
// Emits 'warning' at 80%, 'critical' at 95%
```

---

## Security

- **API key authentication** — every request uses `X-Agent-Key` header
- **One-way communication** — agent only talks to the backend, never opens ports
- **No inbound connections** — the agent is purely outbound
- **Key rotation** — admin can rotate keys from the dashboard; old key stops working immediately
- **No secrets in code** — API key is stored in `.env` (mode `0600`) or environment variables
- **Agent never does HTTP/auth/WebSocket** — only the Agent Core handles network communication

---

## Requirements

- **Node.js** ≥ 18
- **Linux** (any distribution)
- **Optional:** `lm-sensors` (temperature/fans), `smartctl` (SMART health), Docker (containers)

The agent gracefully degrades — if a tool is missing, only that plugin is disabled.

---

## License

MIT — do whatever you want with it.

---

<p align="center">
  <sub>v2.0.0 · HomeLab Agent</sub>
  <br /><br />
  <sub>
    Author: <a href="https://github.com/johnvexcoder">John Vex Coder</a> :octocat:
  </sub>
  &nbsp;&nbsp;
  <a href="https://ko-fi.com/johnvexcoder" target="_blank">
    <img src="https://storage.ko-fi.com/cdn/kofi6.png?v=6" alt="Support me on Ko-fi" height="28">
  </a>
  <br />
  <sub>
    Part of the <a href="https://github.com/johnvexcoder/HomeLab-OS">HomeLab OS</a> ecosystem
  </sub>
</p>
