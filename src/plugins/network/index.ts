import os from 'node:os';
import fs from 'node:fs';
import { execSync } from 'node:child_process';
import { Plugin } from '../../core/plugin.js';
import { observeState } from '../../core/event-engine.js';
import { log } from '../../core/logger.js';
import type { PluginMeta, AgentEvent, CollectedMetrics } from '../../types/index.js';

function tryExec(cmd: string, timeout = 5000): string {
  try { return execSync(cmd, { encoding: 'utf-8', timeout, stdio: ['pipe', 'pipe', 'pipe'] }).trim(); } catch { return ''; }
}

function tryRead(p: string): string {
  try { return fs.readFileSync(p, 'utf-8').trim(); } catch { return ''; }
}

function round(n: number, d: number): number {
  const f = 10 ** d;
  return Math.round(n * f) / f;
}

let prevRx = 0;
let prevTx = 0;
let prevTs = Date.now();

interface NetworkInterface {
  name: string;
  ip: string;
  mac: string;
  speed: number;
  duplex: string;
  state: string;
  mtu: number;
  downMbps: number;
  upMbps: number;
}

export class NetworkPlugin extends Plugin {
  meta: PluginMeta = {
    id: 'network',
    name: 'Network',
    description: 'Network interfaces, gateway, DNS, public IP, latency, packet loss, throughput',
    version: '1.0.0',
    capabilities: ['network_interfaces', 'gateway', 'dns', 'public_ip', 'latency', 'packet_loss'],
    platform: 'linux',
    recommendedPollMs: 5000,
    recommendedEventMs: 10000,
  };

  private lastGatewayState = 'reachable';

  async detect(): Promise<boolean> {
    return process.platform === 'linux';
  }

  async collect(): Promise<CollectedMetrics> {
    const interfaces = this.collectInterfaces();
    const gateway = this.getDefaultGateway();
    const dns = this.getDnsServers();
    const publicIp = this.getPublicIp();
    const latency = await this.measureLatency();
    const packetLoss = await this.measurePacketLoss();

    return {
      interfaces,
      gateway,
      dns,
      publicIp,
      latency,
      packetLoss,
      defaultInterface: this.getDefaultInterface(),
    };
  }

  async checkEvents(): Promise<AgentEvent[]> {
    const events: AgentEvent[] = [];

    // Gateway reachability
    const gw = this.getDefaultGateway();
    const gwReachable = this.isGatewayReachable(gw);
    const gwState = gwReachable ? 'reachable' : 'unreachable';
    const gwEvt = observeState('network', 'gateway', gwState,
      gwReachable ? 'info' : 'critical',
      `Gateway ${gw} is ${gwState}`);
    if (gwEvt) events.push(gwEvt);

    // DNS resolution
    const dnsWorks = this.testDns();
    const dnsEvt = observeState('network', 'dns', dnsWorks ? 'ok' : 'failed',
      dnsWorks ? 'info' : 'critical',
      `DNS resolution ${dnsWorks ? 'working' : 'failed'}`);
    if (dnsEvt) events.push(dnsEvt);

    return events;
  }

  private collectInterfaces(): NetworkInterface[] {
    const ifaces: NetworkInterface[] = [];
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

      const speed = Number(tryRead(`/sys/class/net/${name}/speed`)) || 0;
      const duplex = tryRead(`/sys/class/net/${name}/duplex`) || 'unknown';
      const state = tryRead(`/sys/class/net/${name}/operstate`) || 'unknown';
      const mtu = Number(tryRead(`/sys/class/net/${name}/mtu`)) || 0;

      // Calculate throughput
      const counters = this.readIfaceCounters(name);
      const now = Date.now();
      const elapsed = Math.max((now - prevTs) / 1000, 0.5);
      const downMbps = prevRx > 0 ? round(((counters.rxBytes - prevRx) * 8 / elapsed) / 1e6, 1) : 0;
      const upMbps = prevTx > 0 ? round(((counters.txBytes - prevTx) * 8 / elapsed) / 1e6, 1) : 0;

      ifaces.push({ name, ip, mac, speed, duplex, state, mtu, downMbps, upMbps });
    }

    // Update global counters
    let totalRx = 0;
    let totalTx = 0;
    const lines = tryRead('/proc/net/dev').split('\n');
    for (const line of lines) {
      if (!line.includes(':')) continue;
      const [iface, rest] = line.split(':');
      const n = iface.trim();
      if (n === 'lo' || n.startsWith('veth') || n === 'docker0') continue;
      const nums = rest.trim().split(/\s+/).map(Number);
      totalRx += nums[0] ?? 0;
      totalTx += nums[8] ?? 0;
    }
    prevRx = totalRx;
    prevTx = totalTx;
    prevTs = Date.now();

    return ifaces;
  }

  private readIfaceCounters(name: string): { rxBytes: number; txBytes: number } {
    const rxBytes = Number(tryRead(`/sys/class/net/${name}/statistics/rx_bytes`)) || 0;
    const txBytes = Number(tryRead(`/sys/class/net/${name}/statistics/tx_bytes`)) || 0;
    return { rxBytes, txBytes };
  }

  private getDefaultGateway(): string {
    const route = tryExec("ip route show default 2>/dev/null | head -1 | awk '{print $3}'");
    return route || tryExec("route -n 2>/dev/null | grep 'UG' | awk '{print $2}'");
  }

  private getDefaultInterface(): string {
    return tryExec("ip route show default 2>/dev/null | head -1 | awk '{print $5}'");
  }

  private isGatewayReachable(gw: string): boolean {
    if (!gw) return false;
    const ping = tryExec(`ping -c 1 -W 2 ${gw} 2>/dev/null`);
    return ping.includes('1 received') || ping.includes('1 packets received');
  }

  private getDnsServers(): string[] {
    const resolv = tryRead('/etc/resolv.conf');
    return resolv.split('\n')
      .filter((l) => l.startsWith('nameserver'))
      .map((l) => l.split(/\s+/)[1])
      .filter(Boolean);
  }

  private getPublicIp(): string {
    // Try multiple services
    for (const url of ['https://api.ipify.org', 'https://ifconfig.me/ip', 'https://icanhazip.com']) {
      const ip = tryExec(`curl -s --max-time 5 ${url} 2>/dev/null`);
      if (/^\d+\.\d+\.\d+\.\d+$/.test(ip)) return ip;
    }
    return '';
  }

  private async measureLatency(): Promise<number> {
    const gw = this.getDefaultGateway();
    if (!gw) return -1;
    const output = tryExec(`ping -c 3 -W 2 ${gw} 2>/dev/null`);
    const match = output.match(/avg\s*[=:]\s*([\d.]+)/);
    return match ? round(Number(match[1]), 1) : -1;
  }

  private async measurePacketLoss(): Promise<number> {
    const gw = this.getDefaultGateway();
    if (!gw) return 100;
    const output = tryExec(`ping -c 10 -W 2 ${gw} 2>/dev/null`);
    const match = output.match(/(\d+)% packet loss/);
    return match ? Number(match[1]) : 100;
  }

  private testDns(): boolean {
    const servers = this.getDnsServers();
    if (servers.length === 0) return false;
    const nslookup = tryExec(`nslookup google.com ${servers[0]} 2>/dev/null`);
    return nslookup.includes('Address:') && !nslookup.includes('SERVFAIL');
  }
}
