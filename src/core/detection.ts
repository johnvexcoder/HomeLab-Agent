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

function detectVmId(): string {
  // Try QEMU guest agent command (if qemu-ga is installed)
  const qgaVmId = tryExec('qemu-ga --get-vmid 2>/dev/null');
  if (qgaVmId && /^\d+$/.test(qgaVmId)) return qgaVmId;

  // Try QEMU guest agent via virtio serial port directly
  try {
    const qgaPorts = ['/dev/virtio-ports/org.qemu.guest_agent.0', '/dev/virtio-ports/org.qemu.guest_agent.1'];
    for (const port of qgaPorts) {
      if (fs.existsSync(port)) {
        // Send QGA command to get VMID
        const cmd = `echo '{"execute":"guest-get-vmid"}' > ${port} && timeout 2 cat ${port} 2>/dev/null`;
        const result = tryExec(cmd);
        const match = result.match(/"vmid"\s*:\s*(\d+)/);
        if (match) return match[1];
      }
    }
  } catch {}

  // Try virtio serial for Proxmox VMID (config drive)
  try {
    const virtioPaths = fs.readdirSync('/sys/bus/virtio/devices').filter(d => d.startsWith('virtio'));
    for (const dev of virtioPaths) {
      const serialPath = `/sys/bus/virtio/devices/${dev}/serial`;
      const serial = tryRead(serialPath);
      if (serial && /^\d+$/.test(serial)) return serial;
    }
  } catch {}

  // Try reading from /etc/pve/.vmid (some Proxmox setups)
  const pveVmid = tryRead('/etc/pve/.vmid');
  if (pveVmid && /^\d+$/.test(pveVmid)) return pveVmid;

  // Try DMI product serial (sometimes contains VMID)
  const productSerial = tryRead('/sys/class/dmi/id/product_serial');
  if (productSerial && /^\d+$/.test(productSerial)) return productSerial;

  // Try /proc/device-tree for VMID (some hypervisors)
  try {
    const dtVmId = tryRead('/proc/device-tree/vmid') || tryRead('/proc/device-tree/vm-id');
    if (dtVmId && /^\d+$/.test(dtVmId)) return dtVmId;
  } catch {}

  // Try SMBIOS asset tag (sometimes contains VMID)
  const assetTag = tryRead('/sys/class/dmi/id/chassis_asset_tag');
  if (assetTag && /^\d+$/.test(assetTag)) return assetTag;

  return '';
}

function detectParentIp(): string {
  // For Proxmox VMs: the Proxmox host IP is often the DHCP server or gateway
  // Try to get from DHCP lease (the DHCP server IP is often the Proxmox host)
  try {
    const dhcpLeases = fs.readdirSync('/var/lib/dhcp').filter(f => f.startsWith('dhclient') && f.endsWith('.leases'));
    for (const lease of dhcpLeases) {
      const content = tryRead(`/var/lib/dhcp/${lease}`);
      // DHCP server identifier
      const match = content.match(/server identifier ([\d.]+)/);
      if (match) return match[1];
      // Fallback: gateway/routers
      const match2 = content.match(/option routers ([\d.]+)/);
      if (match2) return match2[1];
    }
  } catch {}

  // Default gateway
  const gw = tryExec("ip route show default 2>/dev/null | awk '{print $3}'");
  if (gw) return gw;

  return '';
}

function detectHostType(): HostType {
  // Container detection
  if (fs.existsSync('/.dockerenv')) return 'container';
  const cgroup = tryRead('/proc/1/cgroup');
  if (cgroup.includes('docker') || cgroup.includes('kubepods') || cgroup.includes('lxc')) return 'container';

  // systemd-detect-virt (most reliable)
  const virt = tryExec('systemd-detect-virt 2>/dev/null');
  if (virt === 'none') {
    // Could be bare metal OR Proxmox host (which reports 'none')
    // Check for Proxmox-specific paths
    if (fs.existsSync('/etc/pve') || fs.existsSync('/var/lib/pve-manager') || fs.existsSync('/usr/bin/pveversion')) {
      return 'hypervisor';
    }
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
  // Strategy 1: Node.js os.networkInterfaces()
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    if (name === 'lo' || name === 'docker0' || name.startsWith('br-') || name.startsWith('veth')) continue;
    const addrs = ifaces[name];
    if (!addrs) continue;
    for (const addr of addrs) {
      if (addr.family === 'IPv4' && !addr.internal) return addr.address;
    }
  }

  // Strategy 2: ip route get 1.1.1.1 (most reliable)
  const ipRoute = tryExec("ip route get 1.1.1.1 2>/dev/null | head -1 | awk '{for(i=1;i<=NF;i++) if($i==\"src\") print $(i+1)}'");
  if (ipRoute && /^\d+\.\d+\.\d+\.\d+$/.test(ipRoute)) return ipRoute;

  // Strategy 3: hostname -I (returns all IPs, take first)
  const hostIps = tryExec('hostname -I 2>/dev/null');
  if (hostIps) {
    const first = hostIps.split(/\s+/)[0];
    if (first && /^\d+\.\d+\.\d+\.\d+$/.test(first) && first !== '127.0.0.1') return first;
  }

  // Strategy 4: ip -4 addr (parse manually)
  const ipAddr = tryExec("ip -4 addr show scope global 2>/dev/null | grep -oP 'inet \\K[\\d.]+' | head -1");
  if (ipAddr && /^\d+\.\d+\.\d+\.\d+$/.test(ipAddr)) return ipAddr;

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
  const virtType = tryExec('systemd-detect-virt 2>/dev/null') || '';
  const platform = detectPlatform();
  const { os: osName, osId, osVersion } = getOsInfo();
  const machineId = getMachineId();
  const vmId = detectVmId();
  const parentIp = detectParentIp();

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
    virtType,
    platform,
    manufacturer,
    product,
    bios,
    uptimeSeconds: Math.floor(os.uptime()),
    vmId: vmId || undefined,
    parentIp: parentIp || undefined,
  };

  log.info('detect', `OS: ${info.os} (${info.osId})`);
  log.info('detect', `Type: ${info.hostType} | Platform: ${info.platform} | Hypervisor: ${info.hypervisor || 'none'} | Virt: ${info.virtType || 'none'}`);
  log.info('detect', `Kernel: ${info.kernel} | Arch: ${info.arch}`);
  log.info('detect', `Host: ${info.hostName} (${info.hostId})`);
  log.info('detect', `IP: ${info.ip} | MAC: ${info.mac} | VMID: ${info.vmId || 'none'} | ParentIP: ${info.parentIp || 'none'}`);

  return info;
}
