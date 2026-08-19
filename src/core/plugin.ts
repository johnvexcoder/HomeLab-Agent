import type { PluginMeta, PluginData, AgentEvent, CollectedMetrics } from '../types/index.js';

/**
 * Shared context passed to all plugins at init time.
 * Read-only. Plugins must never mutate this.
 */
export interface PluginContext {
  hostId: string;
  hostName: string;
  dockerSocket: string;
}

/**
 * Abstract base class for all plugins.
 *
 * RULES:
 *   - Plugins ONLY collect, normalize, and publish data.
 *   - Plugins NEVER do HTTP requests, authenticate, manage sessions,
 *     retry network calls, or maintain WebSocket connections.
 *   - Those responsibilities belong exclusively to the Agent Core.
 *   - Plugins NEVER communicate with each other.
 */
export abstract class Plugin {
  abstract meta: PluginMeta;
  protected ctx!: PluginContext;
  protected enabled = false;

  /** Called once at startup with read-only context. */
  init(ctx: PluginContext): void {
    this.ctx = ctx;
  }

  /**
   * Detect whether this plugin can run on this system.
   * Called once at startup. Must be fast and non-destructive.
   */
  abstract detect(): Promise<boolean>;

  /**
   * Collect all metrics for this plugin.
   * The agent core schedules this at `meta.recommendedPollMs`.
   * The result is published to the shared metric cache.
   */
  abstract collect(): Promise<CollectedMetrics>;

  /**
   * Check for state-change events.
   * The agent core schedules this at `meta.recommendedEventMs`.
   * Return only NEW events (state changes since last check).
   */
  abstract checkEvents(): Promise<AgentEvent[]>;

  isEnabled(): boolean {
    return this.enabled;
  }

  setEnabled(v: boolean): void {
    this.enabled = v;
  }

  /** Wrap raw metrics into a PluginData envelope for the cache/report. */
  wrapData(data: CollectedMetrics): PluginData {
    return {
      plugin: this.meta.id,
      collectedAt: Date.now(),
      data,
    };
  }
}
