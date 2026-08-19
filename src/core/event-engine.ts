import crypto from 'node:crypto';
import type { AgentEvent, PluginId, Severity } from '../types/index.js';

interface StateEntry {
  resource: string;
  state: string;
  firstSeen: number;
}

const states = new Map<string, StateEntry>();

function stateKey(plugin: PluginId, resource: string): string {
  return `${plugin}:${resource}`;
}

/**
 * Record a resource state and return an event if the state changed.
 * Returns null if the state is the same as before (or this is the first observation).
 */
export function observeState(
  plugin: PluginId,
  resource: string,
  currentState: string,
  severity: Severity = 'info',
  message?: string,
): AgentEvent | null {
  const key = stateKey(plugin, resource);
  const existing = states.get(key);

  if (!existing) {
    states.set(key, { resource, state: currentState, firstSeen: Date.now() });
    return null; // first observation, no event
  }

  if (existing.state === currentState) return null; // no change

  const event: AgentEvent = {
    id: crypto.randomUUID(),
    timestamp: Date.now(),
    severity,
    plugin,
    resource,
    message: message ?? `${resource}: ${existing.state} → ${currentState}`,
    previousState: existing.state,
    currentState,
  };

  states.set(key, { ...existing, state: currentState, firstSeen: Date.now() });
  return event;
}

/**
 * Convenience: observe a numeric metric and fire an event when thresholds are crossed.
 * `warn` and `crit` are the threshold values. Returns 0-2 events.
 */
export function observeThresholds(
  plugin: PluginId,
  resource: string,
  value: number,
  unit: string,
  warn: number,
  crit: number,
): AgentEvent[] {
  const events: AgentEvent[] = [];
  let severity: Severity = 'info';

  if (value >= crit) severity = 'critical';
  else if (value >= warn) severity = 'warning';

  const label = severity === 'critical' ? 'high' : severity === 'warning' ? 'elevated' : 'normal';
  const evt = observeState(plugin, resource, label, severity,
    `${resource} is ${value}${unit} (${label})`);
  if (evt) events.push(evt);

  return events;
}

/** Get all current tracked states (for debugging). */
export function getAllStates(): Map<string, StateEntry> {
  return new Map(states);
}

/** Clear all tracked states (e.g. on re-init). */
export function clearStates(): void {
  states.clear();
}
