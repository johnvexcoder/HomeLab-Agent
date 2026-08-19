import fs from 'node:fs';
import os from 'node:os';
import { execSync } from 'node:child_process';
import crypto from 'node:crypto';
import type { HostInfo, HostType } from '../types/index.js';
import { log } from './logger.js';

function tryRead(path: string): string {
  try { return fs.readFileSync(path, 'utf-8').trim(); } catch { return ''; }
}

function tryExec(cmd: string, timeout = 5000): string {
  try { return execSync(cmd, { encoding: 'utf-8', timeout, stdio: ['pipe', 'pipe', 'pipe'] }).trim(); } catch { return ''; }
}

function detectHostType(): HostType {
  // Container detection
  if (fs.existsSync('/.dockerenv')) return 'container';
  const cgroup = tryRead('/proc/1/cgroup');
  if (cgroup.includes('docker') || cgroup.includes('kubepods') || cgroup.includes('lxc')) return 'container';

  // systemd-detect-virt (most reliable)
  const virt = tryExec('systemd-detect-virt 2>/dev/null');
  if (virt === 'none') {
    // Could be bare metal OR Proxmox (which reports 'none')
    if (fs.existsSync('/etc/pve')) return 'hypervisor';
    return 'bare-metal';
  }
  if (virt === 'proxmox') return 'hypervisor';
  if (['kvm', 'qemu', 'oracle', 'vmware', 'hyperv', 'virtualbox', 'xen'].includes(virt)) return 'vm';
  if (['lxc', 'lxc-libvirt', 'openvz'].includes(virt)) return 'container';

  // DMI fallback
  const product = tryRead('/sys/class/dmi/id/product_name').toLowerCase();
  if (product.includes('proxmox') || product.includes('ve')) return 'hypervisor';
  if (['kvm', 'qemu', 'vmware', 'virtualbox', 'hyper-v', 'openstack'].some(v => product.includes(v))) return 'vm';

  return 'bare-metal';
}

function detectHypervisor(): string {
  const virt = tryExec('systemd-detect-virt 2>/dev/null');
  if (virt && virt !== 'none') return virt;
  if (fs.existsSync('/etc/pve')) return 'proxmox';
  const product = tryRead('/sys/class/dmi/id/product_name').toLowerCase();
  if (product.includes('proxmox')) return 'proxmox';
  if (product.includes('vmware')) return 'vmware';
  if (product.includes('kvm') || product.includes('qemu')) return 'kvm';
  return '';
}

function detectPlatform(): string {
  if (fs.existsSync('/sys/firmware/devicetree/base/model')) {
    const model = tryRead('/sys/firmware/devicetree/base/model');
    if (model.toLowerCase().includes('raspberry')) return 'raspberry-pi';
  }
  const product = tryRead('/sys/class/dmi/id/product_name').toLowerCase();
  if (product.includes('laptop') || product.includes('notebook')) return 'laptop';
  if (product.includes('virtualbox')) return 'virtualbox';
  return 'server';
}

function getMacAddress(): string {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    if (name === 'lo' || name === 'docker0' || name.startsWith('br-') || name.startsWith('veth')) continue;
    const addrs = ifaces[name];
    if (!addrs) continue;
    for (const addr of addrs) {
      if (!addr.internal && addr.mac && addr.mac !== '00:00:00:00:00:00') return addr.mac;
    }
  }
  return '';
}

function getLocalIp(): string {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    if (name === 'lo' || name === 'docker0' || name.startsWith('br-') || name.startsWith('veth')) continue;
    const addrs = ifaces[name];
    if (!addrs) continue;
    for (const addr of addrs) {
      if (addr.family === 'IPv4' && !addr.internal) return addr.address;
    }
  }
  return '127.0.0.1';
}

function getMachineId(): string {
  // Prefer /etc/machine-id (systemd), fall back to /var/lib/dbus/machine-id
  let id = tryRead('/etc/machine-id');
  if (!id) id = tryRead('/var/lib/dbus/machine-id');
  if (!id) {
    // Generate a persistent ID based on hostname + MAC
    const hostname = os.hostname();
    const mac = getMacAddress();
    id = crypto.createHash('sha256').update(`${hostname}:${mac}`).digest('hex').slice(0, 32);
  }
  return id;
}

function getOsInfo(): { os: string; osId: string; osVersion: string } {
  const release = tryRead('/etc/os-release');
  const lines = Object.fromEntries(
    release.split('\n').filter(Boolean).map((l) => {
      const eq = l.indexOf('=');
      return [l.slice(0, eq), l.slice(eq + 1).replace(/^["']|["']$/g, '')];
    }),
  );
  return {
    os: `${lines.NAME || os.type()} ${lines.VERSION_ID || os.release()}`,
    osId: (lines.ID || '').toLowerCase(),
    osVersion: lines.VERSION_ID || os.release(),
  };
}

export async function detectHost(hostId: string, hostName: string): Promise<HostInfo> {
  log.info('detect', 'Starting environment detection...');

  const hostType = detectHostType();
  const hypervisor = detectHypervisor();
  const platform = detectPlatform();
  const { os: osName, osId, osVersion } = getOsInfo();
  const machineId = getMachineId();

  // DMI data
  const manufacturer = tryRead('/sys/class/dmi/id/board_vendor') || tryRead('/sys/class/dmi/id/sys_vendor');
  const product = tryRead('/sys/class/dmi/id/board_name') || tryRead('/sys/class/dmi/id/product_name');
  const bios = tryRead('/sys/class/dmi/id/bios_version');

  const info: HostInfo = {
    hostId: hostId || `agent-${machineId.slice(0, 12)}`,
    hostName: hostName || os.hostname(),
    hostname: os.hostname(),
    machineId,
    ip: getLocalIp(),
    mac: getMacAddress(),
    os: osName,
    osId,
    osVersion,
    kernel: os.release(),
    arch: os.arch(),
    hostType,
    hypervisor,
    platform,
    manufacturer,
    product,
    bios,
    uptimeSeconds: Math.floor(os.uptime()),
  };

  log.info('detect', `OS: ${info.os} (${info.osId})`);
  log.info('detect', `Type: ${info.hostType} | Platform: ${info.platform} | Hypervisor: ${info.hypervisor || 'none'}`);
  log.info('detect', `Kernel: ${info.kernel} | Arch: ${info.arch}`);
  log.info('detect', `Host: ${info.hostName} (${info.hostId})`);
  log.info('detect', `IP: ${info.ip} | MAC: ${info.mac}`);

  return info;
}
