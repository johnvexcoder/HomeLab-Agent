import fs from 'node:fs';

export interface AgentConfig {
  dashboardUrl: string;
  apiKey: string;
  pollInterval: number;
  eventCheckInterval: number;
  hostId: string;
  hostName: string;
  dockerSocket: string;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
  maxEventsPerReport: number;
  hostRoot: string;
  apiKeyFile: string;
  allowInsecureHttp: boolean;
  stateDir: string;
}

const DEFAULTS: Partial<AgentConfig> = {
  pollInterval: 2_000,
  eventCheckInterval: 1_000,
  hostId: '',
  hostName: '',
  dockerSocket: '/var/run/docker.sock',
  logLevel: 'info',
  maxEventsPerReport: 50,
  hostRoot: '/',
  apiKeyFile: '',
  allowInsecureHttp: false,
  stateDir: '/var/lib/homelab-agent',
};

export function loadConfig(): AgentConfig {
  const dashboardUrl = env('DASHBOARD_URL');
  const apiKeyFile = env('API_KEY_FILE');
  const apiKey = apiKeyFile ? readSecretFile(apiKeyFile) : env('API_KEY');
  const allowInsecureHttp = bool('ALLOW_INSECURE_HTTP', DEFAULTS.allowInsecureHttp!);

  if (!dashboardUrl) {
    console.error('[config] DASHBOARD_URL is required');
    process.exit(1);
  }
  let parsedDashboard: URL;
  try {
    parsedDashboard = new URL(dashboardUrl);
  } catch {
    throw new Error('DASHBOARD_URL must be a valid http:// or https:// URL');
  }
  if (!['http:', 'https:'].includes(parsedDashboard.protocol)) {
    throw new Error('DASHBOARD_URL must use http:// or https://');
  }
  const loopback = ['localhost', '127.0.0.1', '::1'].includes(parsedDashboard.hostname);
  if (parsedDashboard.protocol === 'http:' && !loopback && !allowInsecureHttp) {
    throw new Error('Refusing to send the agent key over HTTP. Use HTTPS or explicitly set ALLOW_INSECURE_HTTP=true for a trusted LAN.');
  }
  if (parsedDashboard.protocol === 'http:' && !loopback) {
    console.warn('[config] ALLOW_INSECURE_HTTP=true: agent credentials are not encrypted in transit');
  }
  if (!apiKey) {
    console.error('[config] API_KEY is required');
    process.exit(1);
  }

  return {
    dashboardUrl: dashboardUrl.replace(/\/+$/, ''),
    apiKey,
    apiKeyFile,
    allowInsecureHttp,
    pollInterval: num('POLL_INTERVAL', DEFAULTS.pollInterval!),
    eventCheckInterval: num('EVENT_CHECK_INTERVAL', DEFAULTS.eventCheckInterval!),
    hostId: env('HOST_ID') || '',
    hostName: env('HOST_NAME') || '',
    dockerSocket: env('DOCKER_SOCKET') || DEFAULTS.dockerSocket!,
    logLevel: (env('LOG_LEVEL') || DEFAULTS.logLevel!) as AgentConfig['logLevel'],
    maxEventsPerReport: num('MAX_EVENTS_PER_REPORT', DEFAULTS.maxEventsPerReport!),
    hostRoot: env('HOST_ROOT') || DEFAULTS.hostRoot!,
    stateDir: env('STATE_DIR') || DEFAULTS.stateDir!,
  };
}

export function currentApiKey(config: AgentConfig): string {
  return config.apiKeyFile ? readSecretFile(config.apiKeyFile) : config.apiKey;
}

function readSecretFile(file: string): string {
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch (err) {
    throw new Error(`Unable to read API_KEY_FILE ${file}: ${(err as Error).message}`, { cause: err });
  }
}

function env(key: string): string {
  return process.env[key] ?? '';
}

function num(key: string, fallback: number): number {
  const raw = process.env[key];
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function bool(key: string, fallback: boolean): boolean {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  return raw.toLowerCase() === 'true';
}
