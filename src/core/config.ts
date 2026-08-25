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
};

export function loadConfig(): AgentConfig {
  const dashboardUrl = env('DASHBOARD_URL');
  const apiKey = env('API_KEY');

  if (!dashboardUrl) {
    console.error('[config] DASHBOARD_URL is required');
    process.exit(1);
  }
  if (dashboardUrl.startsWith('http://') && !dashboardUrl.includes('localhost') && !dashboardUrl.includes('127.0.0.1')) {
    console.warn('\n================================================================');
    console.warn('WARNING: AGENT CONNECTING TO DASHBOARD OVER INSECURE HTTP');
    console.warn('Your X-Agent-Key will be transmitted in plaintext!');
    console.warn('================================================================\n');
  }
  if (!apiKey) {
    console.error('[config] API_KEY is required');
    process.exit(1);
  }

  return {
    dashboardUrl: dashboardUrl.replace(/\/+$/, ''),
    apiKey,
    pollInterval: num('POLL_INTERVAL', DEFAULTS.pollInterval!),
    eventCheckInterval: num('EVENT_CHECK_INTERVAL', DEFAULTS.eventCheckInterval!),
    hostId: env('HOST_ID') || '',
    hostName: env('HOST_NAME') || '',
    dockerSocket: env('DOCKER_SOCKET') || DEFAULTS.dockerSocket!,
    logLevel: (env('LOG_LEVEL') || DEFAULTS.logLevel!) as AgentConfig['logLevel'],
    maxEventsPerReport: num('MAX_EVENTS_PER_REPORT', DEFAULTS.maxEventsPerReport!),
    hostRoot: env('HOST_ROOT') || DEFAULTS.hostRoot!,
  };
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
