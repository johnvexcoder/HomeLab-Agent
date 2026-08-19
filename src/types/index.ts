/**
 * Capability-based type system.
 *
 * Each plugin publishes capabilities. The backend requests data by
 * capability, never by plugin. This decouples the agent's internal
 * plugin structure from the backend's data model.
 */

export type PluginId = 'linux' | 'docker' | 'proxmox' | 'sensors' | 'smart' | 'network';

/** Every plugin declares which capabilities it provides. */
export type Capability =
  // Linux plugin
  | 'cpu' | 'memory' | 'swap' | 'filesystem' | 'processes'
  | 'packages' | 'services' | 'system_info'
  // Docker plugin
  | 'containers' | 'images' | 'compose_projects'
  // Proxmox plugin (node-local telemetry only — NOT VM/LXC inventory)
  | 'node_telemetry' | 'node_events' | 'hardware_inventory'
  | 'zfs_health' | 'ceph_health'
  // Sensors plugin
  | 'temperature' | 'fan' | 'voltage'
  // SMART plugin
  | 'disk_health'
  // Network plugin
  | 'network_interfaces' | 'gateway' | 'dns' | 'public_ip' | 'latency' | 'packet_loss';

export type HostType = 'bare-metal' | 'vm' | 'hypervisor' | 'container' | 'unknown';
export type Severity = 'info' | 'warning' | 'critical';

/** Platform constraints — which OS/arch a plugin supports. */
export type Platform = 'linux' | 'any';

export interface HostInfo {
  hostId: string;
  hostName: string;
  hostname: string;
  machineId: string;
  ip: string;
  mac: string;
  os: string;
  osId: string;
  osVersion: string;
  kernel: string;
  arch: string;
  hostType: HostType;
  hypervisor: string;
  platform: string;
  manufacturer: string;
  product: string;
  bios: string;
  uptimeSeconds: number;
  /** If running in a VM, the VM identifier (e.g., Proxmox VMID) */
  vmId?: string;
  /** If running in a VM, the hypervisor/parent IP */
  parentIp?: string;
  /** Hypervisor type as detected by systemd-detect-virt */
  virtType?: string;
}

export interface PluginData {
  plugin: PluginId;
  collectedAt: number;
  data: Record<string, unknown>;
}

/**
 * The agent report sent to the backend.
 * `capabilities` tells the backend what data is available.
 * The backend should request data by capability.
 */
export interface AgentReport {
  hostInfo: HostInfo;
  capabilities: Capability[];
  plugins: PluginData[];
  events: AgentEvent[];
  reportedAt: number;
  agentVersion: string;
}

export interface AgentEvent {
  id: string;
  timestamp: number;
  severity: Severity;
  plugin: PluginId;
  resource: string;
  message: string;
  previousState: string;
  currentState: string;
}

export interface PluginMeta {
  id: PluginId;
  name: string;
  description: string;
  version: string;
  /** Capabilities this plugin provides. Backend requests by capability. */
  capabilities: Capability[];
  /** Platform constraint. 'linux' = Linux only, 'any' = all platforms. */
  platform: Platform;
  /** How often this plugin should be polled (ms). Agent core respects per-plugin intervals. */
  recommendedPollMs: number;
  /** How often events should be checked (ms). */
  recommendedEventMs: number;
}

export interface CollectedMetrics {
  [key: string]: unknown;
}
