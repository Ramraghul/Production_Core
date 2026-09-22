#!/usr/bin/env node
'use strict';

/**
 * Build-time warm-up.
 *
 * Boots the whole application once during `docker build`, then stops it. Two
 * things come out of that:
 *
 *  1. **The build fails if the flows do not load.** A flow file that Node-RED
 *     rejects would otherwise ship happily and only reveal itself as an empty
 *     canvas on the deployed instance.
 *  2. **The Node-RED user directory is created and populated at build time**,
 *     including its palette cache (`.config.nodes.json`). The runtime container
 *     runs as an unprivileged user, so having that directory already exist and
 *     be owned correctly removes a class of permission failure at boot.
 *
 * Measured on this codebase a warm boot is ~1.1 s and a boot with an empty user
 * directory ~1.5 s, so the saving is modest - the build-time validation is the
 * real reason this exists.
 */

process.env.PC_LOG_LEVEL = 'warn';
process.env.PC_SEED_ON_BOOT = 'false';
process.env.PC_SIM_ENABLED = 'false';
process.env.PC_MQTT_ENABLED = 'false';
process.env.PC_STORE = 'memory';
// Port 0 lets the OS pick a free one, so a warm-up never collides with
// anything else running on the build host.
process.env.PORT = '0';

const { Server } = require('../src/server');

async function main() {
  const started = Date.now();
  const server = new Server({ context: { seed: false, autoSnapshot: false } });

  await server.start();
  const bootMs = Date.now() - started;

  const runtime = server.nodeRed?.status();
  await server.stop();

  process.stdout.write(
    `Warm-up complete in ${bootMs} ms - ` +
    `${runtime?.nodeCount ?? 0} flow nodes, Node-RED palette cached\n`
  );
  process.exit(0);
}

main().catch((error) => {
  // A failed warm-up must not fail the image build; the runtime will simply
  // pay the scan cost on first boot.
  process.stderr.write(`Warm-up skipped: ${error.message}\n`);
  process.exit(0);
});
