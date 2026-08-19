import type { PluginData, Capability, PluginId } from '../types/index.js';

interface CacheEntry {
  data: PluginData;
  updatedAt: number;
}

/**
 * Shared metric cache.
 *
 * One lm-sensors execution → shared cache → CPU widget, Temperature widget,
 * Dashboard overview, Alerts. No duplicated system calls.
 *
 * Keyed by PluginId. Capability lookups resolve via the capability map
 * maintained by the registry.
 */
const cache = new Map<PluginId, CacheEntry>();

/** Capability → PluginId mapping (set by the registry after init). */
const capabilityToPlugin = new Map<Capability, PluginId>();

export function registerCapability(cap: Capability, pluginId: PluginId): void {
  capabilityToPlugin.set(cap, pluginId);
}

export function cacheSet(pluginId: PluginId, data: PluginData): void {
  cache.set(pluginId, { data, updatedAt: Date.now() });
}

export function cacheGet(pluginId: PluginId): PluginData | undefined {
  return cache.get(pluginId)?.data;
}

export function cacheGetByCapability(cap: Capability): PluginData | undefined {
  const pluginId = capabilityToPlugin.get(cap);
  if (!pluginId) return undefined;
  return cache.get(pluginId)?.data;
}

export function cacheGetAll(): PluginData[] {
  return Array.from(cache.values()).map((e) => e.data);
}

export function cacheHas(pluginId: PluginId): boolean {
  return cache.has(pluginId);
}

export function cacheAge(pluginId: PluginId): number {
  const entry = cache.get(pluginId);
  if (!entry) return Infinity;
  return Date.now() - entry.updatedAt;
}

export function cacheClear(): void {
  cache.clear();
}
