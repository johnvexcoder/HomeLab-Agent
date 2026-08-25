import { hostPath } from "../../core/host.js";
import os from 'node:os';
import fs from 'node:fs';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
const execAsync = promisify(exec);
import { Plugin } from '../../core/plugin.js';
import { observeThresholds } from '../../core/event-engine.js';
import { log } from '../../core/logger.js';
import type { PluginMeta, AgentEvent, CollectedMetrics } from '../../types/index.js';

// ── CPU tracking state ──
let prevIdle = 0;
let prevTotal = 0;
let prevNetRx = 0;
let prevNetTx = 0;
let prevNetTs = Date.now();

function tryRead(p: string): string {
  try { return fs.readFileSync(hostPath(p), 'utf-8'); } catch (err: any) {
    if (err.code !== 'ENOENT') log.warn('linux', `tryRead failed for ${p}: ${err.message}`);
    return '';
  }
}

async function tryExec(cmd: string, timeout = 5000): Promise<string> {
  try {
    const { stdout } = await execAsync(cmd, { encoding: 'utf-8', timeout });
    return stdout.trim();
  } catch (err: any) {
    log.warn('plugin', `tryExec failed for "${cmd}": ${err.message}`);
    return '';
  }
}

function round(n: number, d: number): number {
  const f = 10 ** d;
  return Math.round(n * f) / f;
}

function readCpuUsage(): number {
  const line = tryRead('/proc/stat').split('\n')[0];
  if (!line) return 0;
  const parts = line.split(/\s+/).slice(1).map(Number);
  const idle = parts[3] ?? 0;
  const total = parts.reduce((a, b) => a + b, 0);
  const idleDelta = idle - prevIdle;
  const totalDelta = total - prevTotal;
  prevIdle = idle;
  prevTotal = total;
  if (totalDelta === 0) return 0;
  return ((totalDelta - idleDelta) / totalDelta) * 100;
}

function readPerCoreCpu(): number[] {
  const lines = tryRead('/proc/stat').split('\n');
  const cores: number[] = [];
  for (const line of lines) {
    if (!line.startsWith('cpu')) continue;
    const match = line.match(/^cpu(\d+)/);
    if (!match) continue;
    const parts = line.split(/\s+/).slice(1).map(Number);
    // Just return the raw ticks, we compute usage on next call
    cores.push(parts.reduce((a, b) => a + b, 0));
  }
  return cores;
}

function readSwap(): { totalGb: number; usedGb: number; percent: number } {
  const meminfo = tryRead('/proc/meminfo');
  const get = (key: string): number => {
    const m = meminfo.match(new RegExp(`${key}:\\s+(\\d+)`));
    return m ? Number(m[1]) * 1024 : 0; // kB → bytes
  };
  const total = get('SwapTotal');
  const free = get('SwapFree');
  const used = total - free;
  return {
    totalGb: round(total / 1e9, 2),
    usedGb: round(used / 1e9, 2),
    percent: total > 0 ? round((used / total) * 100, 1) : 0,
  };
}

function readMemory(): { totalGb: number; usedGb: number; freeGb: number; availableGb: number; percent: number } {
  const meminfo = tryRead('/proc/meminfo');
  const get = (key: string): number => {
    const m = meminfo.match(new RegExp(`${key}:\\s+(\\d+)`));
    // kB → bytes
    return m ? Number(m[1]) * 1024 : 0;
  };

  const total = get('MemTotal');
  const available = get('MemAvailable');
  const free = get('MemFree');
  const used = total - available; // Use available for used calculation, as per best practice

  return {
    totalGb: round(total / 1e9, 2),
    usedGb: round(used / 1e9, 2),
    freeGb: round(free / 1e9, 2),
    availableGb: round(available / 1e9, 2),
    percent: total > 0 ? round((used / total) * 100, 1) : 0,
  };
}

function readDiskUsage(mountPoint: string): { device: string; totalGb: number; usedGb: number; percent: number } {
  try {
    const stat = fs.statfsSync(mountPoint);
    const total = stat.blocks * stat.bsize;
    const free = stat.bavail * stat.bsize;
    const used = total - free;
    // Find device from /proc/mounts
    let device = '';
    const mounts = tryRead('/proc/mounts');
    for (const line of mounts.split('\n')) {
      const parts = line.split(/\s+/);
      if (parts[1] === mountPoint) { device = parts[0]; break; }
    }
    return {
      device,
      totalGb: round(total / 1e9, 2),
      usedGb: round(used / 1e9, 2),
      percent: total > 0 ? round((used / total) * 100, 1) : 0,
    };
  } catch {
    return { device: '', totalGb: 0, usedGb: 0, percent: 0 };
  }
}

function readNetworkCounters(): { rxBytes: number; txBytes: number } {
  let totalRx = 0;
  let totalTx = 0;
  const lines = tryRead('/proc/net/dev').split('\n');
  for (const line of lines) {
    if (!line.includes(':')) continue;
    const [iface, rest] = line.split(':');
    const name = iface.trim();
    if (name === 'lo' || name.startsWith('veth') || name.startsWith('br-') || name === 'docker0') continue;
    const nums = rest.trim().split(/\s+/).map(Number);
    totalRx += nums[0] ?? 0;
    totalTx += nums[8] ?? 0;
  }
  return { rxBytes: totalRx, txBytes: totalTx };
}

function readNetworkInterfaces(): Array<{ name: string; ip: string; mac: string; speed: number }> {
  const ifaces: Array<{ name: string; ip: string; mac: string; speed: number }> = [];
  const netIfaces = os.networkInterfaces();
  for (const [name, addrs] of Object.entries(netIfaces)) {
    if (name === 'lo' || name.startsWith('veth') || name === 'docker0') continue;
    if (!addrs) continue;
    let ip = '';
    let mac = '';
    for (const a of addrs) {
      if (a.family === 'IPv4' && !a.internal) ip = a.address;
      if (a.mac && a.mac !== '00:00:00:00:00:00') mac = a.mac;
    }
    let speed = 0;
    try {
      const raw = tryRead(`/sys/class/net/${name}/speed`);
      speed = Number(raw) || 0;
    } catch {}
    ifaces.push({ name, ip, mac, speed });
  }
  return ifaces;
}

function readFilesystems(): Array<{ mount: string; device: string; totalGb: number; usedGb: number; percent: number }> {
  const fsList: Array<{ mount: string; device: string; totalGb: number; usedGb: number; percent: number }> = [];
  const seen = new Set<string>();
  const mounts = tryRead('/proc/mounts');
  for (const line of mounts.split('\n')) {
    const parts = line.split(/\s+/);
    const dev = parts[0];
    const mount = parts[1];
    const fstype = parts[2];
    if (!['ext4', 'xfs', 'btrfs', 'zfs', 'tmpfs', 'vfat', 'ntfs', 'fuseblk'].includes(fstype)) continue;
    if (seen.has(mount)) continue;
    seen.add(mount);
    const info = readDiskUsage(mount);
    if (info.totalGb > 0) {
      fsList.push({ mount, device: dev || info.device, totalGb: info.totalGb, usedGb: info.usedGb, percent: info.percent });
    }
  }
  return fsList;
}

function getProcessCount(): number {
  try {
    return fs.readdirSync(hostPath('/proc')).filter((d) => /^\d+$/.test(d)).length;
  } catch {
    return 0;
  }
}

async function getLoggedInUsers(): Promise<number> {
  const output = await tryExec('who 2>/dev/null');
  return output ? output.split('\n').filter(Boolean).length : 0;
}

async function getPackageCount(): Promise<number> {
  // Try dpkg (Debian/Ubuntu)
  let out = await tryExec('dpkg -l 2>/dev/null | grep -c "^ii"');
  if (out && Number(out) > 0) return Number(out);
  // Try rpm (Fedora/RHEL)
  out = await tryExec('rpm -qa 2>/dev/null | wc -l');
  if (out && Number(out) > 0) return Number(out);
  // Try pacman (Arch)
  out = await tryExec('pacman -Q 2>/dev/null | wc -l');
  if (out && Number(out) > 0) return Number(out);
  return 0;
}

async function getRunningServices(): Promise<string[]> {
  const out = await tryExec('systemctl list-units --type=service --state=running --no-legend --no-pager 2>/dev/null');
  if (!out) return [];
  return out.split('\n').filter(Boolean).map((l) => l.split(/\s+/)[0]).slice(0, 50);
}

export class LinuxPlugin extends Plugin {
  meta: PluginMeta = {
    id: 'linux',
    name: 'Linux',
    description: 'Core Linux system metrics: CPU, memory, swap, disk, filesystems, processes, packages, services',
    version: '1.0.0',
    capabilities: ['cpu', 'memory', 'swap', 'filesystem', 'processes', 'packages', 'services', 'system_info'],
    platform: 'linux',
    recommendedPollMs: 1000,
    recommendedEventMs: 5000,
  };

  async detect(): Promise<boolean> {
    // Always available on Linux
    return process.platform === 'linux';
  }

  async collect(): Promise<CollectedMetrics> {
    const cpus = os.cpus();
    const cpuPercent = round(readCpuUsage(), 1);
    const memory = readMemory();
    const swap = readSwap();
    const net = readNetworkCounters();
    const now = Date.now();
    const elapsedSec = Math.max((now - prevNetTs) / 1000, 0.5);
    const downBps = prevNetRx > 0 ? (net.rxBytes - prevNetRx) / elapsedSec : 0;
    const upBps = prevNetTx > 0 ? (net.txBytes - prevNetTx) / elapsedSec : 0;
    prevNetRx = net.rxBytes;
    prevNetTx = net.txBytes;
    prevNetTs = now;

    const load = os.loadavg();

    return {
      cpu: {
        usagePercent: cpuPercent,
        cores: cpus.length,
        model: cpus[0]?.model ?? 'unknown',
        speedMhz: cpus[0]?.speed ?? 0,
      },
      memory,
      swap,
      load: {
        avg1: round(load[0], 2),
        avg5: round(load[1], 2),
        avg15: round(load[2], 2),
      },
      disk: {
        root: readDiskUsage('/'),
        filesystems: readFilesystems(),
      },
      network: {
        downMbps: round((downBps * 8) / 1e6, 1),
        upMbps: round((upBps * 8) / 1e6, 1),
        rxBytes: net.rxBytes,
        txBytes: net.txBytes,
        interfaces: readNetworkInterfaces(),
      },
      uptime: Math.floor(os.uptime()),
      processes: {
        total: getProcessCount(),
        users: await getLoggedInUsers(),
      },
      packages: {
        count: await getPackageCount(),
      },
      services: {
        running: await getRunningServices(),
      },
      system: {
        hostname: os.hostname(),
        arch: os.arch(),
        kernel: os.release(),
      },
    };
  }

  async checkEvents(): Promise<AgentEvent[]> {
    const events: AgentEvent[] = [];
    const metrics = await this.collect();
    const cpu = metrics.cpu as { usagePercent: number };
    const mem = metrics.memory as { percent: number };
    const swap = metrics.swap as { percent: number };

    events.push(...observeThresholds('linux', 'cpu_high', cpu.usagePercent, '%', 80, 95));
    events.push(...observeThresholds('linux', 'memory_high', mem.percent, '%', 85, 95));
    events.push(...observeThresholds('linux', 'swap_high', swap.percent, '%', 50, 80));

    return events;
  }
}
