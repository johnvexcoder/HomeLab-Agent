type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

let currentLevel: LogLevel = 'info';

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

function shouldLog(level: LogLevel): boolean {
  return LEVELS[level] >= LEVELS[currentLevel];
}

function fmt(level: LogLevel, module: string, msg: string): string {
  const ts = new Date().toISOString().slice(11, 23);
  return `[${ts}] [${level.toUpperCase().padEnd(5)}] [${module}] ${msg}`;
}

export const log = {
  debug(mod: string, msg: string) { if (shouldLog('debug')) console.debug(fmt('debug', mod, msg)); },
  info(mod: string, msg: string) { if (shouldLog('info')) console.log(fmt('info', mod, msg)); },
  warn(mod: string, msg: string) { if (shouldLog('warn')) console.warn(fmt('warn', mod, msg)); },
  error(mod: string, msg: string) { if (shouldLog('error')) console.error(fmt('error', mod, msg)); },
};
