'use strict';

/**
 * Composition root for serverless hosts (Vercel).
 *
 * The same application as src/server.js, minus the parts that need a
 * long-running process:
 *
 *   kept      REST API, Swagger UI, plant HMI, docs site, SSE, the simulator
 *   dropped   Node-RED (a runtime with its own event loop and editor) and the
 *             MQTT broker (a TCP listener) - a function has neither
 *
 * Nothing listens on a port: the platform calls the exported Express app once
 * per request. The instance is frozen between requests, so the simulator's
 * timer only runs while a request is in flight; each API request first replays
 * the ticks it missed (see Simulator#catchUp).
 *
 * State lives in this instance's memory. It is reseeded, deterministically, on
 * every cold start, and two concurrent instances do not share it - the same
 * trade-off the free Render deployment makes, for the same reason.
 */

const { createContext } = require('./services');
const { createApp, finalizeApp } = require('./api/app');
const { Simulator } = require('./simulator');
const config = require('./config');
const { createLogger } = require('./logger');

const log = createLogger('serverless');

/** Paths served only by the full runtime. */
const FULL_RUNTIME_PATHS = Object.freeze([
  config.nodeRed.httpAdminRoot, // /red - the flow editor
  config.nodeRed.httpNodeRoot, // /factory - endpoints served by the flows
  config.mqtt.wsPath // /mqtt - MQTT over WebSocket
]);

/**
 * Answer a request for something only the full runtime serves.
 *
 * With PC_FULL_RUNTIME_URL set (say, the Render deployment) the visitor is
 * sent there; otherwise they get an explanation rather than a bare 404, since
 * the HMI and the docs link to these paths.
 */
function fullRuntimeOnly(req, res) {
  const target = config.runtime.fullRuntimeUrl;
  if (target) return res.redirect(302, `${target}${req.originalUrl}`);

  const message = `${req.originalUrl.split('?')[0]} is served by the full runtime - Node-RED and the ` +
    'MQTT broker need a long-running process, which a serverless function is not. ' +
    'Run it locally with `npm start`, or deploy the Docker image (Render, Fly.io).';

  res.status(404);
  if (!req.accepts('html')) {
    return res.json({ error: { code: 'NOT_ON_SERVERLESS', message } });
  }
  return res.type('html').send(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light dark">
<title>Full runtime only</title>
<style>:root{--bg:#f8fafc;--fg:#1e293b;--code:#e2e8f0;--link:#2563eb}
@media (prefers-color-scheme: dark){:root{--bg:#0b1120;--fg:#e2e8f0;--code:#1e293b;--link:#60a5fa}}
body{background:var(--bg);color:var(--fg);font:16px/1.6 system-ui,sans-serif;max-width:620px;margin:12vh auto;padding:0 16px}
code{background:var(--code);padding:1px 6px;border-radius:4px}a{color:var(--link)}</style></head><body>
<h1>Not on this deployment</h1><p>${message.replace(/`([^`]+)`/g, '<code>$1</code>')}</p>
<p><a href="/">Plant HMI</a> &middot; <a href="/api-docs">API</a> &middot;
<a href="/docs/DEPLOYMENT">Deployment guide</a></p></body></html>`);
}

/**
 * Build the request handler.
 *
 * @param {object} [options]
 * @param {object} [options.context]   passed to createContext (tests skip seeding)
 * @param {boolean} [options.simulate] start the simulator (default: config)
 * @returns {import('express').Express} an Express app, which is a (req, res) handler
 */
function createServerlessApp(options = {}) {
  const begunAt = Date.now();
  // Nothing to snapshot to: the filesystem is read-only apart from /tmp, and
  // /tmp does not outlive the instance.
  const ctx = createContext({ autoSnapshot: false, ...options.context });

  const simulate = options.simulate ?? (config.simulator.enabled && config.simulator.autoStart);
  if (config.simulator.enabled) {
    ctx.simulator = new Simulator(ctx);
    if (simulate) ctx.simulator.start();
  }

  const catchUp = (_req, _res, next) => {
    ctx.simulator?.catchUp(config.simulator.catchUpSeconds);
    next();
  };

  const app = createApp(ctx, { beforeApi: [catchUp] });
  for (const path of FULL_RUNTIME_PATHS) app.use(path, fullRuntimeOnly);
  finalizeApp(app);

  // Tests and callers that need the context (to stop the simulator, say) can
  // reach it without a second composition root.
  app.locals.ctx = ctx;

  log.info('serverless app ready', {
    ms: Date.now() - begunAt,
    units: ctx.repository.count('units'),
    simulator: Boolean(ctx.simulator?.running)
  });
  return app;
}

module.exports = { createServerlessApp, FULL_RUNTIME_PATHS };
