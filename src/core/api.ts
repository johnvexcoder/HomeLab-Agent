import http from 'node:http';
import https from 'node:https';
import { currentApiKey, type AgentConfig } from './config.js';
import type { AgentReport, AgentEvent } from '../types/index.js';
import { log } from './logger.js';

/**
 * POST JSON to the backend using Node.js http/https module.
 * Undici's fetch() hangs on some Node.js 20 builds (e.g. pve0),
 * so we use the classic http module which is battle-tested.
 */
function postJson(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  timeoutMs = 30_000,
): Promise<{ ok: boolean; status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const isHttps = parsed.protocol === 'https:';
    const mod = isHttps ? https : http;

    const payload = JSON.stringify(body);
    const payloadBytes = Buffer.byteLength(payload);

    const req = mod.request(
      parsed,
      {
        method: 'POST',
        headers: {
          ...headers,
          'Content-Type': 'application/json',
          'Content-Length': payloadBytes,
          'Connection': 'close',
        },
        timeout: timeoutMs,
        agent: false,
      },
      (res) => {
        let data = '';
        let responseBytes = 0;
        res.on('data', (chunk: Buffer) => {
          responseBytes += chunk.length;
          if (responseBytes > 1024 * 1024) {
            req.destroy(new Error('Response exceeded 1 MiB'));
            return;
          }
          data += chunk;
        });
        res.on('end', () => {
          resolve({ ok: res.statusCode !== undefined && res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode ?? 0, body: data });
        });
      },
    );

    req.on('error', (err) => {
      log.error('api', `HTTP error for ${parsed.pathname}: ${(err as Error).message} (body=${payloadBytes}b)`);
      reject(err);
    });
    req.on('timeout', () => {
      req.destroy(new Error('Request timed out'));
    });

    req.write(payload);
    req.end();
  });
}

export async function registerAgent(
  config: AgentConfig,
  report: AgentReport,
): Promise<boolean> {
  const url = `${config.dashboardUrl}/agent/register`;
  try {
    const res = await postJson(url, {
      'X-Agent-Key': currentApiKey(config),
      'X-Agent-Version': report.agentVersion,
    }, {
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
    });
    if (!res.ok) {
      log.error('api', `Register failed ${res.status}: ${res.body}`);
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
    const res = await postJson(url, {
      'X-Agent-Key': currentApiKey(config),
      'X-Agent-Version': report.agentVersion,
    }, report);
    if (!res.ok) {
      log.error('api', `Report failed ${res.status}: ${res.body}`);
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
    const res = await postJson(url, {
      'X-Agent-Key': currentApiKey(config),
    }, { hostId, events });
    return res.ok;
  } catch {
    return false;
  }
}
