'use strict';

/**
 * Express application: REST API, Swagger UI and the static HMI.
 *
 * Everything is served from a single port. Free hosting tiers expose exactly
 * one, so the plant HMI, the flow editor, the API and its documentation all
 * have to share it.
 */

const path = require('path');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');

const { buildRoutes } = require('./routes');
const { buildSpec } = require('./openapi');
const { mountSwagger } = require('./swagger');
const { requestOrigin } = require('./origin');
const { createDocsRouter } = require('../docs');
const middleware = require('./middleware');
const config = require('../config');

/**
 * @param {object} ctx application context
 * @param {object} [options]
 * @param {Function[]} [options.beforeApi] middleware run before every /api
 *   request - the serverless entry uses it to advance a frozen simulator
 * @returns {import('express').Express}
 */
function createApp(ctx, options = {}) {
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', true); // PaaS load balancers terminate TLS upstream

  app.use(helmet({
    // The HMI and Swagger UI are same-origin assets with inline bootstrapping,
    // and the Node-RED editor needs a much looser policy than helmet's default,
    // so CSP is configured explicitly rather than left at the default preset.
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'blob:'],
        connectSrc: ["'self'"],
        fontSrc: ["'self'", 'data:'],
        workerSrc: ["'self'", 'blob:'],
        frameAncestors: ["'self'"]
      }
    },
    // Swagger UI loads its own worker bundles; COEP would block them.
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' }
  }));

  app.use(cors({
    origin: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'x-api-key', 'Authorization', 'x-request-id'],
    exposedHeaders: ['x-request-id', 'Retry-After', 'RateLimit-Limit', 'RateLimit-Remaining']
  }));

  app.use(compression({
    // SSE must not be buffered by the compressor or events arrive in bursts.
    filter: (req, res) =>
      res.getHeader('Content-Type') !== 'text/event-stream' && compression.filter(req, res)
  }));

  app.use(express.json({ limit: '1mb' }));
  app.use(middleware.requestId);
  app.use(middleware.requestLogger);

  // ---- OpenAPI document ---------------------------------------------------
  // The server listed is the origin the document was requested from, so each
  // address the app answers on gets its own copy. Rebuilt per request in
  // development, so editing the spec is a refresh rather than a restart;
  // cached per origin in production, with the cache bounded because the Host
  // header is the client's to choose.
  const cachedSpecs = new Map();
  const spec = (req) => {
    const origin = requestOrigin(req);
    if (config.isProduction && cachedSpecs.has(origin)) return cachedSpecs.get(origin);
    const built = buildSpec({ origin });
    if (cachedSpecs.size >= 20) cachedSpecs.delete(cachedSpecs.keys().next().value);
    cachedSpecs.set(origin, built);
    return built;
  };

  app.get('/openapi.json', (req, res) => res.json(spec(req)));
  app.get('/api/v1/openapi.json', (req, res) => res.json(spec(req)));

  // ---- Swagger UI ---------------------------------------------------------
  mountSwagger(app);

  // ---- REST API -----------------------------------------------------------
  for (const fn of options.beforeApi || []) app.use('/api', fn);
  app.use('/api/v1', middleware.writeRateLimit, middleware.apiKeyAuth, buildRoutes(ctx));

  // Anything under /api that did not match is a 404 in JSON, not HTML.
  app.use('/api', middleware.notFound);

  return app;
}

/**
 * Mount the handlers that must come last: documentation, the static HMI, and
 * the terminal error handler.
 *
 * Express matches middleware in registration order and searches *forward* for
 * an error handler, so this cannot happen inside createApp(). The Node-RED
 * editor and its http-in routes are mounted between the two calls, and an
 * error handler registered before them would never see their errors.
 *
 * @param {import('express').Express} app
 */
function finalizeApp(app) {
  // Rendered, interactive documentation. A browser gets HTML; a client that
  // does not ask for HTML still gets the markdown at the same URL.
  app.use('/docs', createDocsRouter());

  app.use(express.static(path.join(config.rootDir, 'public'), {
    index: 'index.html',
    maxAge: config.isProduction ? '1h' : 0
  }));

  app.use(middleware.errorHandler);

  return app;
}

module.exports = { createApp, finalizeApp };
