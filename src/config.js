'use strict';

/**
 * Central configuration.
 *
 * Every setting resolves in this order:  process.env  ->  documented default.
 * The defaults are chosen so that `node src/index.js` works on a clean checkout
 * with no .env file and no external services (no broker, no database).
 */

const path = require('path');

try {
  // Optional: .env is a convenience for local development, never required.
  // `quiet` suppresses dotenv's startup banner so our own structured log is
  // the first thing on stdout.
  require('dotenv').config({ quiet: true });
} catch (_err) {
  /* dotenv not installed - defaults still apply */
}

const bool = (value, fallback) => {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
};

const int = (value, fallback) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const rootDir = path.resolve(__dirname, '..');

// Serverless hosts (Vercel) run the app as a request-scoped function: no
// long-lived process, no TCP listeners, a read-only filesystem. Everything that
// needs those - Node-RED, the MQTT broker, the file store - defaults off there,
// and the simulator is advanced by requests instead of by a timer alone.
const serverless = bool(process.env.PC_SERVERLESS, Boolean(process.env.VERCEL));
const isTest = (process.env.NODE_ENV || 'development') === 'test';

// Vercel exposes the production domain without a scheme.
const vercelUrl = process.env.VERCEL_PROJECT_PRODUCTION_URL
  ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
  : '';

const config = {
  rootDir,
  env: process.env.NODE_ENV || 'development',
  isProduction: (process.env.NODE_ENV || 'development') === 'production',
  isTest,

  runtime: {
    serverless,
    // Where the full runtime (Node-RED, MQTT) is hosted, if anywhere. A
    // serverless deployment redirects /red and /factory there instead of 404.
    fullRuntimeUrl: (process.env.PC_FULL_RUNTIME_URL || '').replace(/\/+$/, '')
  },

  http: {
    // Free PaaS providers (Render, Koyeb, Railway, Hugging Face) inject PORT.
    port: int(process.env.PORT, 1880),
    host: process.env.HOST || '0.0.0.0',
    // Public base URL, used only to render absolute links in the OpenAPI spec.
    publicUrl: process.env.PC_PUBLIC_URL || vercelUrl,
    // A serverless function has a maximum duration, so the live event stream
    // ends itself before the platform kills it, and the browser's EventSource
    // reconnects. 0 = stream until the client leaves.
    sseMaxSeconds: int(process.env.PC_SSE_MAX_SECONDS, serverless ? 50 : 0)
  },

  site: {
    enterprise: 'NorthStar Motors',
    id: process.env.PC_SITE_ID || 'WIN',
    name: 'Windsor Assembly Plant',
    location: 'Windsor, Ontario, Canada',
    timezone: process.env.PC_TZ || 'America/Toronto',
    plantCode: 'W'
  },

  security: {
    apiKey: process.env.PC_API_KEY || 'production-core-demo-key',
    // Reads are public so the hosted demo is browsable without a key.
    protectReads: bool(process.env.PC_PROTECT_READS, false),
    editorUser: process.env.PC_EDITOR_USER || '',
    editorPassword: process.env.PC_EDITOR_PASSWORD || '',
    editorReadOnly: bool(process.env.PC_EDITOR_READONLY, false),
    // The demo API key is public, so writes are rate-limited per client IP.
    // 0 disables the limit (the test suites make hundreds of writes).
    writesPerMinute: int(process.env.PC_RATE_LIMIT_WRITES, isTest ? 0 : 120)
  },

  mqtt: {
    enabled: bool(process.env.PC_MQTT_ENABLED, !serverless),
    port: int(process.env.PC_MQTT_PORT, 1883),
    host: process.env.PC_MQTT_HOST || '127.0.0.1',
    // MQTT-over-WebSocket rides the HTTP port, so PaaS hosts that expose a
    // single TCP port still get working pub/sub.
    wsEnabled: bool(process.env.PC_MQTT_WS_ENABLED, true),
    wsPath: '/mqtt',
    topicRoot: process.env.PC_MQTT_ROOT || 'northstar'
  },

  operations: {
    // ISO 22400 separates availability loss (a real stoppage) from performance
    // loss (idling and minor stops). A station that is blocked for four seconds
    // while the one downstream finishes is a micro-stop, not a breakdown, and
    // recording it as downtime buries the real failures in noise. Stops shorter
    // than this are discarded rather than logged; they still depress the
    // performance factor, which is where ISO 22400 says they belong.
    minDowntimeSeconds: int(process.env.PC_MIN_DOWNTIME_SECONDS, 60)
  },

  store: {
    driver: (process.env.PC_STORE || (serverless ? 'memory' : 'file')).toLowerCase(), // memory | file
    dataDir: path.resolve(rootDir, process.env.PC_DATA_DIR || './data'),
    snapshotIntervalMs: int(process.env.PC_SNAPSHOT_INTERVAL_MS, 15000),
    // Ring-buffer caps keep memory flat on a free 512 MB instance.
    maxEvents: int(process.env.PC_MAX_EVENTS, 20000),
    maxTelemetry: int(process.env.PC_MAX_TELEMETRY, 10000)
  },

  simulator: {
    enabled: bool(process.env.PC_SIM_ENABLED, true),
    autoStart: bool(process.env.PC_SIM_AUTOSTART, true),
    // Time compression factor. Defaults to 1 - real time - because the KPI
    // engine measures over WALL-CLOCK windows. At speed 30 the plant completes
    // a 60 s takt every 2 s but still stamps wall-clock timestamps, so a
    // station reports 30 s cycles against a 60 s ideal, throughput reads about
    // twice its physical maximum, and OEE pins at 100% behind the performance
    // cap. Real time keeps the numbers internally consistent, and with 43
    // stations the plant is lively enough to watch anyway.
    //
    // Raising this is supported and useful for fast-forwarding; the dashboard
    // then flags the figures as compressed rather than presenting them as real.
    speed: int(process.env.PC_SIM_SPEED, 1),
    seed: int(process.env.PC_SIM_SEED, 20260916),
    faults: bool(process.env.PC_SIM_FAULTS, true),
    tickMs: int(process.env.PC_SIM_TICK_MS, 250),
    // On a public demo anyone can press Stop. The simulator plays the plant's
    // people, so it restarts an operator stop after this many minutes and has
    // its technicians sign maintenance off once the planned time has run.
    // 0 disables both, which is what you want when driving the plant by hand.
    autoReleaseMinutes: int(process.env.PC_SIM_AUTO_RELEASE_MINUTES, 15),
    // A serverless instance is frozen between requests, so its timer stops.
    // Each API request first replays the ticks it missed, up to this many
    // seconds; a longer gap is skipped, as a plant would sit idle. 0 = off.
    catchUpSeconds: int(process.env.PC_SIM_CATCH_UP_SECONDS, serverless ? 30 : 0)
  },

  seed: {
    onBoot: bool(process.env.PC_SEED_ON_BOOT, true),
    // Shifts backfilled with full per-vehicle detail (genealogy, defects,
    // station history). Each shift is ~375 vehicles and ~14 MB of heap, so
    // 3 is comfortable inside a 512 MB free-tier instance.
    detailShifts: int(process.env.PC_SEED_SHIFTS, 3),
    // Older shifts are stored as aggregate KPI rows only - the same hot/cold
    // split a real MES uses before flushing to a historian.
    days: int(process.env.PC_SEED_DAYS, 3),
    // Drives how many vehicles the backfill produces per shift, so the seeded
    // OEE lands in a plausible band instead of an implausible 100%.
    targetOee: Number(process.env.PC_SEED_TARGET_OEE || 0.78)
  },

  nodeRed: {
    enabled: bool(process.env.PC_NODERED_ENABLED, !serverless),
    httpAdminRoot: '/red',
    httpNodeRoot: '/factory',
    userDir: path.resolve(rootDir, process.env.PC_NODERED_USER_DIR || './data/.node-red'),
    flowFile: path.resolve(rootDir, 'flows', 'flows.json'),
    nodesDir: path.resolve(rootDir, 'nodes')
  },

  logging: {
    level: process.env.PC_LOG_LEVEL || (process.env.NODE_ENV === 'test' ? 'silent' : 'info')
  }
};

module.exports = config;
