import fs from 'node:fs/promises';
import path from 'node:path';
import type { AgentEvent } from '../types/index.js';
import { log } from './logger.js';

const QUEUE_FILE = 'pending-events.json';

function queuePath(stateDir: string): string {
  return path.join(stateDir, QUEUE_FILE);
}

export async function loadEventQueue(stateDir: string): Promise<AgentEvent[]> {
  try {
    const raw = await fs.readFile(queuePath(stateDir), 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is AgentEvent => Boolean(item && typeof item === 'object' && typeof (item as AgentEvent).id === 'string'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.warn('events', `Unable to load durable event queue: ${(err as Error).message}`);
    }
    return [];
  }
}

export async function saveEventQueue(stateDir: string, events: AgentEvent[]): Promise<void> {
  await fs.mkdir(stateDir, { recursive: true, mode: 0o700 });
  const target = queuePath(stateDir);
  const temporary = `${target}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(events), { encoding: 'utf8', mode: 0o600 });
  await fs.rename(temporary, target);
}
