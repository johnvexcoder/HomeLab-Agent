import { registerPlugin } from '../core/registry.js';
import { LinuxPlugin } from './linux/index.js';
import { DockerPlugin } from './docker/index.js';
import { ProxmoxPlugin } from './proxmox/index.js';
import { SensorsPlugin } from './sensors/index.js';
import { SmartPlugin } from './smart/index.js';
import { NetworkPlugin } from './network/index.js';

// Register all built-in plugins.
// To add a new plugin: create the class, then register it here.
// The registry handles detection and lifecycle automatically.
export function registerAllPlugins(): void {
  registerPlugin(new LinuxPlugin());
  registerPlugin(new DockerPlugin());
  registerPlugin(new ProxmoxPlugin());
  registerPlugin(new SensorsPlugin());
  registerPlugin(new SmartPlugin());
  registerPlugin(new NetworkPlugin());
}
