import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadEventQueue, saveEventQueue } from '../core/event-queue.js';
import type { AgentEvent } from '../types/index.js';

const event: AgentEvent = {
  id: 'event-1',
  timestamp: 1,
  severity: 'warning',
  plugin: 'linux',
  resource: 'cpu',
  message: 'CPU elevated',
  previousState: 'normal',
  currentState: 'elevated',
};

test('durable event queue survives save and reload', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'homelab-agent-queue-'));
  try {
    assert.deepEqual(await loadEventQueue(dir), []);
    await saveEventQueue(dir, [event]);
    assert.deepEqual(await loadEventQueue(dir), [event]);
    const mode = (await fs.stat(path.join(dir, 'pending-events.json'))).mode & 0o777;
    assert.equal(mode, 0o600);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
