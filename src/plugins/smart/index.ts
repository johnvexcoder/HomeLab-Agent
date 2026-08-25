import fs from 'node:fs';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
const execAsync = promisify(exec);
import { Plugin } from '../../core/plugin.js';
import { observeState } from '../../core/event-engine.js';
import { log } from '../../core/logger.js';
import type { PluginMeta, AgentEvent, CollectedMetrics } from '../../types/index.js';

async function tryExec(cmd: string, timeout = 10000): Promise<string> {
  try {
    const { stdout } = await execAsync(cmd, { encoding: 'utf-8', timeout });
    return stdout.trim();
  } catch (err: any) {
    log.warn('smart', `tryExec failed for "${cmd}": ${err.message}`);
    return '';
  }
}

function round(n: number, d: number): number {
  const f = 10 ** d;
  return Math.round(n * f) / f;
}

interface SmartDrive {
  device: string;
  model: string;
  serial: string;
  health: string;
  temperatureC: number | null;
  powerOnHours: number | null;
  percentageUsed: number | null;
  availableSpare: number | null;
  capacityBytes: number;
  interfaceType: string;
  smartErrors: number;
  warnings: string[];
}

export class SmartPlugin extends Plugin {
  meta: PluginMeta = {
    id: 'smart',
    name: 'SMART',
    description: 'Disk drive health, temperature, remaining life, power-on hours, SMART errors via smartctl',
    version: '1.0.0',
    capabilities: ['disk_health'],
    platform: 'linux',
    recommendedPollMs: 600000, // 10 minutes — SMART doesn't change fast
    recommendedEventMs: 60000,
  };

  private driveStates = new Map<string, string>();

  async detect(): Promise<boolean> {
    // Check if smartctl is available
    const which = await tryExec('which smartctl 2>/dev/null');
    if (!which) return false;

    // Check if there are any drives
    const drives = await this.findDrives();
    return drives.length > 0;
  }

  async collect(): Promise<CollectedMetrics> {
    const drives = await this.collectDrives();
    return {
      drives,
      driveCount: drives.length,
      healthyCount: drives.filter((d) => d.health === 'PASSED' || d.health === 'OK').length,
      failingCount: drives.filter((d) => d.health === 'FAILED').length,
    };
  }

  async checkEvents(): Promise<AgentEvent[]> {
    const events: AgentEvent[] = [];
    const drives = await this.collectDrives();

    for (const drive of drives) {
      // Health change
      const evt = observeState('smart', drive.device, drive.health,
        drive.health === 'PASSED' || drive.health === 'OK' ? 'info' : 'critical',
        `Drive ${drive.device} health: ${drive.health}`);
      if (evt) events.push(evt);

      // Temperature threshold
      if (drive.temperatureC != null) {
        const tempEvt = observeState('smart', `${drive.device}:temp`,
          drive.temperatureC > 55 ? 'high' : drive.temperatureC > 45 ? 'warm' : 'normal',
          drive.temperatureC > 55 ? 'critical' : drive.temperatureC > 45 ? 'warning' : 'info',
          `Drive ${drive.device} temperature: ${drive.temperatureC}°C`);
        if (tempEvt) events.push(tempEvt);
      }

      // Available spare threshold
      if (drive.availableSpare != null && drive.availableSpare < 10) {
        const spareEvt = observeState('smart', `${drive.device}:spare`, 'low', 'critical',
          `Drive ${drive.device} available spare: ${drive.availableSpare}%`);
        if (spareEvt) events.push(spareEvt);
      }
    }

    return events;
  }

  private async findDrives(): Promise<string[]> {
    // Use lsblk to find block devices
    const out = await tryExec('lsblk -d -n -o NAME,TYPE 2>/dev/null');
    if (!out) return [];
    return out.split('\n')
      .filter((l) => l.includes('disk'))
      .map((l) => `/dev/${l.split(/\s+/)[0]}`);
  }

  private async collectDrives(): Promise<SmartDrive[]> {
    const devices = await this.findDrives();
    const drives: SmartDrive[] = [];

    for (const device of devices) {
      try {
        const drive = await this.collectDrive(device);
        if (drive) drives.push(drive);
      } catch (err) {
        log.debug('smart', `Failed to read SMART for ${device}: ${(err as Error).message}`);
      }
    }
    return drives;
  }

  private async collectDrive(device: string): Promise<SmartDrive | null> {
    // Try JSON output first
    const jsonOut = await tryExec(`smartctl -a -j ${device} 2>/dev/null`);
    if (jsonOut) {
      try {
        return this.parseSmartJson(device, JSON.parse(jsonOut));
      } catch {}
    }

    // Fallback: text output parsing
    const textOut = await tryExec(`smartctl -a ${device} 2>/dev/null`);
    if (!textOut) return null;

    return this.parseSmartText(device, textOut);
  }

  private parseSmartJson(device: string, data: any): SmartDrive | null {
    if (!data.smart_status && !data.model_name) return null;

    const health = data.smart_status?.passed === true ? 'PASSED'
      : data.smart_status?.passed === false ? 'FAILED'
      : 'UNKNOWN';

    let tempC: number | null = null;
    let powerOnHours: number | null = null;
    let percentageUsed: number | null = null;
    let availableSpare: number | null = null;

    // Parse NVMe or SCSI/SATA attributes
    if (data.nvme_smart_health_information_log) {
      const nvme = data.nvme_smart_health_information_log;
      tempC = nvme.temperature ?? null;
      powerOnHours = nvme.power_on_hours ?? null;
      percentageUsed = nvme.percentage_used ?? null;
      availableSpare = nvme.available_spare ?? null;
    }

    if (data.ata_smart_attributes?.table) {
      for (const attr of data.ata_smart_attributes.table) {
        switch (attr.id) {
          case 194: tempC = attr.raw?.value ?? attr.value ?? null; break; // Temperature
          case 9: powerOnHours = attr.raw?.string ? Number(attr.raw.string) : attr.value; break; // Power-On Hours
          case 177: percentageUsed = attr.value ?? null; break; // Wear Leveling
        }
      }
    }

    return {
      device,
      model: data.model_name ?? data.model_family ?? 'unknown',
      serial: data.serial_number ?? '',
      health,
      temperatureC: tempC != null ? round(tempC, 1) : null,
      powerOnHours,
      percentageUsed,
      availableSpare,
      capacityBytes: data.user_capacity?.bytes ?? 0,
      interfaceType: data.interface_type ?? data.transport_type ?? '',
      smartErrors: data.smart_error_log?.error_log_count ?? 0,
      warnings: [],
    };
  }

  private parseSmartText(device: string, text: string): SmartDrive {
    const health = text.includes('SMART overall-health self-assessment test result: PASSED')
      ? 'PASSED'
      : text.includes('PASSED') ? 'PASSED'
      : text.includes('FAILED') ? 'FAILED'
      : 'UNKNOWN';

    let tempC: number | null = null;
    let powerOnHours: number | null = null;
    let percentageUsed: number | null = null;

    const tempMatch = text.match(/Temperature_Celsius\s+\d+\s+(\d+)/);
    if (tempMatch) tempC = Number(tempMatch[1]);

    const hoursMatch = text.match(/Power_On_Hours\s+\d+\s+(\d+)/);
    if (hoursMatch) powerOnHours = Number(hoursMatch[1]);

    const modelMatch = text.match(/Device Model:\s+(.+)/);
    const serialMatch = text.match(/Serial Number:\s+(.+)/);

    return {
      device,
      model: modelMatch?.[1]?.trim() ?? 'unknown',
      serial: serialMatch?.[1]?.trim() ?? '',
      health,
      temperatureC: tempC,
      powerOnHours,
      percentageUsed,
      availableSpare: null,
      capacityBytes: 0,
      interfaceType: '',
      smartErrors: (text.match(/ATA Error Count:\s+(\d+)/)?.[1] ?? '0') as unknown as number,
      warnings: [],
    };
  }
}
