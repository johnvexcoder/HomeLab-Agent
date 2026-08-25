import { loadConfig } from './core/config.js';
import { setLogLevel, log } from './core/logger.js';
import { detectHost } from './core/detection.js';
import { setHostRootPath } from './core/host.js';
import { initPlugins } from './core/registry.js';
import { Agent } from './core/agent.js';
import { registerAllPlugins } from './plugins/index.js';

const VERSION = '2.0.0';

async function main() {
  console.log(`
  ╔═══════════════════════════════════════╗
  ║   HomeLab Agent v${VERSION}              ║
  ║   Modular Plugin-Based Architecture   ║
  ╚═══════════════════════════════════════╝
`);

  const config = loadConfig();
  setHostRootPath(config.hostRoot);
  setLogLevel(config.logLevel);

  log.info('main', `Dashboard: ${config.dashboardUrl}`);
  log.info('main', `Poll interval: ${config.pollInterval}ms`);

  // Register all plugins before detection
  registerAllPlugins();

  // Detect environment and host info
  const hostInfo = await detectHost(config.hostId, config.hostName);

  // Initialize plugins (detect + enable/disable)
  await initPlugins({
    hostId: hostInfo.hostId,
    hostName: hostInfo.hostName,
    dockerSocket: config.dockerSocket,
  });

  // Start the agent
  const agent = new Agent(config);

  // Graceful shutdown
  const shutdown = async () => {
    log.info('main', 'Shutting down...');
    await agent.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());

  await agent.start(hostInfo);
}

main().catch((err) => {
  console.error('[FATAL]', err);
  process.exit(1);
});
