import fs from 'node:fs';
import { Plugin } from '../../core/plugin.js';
import { observeState } from '../../core/event-engine.js';
import { log } from '../../core/logger.js';
import type { PluginMeta, AgentEvent, CollectedMetrics } from '../../types/index.js';

let Docker: any = null;
try {
  Docker = (await import('dockerode')).default;
} catch {}

interface ContainerSnapshot {
  id: string;
  name: string;
  image: string;
  state: string;
  running: boolean;
  health: string;
  restartCount: number;
  ports: string[];
  cpuPercent: number;
  memUsageMb: number;
  memLimitMb: number;
  memPercent: number;
  netRxMb: number;
  netTxMb: number;
  pids: number;
  startedAt: string;
  composeProject: string;
  composeService: string;
}

interface ComposeProject {
  name: string;
  services: string[];
  runningCount: number;
}

export class DockerPlugin extends Plugin {
  meta: PluginMeta = {
    id: 'docker',
    name: 'Docker',
    description: 'Docker containers, images, networks, volumes, compose projects, container health and resource usage',
    version: '1.0.0',
    capabilities: ['containers', 'images', 'compose_projects'],
    platform: 'linux',
    recommendedPollMs: 1000,
    recommendedEventMs: 1000,
  };

  private docker: any = null;
  private containerStates = new Map<string, string>();

  async detect(): Promise<boolean> {
    // Check if Docker socket exists
    if (!fs.existsSync(this.ctx.dockerSocket)) {
      return false;
    }
    if (!Docker) {
      return false;
    }
    try {
      this.docker = new Docker({ socketPath: this.ctx.dockerSocket });
      await this.docker.ping();
      return true;
    } catch {
      log.warn('docker', 'Docker socket exists but daemon not responding');
      return false;
    }
  }

  async collect(): Promise<CollectedMetrics> {
    const containers = await this.collectContainers();
    const images = await this.collectImages();
    const networks = await this.collectNetworks();
    const volumes = await this.collectVolumes();
    const composeProjects = this.extractComposeProjects(containers);

    return {
      containers,
      containerCount: containers.length,
      runningCount: containers.filter((c) => c.running).length,
      stoppedCount: containers.filter((c) => !c.running).length,
      unhealthyCount: containers.filter((c) => c.health === 'unhealthy').length,
      images,
      imageCount: images.length,
      networks,
      networkCount: networks.length,
      volumes,
      volumeCount: volumes.length,
      composeProjects,
    };
  }

  async checkEvents(): Promise<AgentEvent[]> {
    const events: AgentEvent[] = [];
    const containers = await this.collectContainers();

    for (const c of containers) {
      const stateKey = `${c.name}`;
      const currentState = c.running ? 'running' : c.state;

      // Container state change
      const evt = observeState('docker', stateKey, currentState, 'info',
        `Container ${c.name} is ${currentState}`);
      if (evt) {
        evt.severity = c.running ? 'info' : 'warning';
        events.push(evt);
      }

      // Health change
      if (c.health && c.health !== 'none') {
        const healthEvt = observeState('docker', `${c.name}:health`, c.health,
          c.health === 'unhealthy' ? 'critical' : 'info',
          `Container ${c.name} health: ${c.health}`);
        if (healthEvt) events.push(healthEvt);
      }
    }

    // Detect removed containers
    for (const [name] of this.containerStates) {
      if (!containers.find((c) => c.name === name)) {
        const evt = observeState('docker', name, 'removed', 'warning',
          `Container ${name} was removed`);
        if (evt) events.push(evt);
        this.containerStates.delete(name);
      }
    }

    // Update tracked states
    for (const c of containers) {
      this.containerStates.set(c.name, c.running ? 'running' : c.state);
    }

    return events;
  }

  private async collectContainers(): Promise<ContainerSnapshot[]> {
    if (!this.docker) return [];
    try {
      const raw = await this.docker.listContainers({ all: true });

      const tasks = raw.map(async (c: any) => {
        const name = (c.Names[0] ?? '').replace(/^\//, '');
        const snapshot: ContainerSnapshot = {
          id: c.Id.slice(0, 12),
          name,
          image: c.Image,
          state: c.State,
          running: c.State === 'running',
          health: c.Labels?.['maintainer'] ? 'unknown' : 'unknown',
          restartCount: 0,
          ports: (c.Ports ?? [])
            .filter((p: any) => p.PublicPort)
            .map((p: any) => `${p.PrivatePort}-${p.PublicPort}/${p.Type}`),
          cpuPercent: 0,
          memUsageMb: 0,
          memLimitMb: 0,
          memPercent: 0,
          netRxMb: 0,
          netTxMb: 0,
          pids: 0,
          startedAt: c.Created ? new Date(c.Created * 1000).toISOString() : '',
          composeProject: c.Labels?.['com.docker.compose.project'] ?? '',
          composeService: c.Labels?.['com.docker.compose.service'] ?? '',
        };

        // Parallel stats collection with a fast 1s timeout
        if (c.State === 'running') {
          try {
            const container = this.docker.getContainer(c.Id);
            const statsPromise = (async () => {
              const inspect = await container.inspect();
              snapshot.health = inspect.State?.Health?.Status ?? 'none';
              snapshot.restartCount = inspect.RestartCount ?? 0;

              const stats = await container.stats({ stream: false });
              const cpuDelta = stats.cpu_stats.cpu_usage.total_usage - (stats.precpu_stats.cpu_usage.total_usage ?? 0);
              const systemDelta = stats.cpu_stats.system_cpu_usage - (stats.precpu_stats.system_cpu_usage ?? 0);
              const cpuCount = stats.cpu_stats.online_cpus ?? 1;
              snapshot.cpuPercent = systemDelta > 0 ? (cpuDelta / systemDelta) * cpuCount * 100 : 0;

              const memUsage = stats.memory_stats.usage ?? 0;
              const memCache = stats.memory_stats.stats?.cache ?? 0;
              snapshot.memUsageMb = Math.round((memUsage - memCache) / 1e6);
              snapshot.memLimitMb = Math.round((stats.memory_stats.limit ?? 0) / 1e6);
              snapshot.memPercent = stats.memory_stats.limit
                ? ((memUsage - memCache) / stats.memory_stats.limit) * 100
                : 0;

              const networks = stats.networks ?? {};
              for (const net of Object.values(networks) as any[]) {
                snapshot.netRxMb += (net.rx_bytes ?? 0) / 1e6;
                snapshot.netTxMb += (net.tx_bytes ?? 0) / 1e6;
              }
              snapshot.pids = stats.pids_stats?.current ?? 0;
            })();

            await Promise.race([
              statsPromise,
              new Promise((resolve) => setTimeout(resolve, 1000)),
            ]);
          } catch {
            // Stats unavailable
          }
        }

        return snapshot;
      });

      return await Promise.all(tasks);
    } catch (err) {
      log.error('docker', `Failed to list containers: ${(err as Error).message}`);
      return [];
    }
  }

  private async collectImages(): Promise<Array<{ id: string; tag: string; sizeMb: number; created: string }>> {
    if (!this.docker) return [];
    try {
      const images = await this.docker.listImages();
      return images.map((img: any) => ({
        id: (img.Id ?? '').replace('sha256:', '').slice(0, 12),
        tag: (img.RepoTags ?? ['<none>:<none>'])[0],
        sizeMb: Math.round((img.Size ?? 0) / 1e6),
        created: img.Created ? new Date(img.Created * 1000).toISOString() : '',
      }));
    } catch {
      return [];
    }
  }

  private async collectNetworks(): Promise<Array<{ name: string; driver: string; subnet: string; gateway: string }>> {
    if (!this.docker) return [];
    try {
      const networks = await this.docker.listNetworks();
      return networks.map((n: any) => ({
        name: n.Name,
        driver: n.Driver ?? '',
        subnet: n.IPAM?.Config?.[0]?.Subnet ?? '',
        gateway: n.IPAM?.Config?.[0]?.Gateway ?? '',
      }));
    } catch {
      return [];
    }
  }

  private async collectVolumes(): Promise<Array<{ name: string; driver: string; mountpoint: string; sizeMb: number }>> {
    if (!this.docker) return [];
    try {
      const volumes = await this.docker.listVolumes();
      return (volumes.Volumes ?? []).map((v: any) => ({
        name: v.Name,
        driver: v.Driver ?? '',
        mountpoint: v.Mountpoint ?? '',
        sizeMb: 0, // Docker doesn't expose volume sizes directly
      }));
    } catch {
      return [];
    }
  }

  private extractComposeProjects(containers: ContainerSnapshot[]): ComposeProject[] {
    const projects = new Map<string, string[]>();
    for (const c of containers) {
      if (c.composeProject) {
        const existing = projects.get(c.composeProject) ?? [];
        existing.push(c.composeService || c.name);
        projects.set(c.composeProject, existing);
      }
    }
    return Array.from(projects.entries()).map(([name, services]) => ({
      name,
      services,
      runningCount: containers.filter((c) => c.composeProject === name && c.running).length,
    }));
  }
}
