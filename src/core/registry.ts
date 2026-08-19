import type { Plugin, PluginContext } from './plugin.js';
import type { PluginData, AgentEvent, Capability } from '../types/index.js';
import { cacheSet, cacheGetByCapability } from './cache.js';
import { log } from './logger.js';

interface PluginEntry {
  plugin: Plugin;
  lastPollAt: number;
  lastEventAt: number;
}

const allEntries: PluginEntry[] = [];
const enabledEntries: PluginEntry[] = [];

/** Capability → plugin mapping built during init. */
const capabilityMap = new Map<Capability, PluginEntry>();

export function registerPlugin(plugin: Plugin): void {
  allEntries.push({ plugin, lastPollAt: 0, lastEventAt: 0 });
}

/**
 * Initialize all registered plugins:
 * 1. Detect support
 * 2. Build capability map
 * 3. Log what's enabled
 */
export async function initPlugins(ctx: PluginContext): Promise<void> {
  log.info('registry', `Probing ${allEntries.length} plugin(s)...`);

  for (const entry of allEntries) {
    const p = entry.plugin;
    p.init(ctx);
    try {
      const supported = await p.detect();
      p.setEnabled(supported);
      if (supported) {
        enabledEntries.push(entry);
        // Register capabilities
        for (const cap of p.meta.capabilities) {
          capabilityMap.set(cap, entry);
        }
        log.info('registry', `  ✓ ${p.meta.name} v${p.meta.version} — [${p.meta.capabilities.join(', ')}]`);
      } else {
        log.info('registry', `  ✗ ${p.meta.name} — not applicable`);
      }
    } catch (err) {
      p.setEnabled(false);
      log.error('registry', `  ✗ ${p.meta.name} — detection failed: ${(err as Error).message}`);
    }
  }

  log.info('registry', `${enabledEntries.length}/${allEntries.length} plugin(s) enabled, ${capabilityMap.size} capability(ies)`);
}

/**
 * Collect from plugins whose poll interval has elapsed.
 * Returns only newly-collected PluginData (not cached).
 * Each plugin's data is written to the shared cache.
 */
export async function collectDue(): Promise<PluginData[]> {
  const now = Date.now();
  const results: PluginData[] = [];

  const tasks = enabledEntries
    .filter((e) => now - e.lastPollAt >= e.plugin.meta.recommendedPollMs)
    .map(async (e) => {
      try {
        const data = await e.plugin.collect();
        const pd = e.plugin.wrapData(data);
        e.lastPollAt = now;
        // Publish to shared cache — one system call, many consumers
        cacheSet(pd.plugin, pd);
        results.push(pd);
      } catch (err) {
        log.error('registry', `${e.plugin.meta.name} collect failed: ${(err as Error).message}`);
      }
    });

  await Promise.allSettled(tasks);
  return results;
}

/**
 * Check events from plugins whose event interval has elapsed.
 */
export async function checkEventsDue(): Promise<AgentEvent[]> {
  const now = Date.now();
  const events: AgentEvent[] = [];

  const tasks = enabledEntries
    .filter((e) => now - e.lastEventAt >= e.plugin.meta.recommendedEventMs)
    .map(async (e) => {
      try {
        const evts = await e.plugin.checkEvents();
        events.push(...evts);
        e.lastEventAt = now;
      } catch (err) {
        log.error('registry', `${e.plugin.meta.name} event check failed: ${(err as Error).message}`);
      }
    });

  await Promise.allSettled(tasks);
  return events;
}

/**
 * Get all current capabilities provided by enabled plugins.
 * Used during registration to tell the backend what data is available.
 */
export function getCapabilities(): Capability[] {
  return Array.from(capabilityMap.keys());
}

/**
 * Get cached data for a specific capability.
 * The backend can request data by capability — the cache resolves it
 * to the correct plugin's last-collected data.
 */
export function getByCapability(cap: Capability): PluginData | undefined {
  return cacheGetByCapability(cap);
}

export function getEnabledPlugins(): Plugin[] {
  return enabledEntries.map((e) => e.plugin);
}

export function getAllPlugins(): Plugin[] {
  return allEntries.map((e) => e.plugin);
}
