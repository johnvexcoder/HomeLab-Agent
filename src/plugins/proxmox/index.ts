import fs from 'node:fs';
import { execSync } from 'node:child_process';
import { Plugin } from '../../core/plugin.js';
import { observeState } from '../../core/event-engine.js';
import { log } from '../../core/logger.js';
import type { PluginMeta, AgentEvent, CollectedMetrics } from '../../types/index.js';

/**
 * Proxmox VE Node Telemetry Plugin
 *
 * OWNERSHIP (Agent, not Proxmox API):
 *   - Node CPU temperature, fan speeds, voltages
 *   - SMART disk health
 *   - Kernel information
 *   - Local package information
 *   - Local system services
 *   - ZFS pool health (local node)
 *   - Ceph health (local node)
 *   - Hardware inventory (DMI, BIOS, CPU model)
 *   - UPS information
 *   - Local logs
 *
 * NOT OWNED by this plugin (Proxmox API is authoritative):
 *   - VM/LXC list, configuration, runtime metrics (CPU/MEM/DISK/NET)
 *   - Cluster information
 *   - Storage configuration
 *   - Snapshots
 *   - HA groups and resources
 *   - Backup jobs and history
 *   - Replication
 *   - Task history
 *
 * The backend merges data from both sources into a unified model.
 * The frontend never knows whether data came from the Proxmox API or the agent.
 */

function tryRead(p: string): string {
  try { return fs.readFileSync(p, 'utf-8'); } catch { return ''; }
}

function tryExec(cmd: string, timeout = 10000): string {
  try { return execSync(cmd, { encoding: 'utf-8', timeout, stdio: ['pipe', 'pipe', 'pipe'] }).trim(); } catch { return ''; }
}

function round(n: number, d: number): number {
  const f = 10 ** d;
  return Math.round(n * f) / f;
}

/** Detect Proxmox VE environment. */
function isProxmox(): boolean {
  if (fs.existsSync('/etc/pve')) {
    const osRelease = tryRead('/etc/os-release');
    if (osRelease.includes('Proxmox') || osRelease.includes('pve-manager')) return true;
  }
  const pveshCheck = tryExec('which pvesh 2>/dev/null');
  if (pveshCheck.includes('pvesh')) return true;
  return false;
}

/** Read node-local temperature from sysfs / hwmon. */
function readNodeTemperatures(): Array<{ label: string; valueC: number }> {
  const temps: Array<{ label: string; valueC: number }> = [];

  // Thermal zones
  try {
    const zones = fs.readdirSync('/sys/class/thermal').filter((d) => d.startsWith('thermal_zone'));
    for (const zone of zones) {
      const type = tryRead(`/sys/class/thermal/${zone}/type`) || zone;
      const tempRaw = tryRead(`/sys/class/thermal/${zone}/temp`);
      const temp = Number(tempRaw);
      if (Number.isFinite(temp)) {
        temps.push({ label: type, valueC: round(temp / 1000, 1) });
      }
    }
  } catch {}

  // hwmon
  try {
    const hwmons = fs.readdirSync('/sys/class/hwmon');
    for (const h of hwmons) {
      const name = tryRead(`/sys/class/hwmon/${h}/name`) || h;
      for (let i = 1; i <= 20; i++) {
        const input = tryRead(`/sys/class/hwmon/${h}/temp${i}_input`);
        if (!input) continue;
        const val = Number(input);
        if (!Number.isFinite(val)) continue;
        const label = tryRead(`/sys/class/hwmon/${h}/temp${i}_label`) || `temp${i}`;
        temps.push({ label: `${name}/${label}`, valueC: round(val / 1000, 1) });
      }
    }
  } catch {}

  return temps;
}

/** Read fan speeds from sysfs. */
function readNodeFans(): Array<{ label: string; rpm: number }> {
  const fans: Array<{ label: string; rpm: number }> = [];
  try {
    const hwmons = fs.readdirSync('/sys/class/hwmon');
    for (const h of hwmons) {
      const name = tryRead(`/sys/class/hwmon/${h}/name`) || h;
      for (let i = 1; i <= 10; i++) {
        const input = tryRead(`/sys/class/hwmon/${h}/fan${i}_input`);
        if (!input) continue;
        const val = Number(input);
        if (!Number.isFinite(val)) continue;
        const label = tryRead(`/sys/class/hwmon/${h}/fan${i}_label`) || `fan${i}`;
        fans.push({ label: `${name}/${label}`, rpm: Math.round(val) });
      }
    }
  } catch {}
  return fans;
}

/** Read hardware inventory from DMI/SMBIOS. */
function readHardwareInventory(): Record<string, string> {
  const hw: Record<string, string> = {};
  const dmiPaths: Record<string, string> = {
    manufacturer: '/sys/class/dmi/id/board_vendor',
    product: '/sys/class/dmi/id/board_name',
    biosVersion: '/sys/class/dmi/id/bios_version',
    biosDate: '/sys/class/dmi/id/bios_date',
    sysVendor: '/sys/class/dmi/id/sys_vendor',
    productName: '/sys/class/dmi/id/product_name',
    serial: '/sys/class/dmi/id/product_serial',
    chassisType: '/sys/class/dmi/id/chassis_type',
    cpuModel: '/proc/cpuinfo',
  };
  for (const [key, path] of Object.entries(dmiPaths)) {
    if (key === 'cpuModel') {
      const info = tryRead(path);
      const match = info.match(/model name\s*:\s*(.+)/);
      hw[key] = match?.[1]?.trim() ?? '';
    } else {
      hw[key] = tryRead(path).trim();
    }
  }
  return hw;
}

/** Read ZFS pool health (local node only). */
function readZfsHealth(): Array<{ name: string; sizeGb: number; usedGb: number; health: string; fragPercent: number; errors: number }> {
  const pools = tryExec('zpool list -Hp 2>/dev/null');
  if (!pools) return [];
  return pools.split('\n').filter(Boolean).map((line) => {
    const parts = line.split(/\s+/);
    // Count errors
    const errOut = tryExec(`zpool status ${parts[0]} 2>/dev/null | grep -c "errors:"`);
    return {
      name: parts[0] ?? '',
      sizeGb: round(Number(parts[1]) || 0, 2),
      usedGb: round(Number(parts[2]) || 0, 2),
      health: parts[8] ?? 'UNKNOWN',
      fragPercent: Number(parts[7]) || 0,
      errors: Number(errOut) || 0,
    };
  });
}

/** Read Ceph health (local node). */
function readCephHealth(): { active: boolean; health: string; osdCount: number; pgStatus: string } {
  const status = tryExec('ceph status --format json 2>/dev/null');
  if (!status) return { active: false, health: 'unknown', osdCount: 0, pgStatus: 'unknown' };
  try {
    const parsed = JSON.parse(status);
    return {
      active: true,
      health: parsed.health?.status ?? 'unknown',
      osdCount: (parsed.osds ?? []).length,
      pgStatus: parsed.pgmap?.status ?? 'unknown',
    };
  } catch {
    return { active: false, health: 'parse_error', osdCount: 0, pgStatus: 'unknown' };
  }
}

/** Read UPS information from NUT/UPS monitoring. */
function readUpsInfo(): { connected: boolean; model: string; status: string; batteryPercent: number; loadPercent: number; runtimeSec: number } {
  // Try upsc (Network UPS Tools)
  const upscPath = tryExec('which upsc 2>/dev/null');
  if (!upscPath) return { connected: false, model: '', status: '', batteryPercent: 0, loadPercent: 0, runtimeSec: 0 };

  const deviceList = tryExec('upsc -l 2>/dev/null');
  const device = deviceList.split('\n')[0]?.trim();
  if (!device) return { connected: false, model: '', status: '', batteryPercent: 0, loadPercent: 0, runtimeSec: 0 };

  const model = tryExec(`upsc ${device} device.model 2>/dev/null`);
  const status = tryExec(`upsc ${device} ups.status 2>/dev/null`);
  const battery = Number(tryExec(`upsc ${device} battery.charge 2>/dev/null`)) || 0;
  const load = Number(tryExec(`upsc ${device} ups.load 2>/dev/null`)) || 0;
  const runtime = Number(tryExec(`upsc ${device} battery.runtime 2>/dev/null`)) || 0;

  return {
    connected: true,
    model,
    status,
    batteryPercent: battery,
    loadPercent: load,
    runtimeSec: runtime,
  };
}

export class ProxmoxPlugin extends Plugin {
  meta: PluginMeta = {
    id: 'proxmox',
    name: 'Proxmox VE',
    description: 'Proxmox VE node telemetry: temperature, fans, ZFS health, Ceph health, hardware inventory, UPS',
    version: '2.0.0',
    capabilities: ['node_telemetry', 'node_events', 'hardware_inventory', 'zfs_health', 'ceph_health'],
    platform: 'linux',
    recommendedPollMs: 10000,
    recommendedEventMs: 15000,
  };

  async detect(): Promise<boolean> {
    return isProxmox();
  }

  async collect(): Promise<CollectedMetrics> {
    const temps = readNodeTemperatures();
    const fans = readNodeFans();
    const hw = readHardwareInventory();
    const zfs = readZfsHealth();
    const ceph = readCephHealth();
    const ups = readUpsInfo();

    // Read PVE node status for basic node info (CPU, mem, uptime — NOT VMs)
    const nodeStatus = this.collectNodeStatus();

    return {
      node: nodeStatus,
      temperatures: temps,
      cpuTempC: temps.find((t) => t.label.toLowerCase().includes('core') || t.label.toLowerCase().includes('cpu'))?.valueC
        ?? temps[0]?.valueC
        ?? null,
      fans,
      hardware: hw,
      zfs,
      ceph,
      ups,
    };
  }

  async checkEvents(): Promise<AgentEvent[]> {
    const events: AgentEvent[] = [];

    // Temperature threshold events
    const temps = readNodeTemperatures();
    const cpuTemp = temps.find((t) => t.label.toLowerCase().includes('core'))?.valueC ?? temps[0]?.valueC;
    if (cpuTemp != null) {
      const evt = observeState('proxmox', 'node_cpu_temp',
        cpuTemp > 80 ? 'critical' : cpuTemp > 70 ? 'warning' : 'normal',
        cpuTemp > 80 ? 'critical' : cpuTemp > 70 ? 'warning' : 'info',
        `Node CPU temperature: ${cpuTemp}°C`);
      if (evt) events.push(evt);
    }

    // Fan failure events
    const fans = readNodeFans();
    for (const fan of fans) {
      if (fan.rpm === 0) {
        const evt = observeState('proxmox', `fan:${fan.label}`, 'stopped', 'critical',
          `Fan ${fan.label} stopped (0 RPM)`);
        if (evt) events.push(evt);
      }
    }

    // ZFS health events
    const zfs = readZfsHealth();
    for (const pool of zfs) {
      if (pool.health !== 'ONLINE') {
        const evt = observeState('proxmox', `zfs:${pool.name}`, pool.health, 'critical',
          `ZFS pool ${pool.name} health: ${pool.health}`);
        if (evt) events.push(evt);
      }
      if (pool.errors > 0) {
        const evt = observeState('proxmox', `zfs_errors:${pool.name}`, 'errors', 'critical',
          `ZFS pool ${pool.name} has ${pool.errors} error(s)`);
        if (evt) events.push(evt);
      }
    }

    // Ceph health events
    const ceph = readCephHealth();
    if (ceph.active && ceph.health !== 'HEALTH_OK') {
      const evt = observeState('proxmox', 'ceph_health', ceph.health,
        ceph.health === 'HEALTH_WARN' ? 'warning' : 'critical',
        `Ceph health: ${ceph.health}`);
      if (evt) events.push(evt);
    }

    // UPS events
    const ups = readUpsInfo();
    if (ups.connected) {
      if (ups.batteryPercent < 30) {
        const evt = observeState('proxmox', 'ups_battery', 'low', 'critical',
          `UPS battery low: ${ups.batteryPercent}%`);
        if (evt) events.push(evt);
      }
      if (ups.status !== 'OL') {
        const evt = observeState('proxmox', 'ups_status', ups.status, 'warning',
          `UPS status: ${ups.status}`);
        if (evt) events.push(evt);
      }
    }

    return events;
  }

  /**
   * Read basic PVE node status (CPU, memory, uptime).
   * This is node-local telemetry — NOT VM/LXC inventory.
   */
  private collectNodeStatus(): Record<string, unknown> {
    try {
      const node = tryExec('/usr/sbin/pvesh get /nodes/$(hostname) --noheader --output-format json 2>/dev/null');
      const parsed = node ? JSON.parse(node) : null;
      const data = parsed?.data ?? parsed;
      if (!data) return {};

      const cpuinfo = tryExec('/usr/sbin/pvesh get /nodes/$(hostname)/cpuinfo --output-format json 2>/dev/null');
      const cpuinfoParsed = cpuinfo ? JSON.parse(cpuinfo) : null;
      const cpuData = cpuinfoParsed?.data ?? cpuinfoParsed;

      return {
        name: tryExec('hostname'),
        status: data.status ?? 'unknown',
        cpuPercent: data.cpu ?? 0,
        cpuCores: cpuData?.cores ?? 0,
        cpuSockets: cpuData?.sockets ?? 0,
        cpuModel: cpuData?.model ?? '',
        memTotalGb: data.maxmem ? round(data.maxmem / 1e9, 2) : 0,
        memUsedGb: data.mem ? round(data.mem / 1e9, 2) : 0,
        swapTotalGb: data.maxswap ? round(data.maxswap / 1e9, 2) : 0,
        swapUsedGb: data.swap ? round(data.swap / 1e9, 2) : 0,
        diskTotalGb: data.maxdisk ? round(data.maxdisk / 1e9, 2) : 0,
        diskUsedGb: data.disk ? round(data.disk / 1e9, 2) : 0,
        uptime: data.uptime ?? 0,
        loadavg: data.loadavg ?? [0, 0, 0],
        kversion: data.kversion ?? '',
        pveversion: data.pveversion ?? '',
      };
    } catch {
      return {};
    }
  }
}
