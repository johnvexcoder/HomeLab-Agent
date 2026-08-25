import { hostPath } from "../../core/host.js";
import os from 'node:os';
import fs from 'node:fs';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
const execAsync = promisify(exec);
import { Plugin } from '../../core/plugin.js';
import { observeState } from '../../core/event-engine.js';
import { log } from '../../core/logger.js';
import type { PluginMeta, AgentEvent, CollectedMetrics } from '../../types/index.js';

async function tryExec(cmd: string, timeout = 5000): Promise<string> {
  try {
    const { stdout } = await execAsync(cmd, { encoding: 'utf-8', timeout });
    return stdout.trim();
  } catch (err: any) {
    log.warn('network', `tryExec failed for "${cmd}": ${err.message}`);
    return '';
  }
}

function tryRead(p: string): string {
  try { return fs.readFileSync(hostPath(p), 'utf-8').trim(); } catch (err: any) {
    if (err.code !== 'ENOENT') log.warn('network', `tryRead failed for ${p}: ${err.message}`);
    return '';
  }
}

function round(n: number, d: number): number {
  const f = 10 ** d;
  return Math.round(n * f) / f;
}

let prevRx = 0;
let prevTx = 0;
let prevTs = Date.now();
let cachedPublicIp = '';
let lastPublicIpFetch = 0;

const ifacePrev = new Map<string, { rx: number; tx: number; ts: number }>();

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
    const gateway = await this.getDefaultGateway();
    const dns = this.getDnsServers();
    const publicIp = await this.getPublicIp();
    const latency = await this.measureLatency();
    const packetLoss = await this.measurePacketLoss();

    return {
      interfaces,
      gateway,
      dns,
      publicIp,
      latency,
      packetLoss,
      defaultInterface: await this.getDefaultInterface(),
    };
  }

  async checkEvents(): Promise<AgentEvent[]> {
    const events: AgentEvent[] = [];

    // Gateway reachability
    const gw = await this.getDefaultGateway();
    const gwReachable = await this.isGatewayReachable(gw);
    const gwState = gwReachable ? 'reachable' : 'unreachable';
    const gwEvt = observeState('network', 'gateway', gwState,
      gwReachable ? 'info' : 'critical',
      `Gateway ${gw} is ${gwState}`);
    if (gwEvt) events.push(gwEvt);

    // DNS resolution
    const dnsWorks = await this.testDns();
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
      
      const prev = ifacePrev.get(name);
      let downMbps = 0;
      let upMbps = 0;
      
      if (prev) {
        const elapsed = Math.max((now - prev.ts) / 1000, 0.5);
        downMbps = round(((counters.rxBytes - prev.rx) * 8 / elapsed) / 1e6, 1);
        upMbps = round(((counters.txBytes - prev.tx) * 8 / elapsed) / 1e6, 1);
      }
      
      ifacePrev.set(name, { rx: counters.rxBytes, tx: counters.txBytes, ts: now });

      ifaces.push({ name, ip, mac, speed, duplex, state, mtu, downMbps: Math.max(0, downMbps), upMbps: Math.max(0, upMbps) });
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

  private async getDefaultGateway(): Promise<string> {
    const route = await tryExec("ip route show default 2>/dev/null | head -1 | awk '{print $3}'");
    return route || await tryExec("route -n 2>/dev/null | grep 'UG' | awk '{print $2}'");
  }

  private async getDefaultInterface(): Promise<string> {
    return await tryExec("ip route show default 2>/dev/null | head -1 | awk '{print $5}'");
  }

  private async isGatewayReachable(gw: string): Promise<boolean> {
    if (!gw) return false;
    const ping = await tryExec(`ping -c 1 -W 2 ${gw} 2>/dev/null`);
    return ping.includes('1 received') || ping.includes('1 packets received');
  }

  private getDnsServers(): string[] {
    const resolv = tryRead('/etc/resolv.conf');
    return resolv.split('\n')
      .filter((l) => l.startsWith('nameserver'))
      .map((l) => l.split(/\s+/)[1])
      .filter(Boolean);
  }

  private async getPublicIp(): Promise<string> {
    const now = Date.now();
    if (cachedPublicIp && (now - lastPublicIpFetch < 15 * 60 * 1000)) {
      return cachedPublicIp;
    }
    // Try multiple services
    for (const url of ['https://api.ipify.org', 'https://ifconfig.me/ip', 'https://icanhazip.com']) {
      const ip = await tryExec(`curl -s --max-time 5 ${url} 2>/dev/null`);
      if (/^\d+\.\d+\.\d+\.\d+$/.test(ip)) {
        cachedPublicIp = ip;
        lastPublicIpFetch = now;
        return ip;
      }
    }
    return cachedPublicIp;
  }

  private async measureLatency(): Promise<number> {
    const gw = await this.getDefaultGateway();
    if (!gw) return -1;
    const output = await tryExec(`ping -c 3 -W 2 ${gw} 2>/dev/null`);
    // Parse standard rtt or round-trip formats. Average is the second group.
    const match = output.match(/(?:rtt|round-trip) min\/avg\/max.*?=\s*[\d.]+\/([\d.]+)\//);
    return match ? round(Number(match[1]), 1) : -1;
  }

  private async measurePacketLoss(): Promise<number> {
    const gw = await this.getDefaultGateway();
    if (!gw) return 100;
    const output = await tryExec(`ping -c 10 -W 2 ${gw} 2>/dev/null`);
    const match = output.match(/(\d+)% packet loss/);
    return match ? Number(match[1]) : 100;
  }

  private async testDns(): Promise<boolean> {
    const servers = this.getDnsServers();
    if (servers.length === 0) return false;
    const nslookup = await tryExec(`nslookup google.com ${servers[0]} 2>/dev/null`);
    return nslookup.includes('Address:') && !nslookup.includes('SERVFAIL');
  }
}
