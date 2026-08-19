import type { AgentConfig } from './config.js';
import type { AgentReport, AgentEvent } from '../types/index.js';
import { log } from './logger.js';

export async function registerAgent(
  config: AgentConfig,
  report: AgentReport,
): Promise<boolean> {
  const url = `${config.dashboardUrl}/agent/register`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Agent-Key': config.apiKey,
        'X-Agent-Version': report.agentVersion,
      },
      body: JSON.stringify({
        hostId: report.hostInfo.hostId,
        hostName: report.hostInfo.hostName,
        ip: report.hostInfo.ip,
        os: report.hostInfo.os,
        osId: report.hostInfo.osId,
        kernel: report.hostInfo.kernel,
        arch: report.hostInfo.arch,
        hostType: report.hostInfo.hostType,
        hypervisor: report.hostInfo.hypervisor,
        platform: report.hostInfo.platform,
        manufacturer: report.hostInfo.manufacturer,
        product: report.hostInfo.product,
        machineId: report.hostInfo.machineId,
        capabilities: report.capabilities,
        plugins: report.plugins.map((p) => p.plugin),
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      log.error('api', `Register failed ${res.status}: ${text}`);
      return false;
    }
    log.info('api', 'Registered with dashboard');
    return true;
  } catch (err) {
    log.error('api', `Register failed: ${(err as Error).message}`);
    return false;
  }
}

export async function reportMetrics(
  config: AgentConfig,
  report: AgentReport,
): Promise<boolean> {
  const url = `${config.dashboardUrl}/agent/report`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Agent-Key': config.apiKey,
        'X-Agent-Version': report.agentVersion,
      },
      body: JSON.stringify(report),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      log.error('api', `Report failed ${res.status}: ${text}`);
      return false;
    }
    return true;
  } catch (err) {
    log.error('api', `Report failed: ${(err as Error).message}`);
    return false;
  }
}

export async function reportEvents(
  config: AgentConfig,
  hostId: string,
  events: AgentEvent[],
): Promise<boolean> {
  if (events.length === 0) return true;
  const url = `${config.dashboardUrl}/agent/events`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Agent-Key': config.apiKey,
      },
      body: JSON.stringify({ hostId, events }),
    });
    return res.ok;
  } catch {
    return false;
  }
}
