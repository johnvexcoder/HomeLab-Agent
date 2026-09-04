import type { AgentConfig } from './config.js';
import type { HostInfo, AgentReport, AgentEvent, PluginData } from '../types/index.js';
import { log } from './logger.js';
import { cacheGetAll } from './cache.js';
import { registerAgent, reportMetrics, reportEvents } from './api.js';
import { collectDue, checkEventsDue, getCapabilities } from './registry.js';
import { loadEventQueue, saveEventQueue } from './event-queue.js';

const AGENT_VERSION = '2.0.0';

/**
 * The Agent Core orchestrates everything.
 *
 * RULES:
 *   - Only the agent core does HTTP, auth, WebSocket, retries.
 *   - Plugins only collect data. The core schedules them.
 *   - Per-plugin poll scheduling: each plugin runs at its own interval.
 *   - Reports include capabilities so the backend knows what data is available.
 */
export class Agent {
  private config: AgentConfig;
  private hostInfo!: HostInfo;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private eventTimer: ReturnType<typeof setInterval> | null = null;
  private pendingEvents: AgentEvent[] = [];
  private registered = false;
  private pollRunning = false;
  private eventRunning = false;
  private reportFailures = 0;
  private nextReportAt = 0;

  constructor(config: AgentConfig) {
    this.config = config;
  }

  async start(hostInfo: HostInfo): Promise<void> {
    this.hostInfo = hostInfo;
    this.pendingEvents = (await loadEventQueue(this.config.stateDir)).slice(-500);
    if (this.pendingEvents.length > 0) {
      log.info('events', `Recovered ${this.pendingEvents.length} queued event(s) from disk`);
    }

    // Initial collection + registration
    const report = await this.buildReport();
    this.registered = await registerAgent(this.config, report);
    if (this.registered) {
      log.info('agent', 'Registration successful');
    } else {
      log.warn('agent', 'Registration failed — will retry on next report');
    }

    // Send initial report via poll cycle
    await this.pollCycle();

    // Start polling — the global tick triggers per-plugin scheduling
    // Fastest tick = 1s (for CPU/memory plugins). Slower plugins skip ticks.
    const fastestPoll = 1000;
    this.pollTimer = setInterval(() => void this.pollCycle(), fastestPoll);
    this.eventTimer = setInterval(() => void this.eventCycle(), this.config.eventCheckInterval);

    const caps = getCapabilities();
    log.info('agent', `Capabilities: [${caps.join(', ')}]`);
    log.info('agent', `Event check interval: ${this.config.eventCheckInterval}ms`);
    log.info('agent', 'Agent running. Press Ctrl+C to stop.');
  }

  async stop(): Promise<void> {
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.eventTimer) clearInterval(this.eventTimer);
    await saveEventQueue(this.config.stateDir, this.pendingEvents);
    log.info('agent', 'Agent stopped');
  }

  /**
   * Poll cycle: collect from plugins whose interval has elapsed.
   * Only changed data is sent to the backend (delta reporting).
   * The shared cache is updated internally by the registry.
   */
  private async pollCycle(): Promise<void> {
    if (this.pollRunning) return;
    this.pollRunning = true;
    try {
      const freshlyCollected = await collectDue();
      if (freshlyCollected.length === 0) return; // no plugin was due

      // Build a delta report — only freshly collected data
      const report = this.buildDeltaReport(freshlyCollected);

      if (Date.now() < this.nextReportAt) return;

      if (!this.registered) {
        this.registered = await registerAgent(this.config, report);
      }

      const ok = await reportMetrics(this.config, report);
      if (ok) {
        this.reportFailures = 0;
        this.nextReportAt = 0;
        log.debug('agent', `Reported ${freshlyCollected.length} plugin(s): ${freshlyCollected.map((p) => p.plugin).join(', ')}`);
      } else {
        this.scheduleReportRetry();
      }
    } catch (err) {
      this.scheduleReportRetry();
      log.error('agent', `Poll cycle failed: ${(err as Error).message}`);
    } finally {
      this.pollRunning = false;
    }
  }

  /**
   * Event cycle: check for state changes across all plugins.
   * Events are accumulated and flushed periodically.
   */
  private async eventCycle(): Promise<void> {
    if (this.eventRunning) return;
    this.eventRunning = true;
    try {
      const events = await checkEventsDue();
      if (events.length > 0) {
        this.pendingEvents.push(...events);
        if (this.pendingEvents.length > 500) {
          log.warn('events', 'Event queue exceeded maximum bounds, dropping oldest events');
          this.pendingEvents = this.pendingEvents.slice(-500);
        }
        await saveEventQueue(this.config.stateDir, this.pendingEvents);
        log.info('events', `${events.length} new event(s): ${events.map((e) => e.message).join('; ')}`);
      }

      // Flush accumulated events
      if (this.pendingEvents.length > 0) {
        // Peek at the batch without removing them yet
        const batch = this.pendingEvents.slice(0, this.config.maxEventsPerReport);
        const ok = await reportEvents(this.config, this.hostInfo.hostId, batch);
        if (ok) {
          // Success: remove acknowledged events
          this.pendingEvents.splice(0, batch.length);
          await saveEventQueue(this.config.stateDir, this.pendingEvents);
        } else {
          log.warn('events', `Failed to deliver ${batch.length} event(s), retaining in queue (size: ${this.pendingEvents.length})`);
          // Ensure queue does not grow infinitely during a long outage
        }
      }
    } catch (err) {
      log.error('events', `Event cycle failed: ${(err as Error).message}`);
    } finally {
      this.eventRunning = false;
    }
  }

  private scheduleReportRetry(): void {
    this.reportFailures = Math.min(this.reportFailures + 1, 10);
    const baseMs = Math.min(300_000, 1_000 * 2 ** (this.reportFailures - 1));
    const jitterMs = Math.floor(Math.random() * Math.max(250, baseMs * 0.2));
    this.nextReportAt = Date.now() + baseMs + jitterMs;
    log.warn('agent', `Dashboard reporting paused for ${Math.ceil((baseMs + jitterMs) / 1000)}s after ${this.reportFailures} consecutive failure(s)`);
  }

  /**
   * Build a full report (used for registration and initial report).
   * Includes all cached data + all capabilities.
   */
  private async buildReport(): Promise<AgentReport> {
    // Trigger an immediate collection of all due plugins
    await collectDue();

    return {
      hostInfo: this.hostInfo,
      capabilities: getCapabilities(),
      plugins: cacheGetAll(),
      events: [],
      reportedAt: Date.now(),
      agentVersion: AGENT_VERSION,
    };
  }

  /**
   * Build a delta report — only freshly collected plugins.
   * The backend merges deltas into its view of the agent.
   */
  private buildDeltaReport(freshPlugins: PluginData[]): AgentReport {
    return {
      hostInfo: this.hostInfo,
      capabilities: getCapabilities(),
      plugins: freshPlugins,
      events: [],
      reportedAt: Date.now(),
      agentVersion: AGENT_VERSION,
    };
  }
}
