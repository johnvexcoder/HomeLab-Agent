import { hostPath } from "../../core/host.js";
import fs from 'node:fs';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
const execAsync = promisify(exec);
import { Plugin } from '../../core/plugin.js';
import { observeThresholds } from '../../core/event-engine.js';
import { log } from '../../core/logger.js';
import type { PluginMeta, AgentEvent, CollectedMetrics } from '../../types/index.js';

function tryRead(p: string): string {
  try { return fs.readFileSync(hostPath(p), 'utf-8'); } catch (err: any) {
    if (err.code !== 'ENOENT') log.warn('sensors', `tryRead failed for ${p}: ${err.message}`);
    return '';
  }
}

async function tryExec(cmd: string, timeout = 5000): Promise<string> {
  try {
    const { stdout } = await execAsync(cmd, { encoding: 'utf-8', timeout });
    return stdout.trim();
  } catch (err: any) {
    log.warn('sensors', `tryExec failed for "${cmd}": ${err.message}`);
    return '';
  }
}

function round(n: number, d: number): number {
  const f = 10 ** d;
  return Math.round(n * f) / f;
}

interface SensorReading {
  chip: string;
  sensor: string;
  value: number;
  unit: string;
}

export class SensorsPlugin extends Plugin {
  meta: PluginMeta = {
    id: 'sensors',
    name: 'Sensors',
    description: 'CPU temperature, fan speeds, motherboard temperature, voltages via lm-sensors / sysfs',
    version: '1.0.0',
    capabilities: ['temperature', 'fan', 'voltage'],
    platform: 'linux',
    recommendedPollMs: 5000,
    recommendedEventMs: 10000,
  };

  async detect(): Promise<boolean> {
    // Check sysfs thermal zones first (always available)
    if (fs.existsSync(hostPath('/sys/class/thermal/thermal_zone0/temp'))) return true;

    // Check hwmon
    try {
      const hwmons = fs.readdirSync(hostPath('/sys/class/hwmon'));
      for (const h of hwmons) {
        if (fs.existsSync(hostPath(`/sys/class/hwmon/${h}/temp1_input`))) return true;
      }
    } catch {}

    // Check lm-sensors
    const sensorsOut = await tryExec('sensors -j 2>/dev/null');
    if (sensorsOut && sensorsOut !== '{}') return true;

    return false;
  }

  async collect(): Promise<CollectedMetrics> {
    const temps = await this.collectTemperatures();
    const fans = await this.collectFans();
    const voltages = await this.collectVoltages();

    return {
      temperatures: temps,
      cpuTempC: temps.find((t) => t.sensor.toLowerCase().includes('core') || t.sensor.toLowerCase().includes('cpu'))?.value
        ?? temps[0]?.value
        ?? null,
      maxTempC: temps.length > 0 ? Math.max(...temps.map((t) => t.value)) : null,
      fans,
      fanCount: fans.length,
      voltages,
    };
  }

  async checkEvents(): Promise<AgentEvent[]> {
    const events: AgentEvent[] = [];
    const data = await this.collect();

    const cpuTemp = data.cpuTempC as number | null;
    if (cpuTemp != null) {
      events.push(...observeThresholds('sensors', 'cpu_temp', cpuTemp, '°C', 75, 90));
    }

    const maxTemp = data.maxTempC as number | null;
    if (maxTemp != null) {
      events.push(...observeThresholds('sensors', 'max_temp', maxTemp, '°C', 80, 95));
    }

    return events;
  }

  private async collectTemperatures(): Promise<SensorReading[]> {
    // Try lm-sensors JSON output first
    const readings = await this.collectFromLmSensors();
    if (readings.length > 0) return readings;

    // Fallback to sysfs
    return this.collectFromSysfs();
  }

  private async collectFromLmSensors(): Promise<SensorReading[]> {
    const output = await tryExec('sensors -j 2>/dev/null');
    if (!output || output === '{}') return [];

    try {
      const data = JSON.parse(output);
      const readings: SensorReading[] = [];

      for (const [chip, sensors] of Object.entries(data)) {
        if (typeof sensors !== 'object' || sensors === null) continue;
        for (const [sensorName, sensorData] of Object.entries(sensors as Record<string, any>)) {
          if (typeof sensorData !== 'object' || sensorData === null) continue;

          // Temperature inputs
          for (const [key, val] of Object.entries(sensorData)) {
            if (key.endsWith('_input') && typeof val === 'number' && key.startsWith('temp')) {
              const suffix = key.replace('_input', '');
              readings.push({
                chip,
                sensor: `${sensorName}/${suffix}`,
                value: round(val, 1),
                unit: '°C',
              });
            }
          }
        }
      }
      return readings;
    } catch {
      return [];
    }
  }

  private collectFromSysfs(): SensorReading[] {
    const readings: SensorReading[] = [];

    // Thermal zones
    try {
      const zones = fs.readdirSync(hostPath('/sys/class/thermal')).filter((d) => d.startsWith('thermal_zone'));
      for (const zone of zones) {
        const type = tryRead(`/sys/class/thermal/${zone}/type`) || zone;
        const tempRaw = tryRead(`/sys/class/thermal/${zone}/temp`);
        const temp = Number(tempRaw);
        if (Number.isFinite(temp)) {
          readings.push({ chip: 'sysfs', sensor: type, value: round(temp / 1000, 1), unit: '°C' });
        }
      }
    } catch {}

    // hwmon
    try {
      const hwmons = fs.readdirSync(hostPath('/sys/class/hwmon'));
      for (const h of hwmons) {
        const name = tryRead(`/sys/class/hwmon/${h}/name`) || h;
        for (let i = 1; i <= 20; i++) {
          const input = tryRead(`/sys/class/hwmon/${h}/temp${i}_input`);
          if (!input) continue;
          const val = Number(input);
          if (!Number.isFinite(val)) continue;
          const label = tryRead(`/sys/class/hwmon/${h}/temp${i}_label`) || `temp${i}`;
          readings.push({ chip: name, sensor: label, value: round(val / 1000, 1), unit: '°C' });
        }
      }
    } catch {}

    return readings;
  }

  private async collectFans(): Promise<SensorReading[]> {
    const output = await tryExec('sensors -j 2>/dev/null');
    if (!output || output === '{}') return [];

    try {
      const data = JSON.parse(output);
      const readings: SensorReading[] = [];

      for (const [chip, sensors] of Object.entries(data)) {
        if (typeof sensors !== 'object' || sensors === null) continue;
        for (const [sensorName, sensorData] of Object.entries(sensors as Record<string, any>)) {
          if (typeof sensorData !== 'object' || sensorData === null) continue;
          for (const [key, val] of Object.entries(sensorData)) {
            if (key.endsWith('_input') && typeof val === 'number' && (key.includes('fan') || sensorName.toLowerCase().includes('fan'))) {
              readings.push({
                chip,
                sensor: sensorName,
                value: Math.round(val),
                unit: 'RPM',
              });
            }
          }
        }
      }
      return readings;
    } catch {
      return [];
    }
  }

  private async collectVoltages(): Promise<SensorReading[]> {
    const output = await tryExec('sensors -j 2>/dev/null');
    if (!output || output === '{}') return [];

    try {
      const data = JSON.parse(output);
      const readings: SensorReading[] = [];

      for (const [chip, sensors] of Object.entries(data)) {
        if (typeof sensors !== 'object' || sensors === null) continue;
        for (const [sensorName, sensorData] of Object.entries(sensors as Record<string, any>)) {
          if (typeof sensorData !== 'object' || sensorData === null) continue;
          for (const [key, val] of Object.entries(sensorData)) {
            if (key.endsWith('_input') && typeof val === 'number' && key.includes('in')) {
              readings.push({
                chip,
                sensor: sensorName,
                value: round(val, 3),
                unit: 'V',
              });
            }
          }
        }
      }
      return readings;
    } catch {
      return [];
    }
  }
}
