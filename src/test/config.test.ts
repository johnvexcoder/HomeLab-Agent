import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { currentApiKey, loadConfig } from '../core/config.js';

const originalEnv = { ...process.env };

test.afterEach(() => {
  process.env = { ...originalEnv };
});

test('refuses non-loopback HTTP unless explicitly allowed', () => {
  process.env.DASHBOARD_URL = 'http://192.168.1.31:3000/api';
  process.env.API_KEY = 'hl_test';
  delete process.env.API_KEY_FILE;
  delete process.env.ALLOW_INSECURE_HTTP;
  assert.throws(() => loadConfig(), /Refusing to send the agent key over HTTP/);
});

test('loads and reloads an explicitly permitted LAN key file', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'homelab-agent-config-'));
  const keyFile = path.join(dir, 'key');
  try {
    await fs.writeFile(keyFile, 'hl_first\n', { mode: 0o600 });
    process.env.DASHBOARD_URL = 'http://192.168.1.31:3000/api';
    process.env.API_KEY_FILE = keyFile;
    process.env.ALLOW_INSECURE_HTTP = 'true';
    delete process.env.API_KEY;
    const config = loadConfig();
    assert.equal(currentApiKey(config), 'hl_first');
    await fs.writeFile(keyFile, 'hl_second\n', { mode: 0o600 });
    assert.equal(currentApiKey(config), 'hl_second');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
