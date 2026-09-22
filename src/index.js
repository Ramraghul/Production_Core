#!/usr/bin/env node
'use strict';

/**
 * Entry point.
 *
 * Starts the server and installs signal handlers so a container stop drains
 * cleanly rather than losing the last few seconds of production data.
 */

const { Server } = require('./server');
const { createLogger } = require('./logger');

const log = createLogger('main');

async function main() {
  const server = new Server();

  // A failure during boot is fatal and must surface with a non-zero exit code,
  // or a PaaS host will keep the broken container in rotation.
  try {
    await server.start();
  } catch (error) {
    log.error('failed to start', { error: error.message, stack: error.stack });
    process.exitCode = 1;
    return;
  }

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info('signal received', { signal });

    // Never hang a container on a stuck shutdown; the orchestrator will SIGKILL
    // us anyway, and doing it ourselves at least runs the exit handlers.
    const timer = setTimeout(() => {
      log.warn('shutdown timed out, forcing exit');
      process.exit(1);
    }, 10000);
    timer.unref();

    try {
      await server.stop();
      clearTimeout(timer);
      process.exit(0);
    } catch (error) {
      log.error('error during shutdown', { error: error.message });
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  process.on('unhandledRejection', (reason) => {
    log.error('unhandled promise rejection', {
      reason: reason?.message || String(reason),
      stack: reason?.stack?.split('\n').slice(0, 3).join(' | ')
    });
  });

  process.on('uncaughtException', (error) => {
    log.error('uncaught exception', { error: error.message, stack: error.stack });
    shutdown('uncaughtException');
  });
}

main();
