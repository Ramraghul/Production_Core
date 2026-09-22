'use strict';

/**
 * Swagger UI, self-hosted from the swagger-ui-dist package.
 *
 * Nothing is loaded from a CDN: the page, its stylesheet and its bundles are
 * served by this application at /api-docs. On a server, Express serves them
 * straight out of node_modules. On Vercel, `scripts/vercel-build.js` copies the
 * same files into public/api-docs/ at build time, so the platform's CDN serves
 * them directly - a serverless function does not carry swagger-ui-dist's
 * asset files unless told to, which is the usual cause of an unstyled or blank
 * Swagger page on Vercel.
 */

const express = require('express');
const config = require('../config');
const { createLogger } = require('../logger');

const log = createLogger('api');

/** The key published in this repository, safe to show on the page. */
const DEMO_API_KEY = 'production-core-demo-key';

/** The swagger-ui-dist files the page needs. */
const SWAGGER_ASSETS = Object.freeze([
  'swagger-ui.css',
  'swagger-ui-bundle.js',
  'swagger-ui-standalone-preset.js'
]);

/** Absolute path of the installed swagger-ui-dist, or null. */
function swaggerAssetsPath() {
  try {
    return require('swagger-ui-dist').getAbsoluteFSPath();
  } catch (_error) {
    return null;
  }
}

/**
 * The Swagger UI page.
 *
 * The package ships an `index.html` wired to Swagger's petstore demo, so it is
 * replaced with this initialiser rather than patched at runtime. Asset paths
 * are absolute: the page is served at both `/api-docs` and `/api-docs/`, and a
 * relative `./swagger-ui.css` resolves against the former as though it were a
 * file - landing on `/swagger-ui.css` at the site root, where nothing serves it.
 *
 * @param {object} [options]
 * @param {boolean} [options.nodeRed] link the flow editor (absent on serverless)
 */
function swaggerPage({ nodeRed = config.nodeRed.enabled || Boolean(config.runtime.fullRuntimeUrl) } = {}) {
  // Only the published demo key is printed. A deployment that sets its own
  // PC_API_KEY keeps it private, and the page just says a key is needed.
  const keyHint = config.security.apiKey === DEMO_API_KEY
    ? `writes need the demo key <code>${DEMO_API_KEY}</code> under <b>Authorize</b>`
    : 'writes need an API key under <b>Authorize</b>';
  return `<!doctype html>
<html lang="en">file
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Production Core API - Vehicle Assembly MES</title>
  <link rel="stylesheet" href="/api-docs/swagger-ui.css">
  <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>&#127981;</text></svg>">
  <style>
    body { margin: 0; background: #fafafa; }
    .topbar { display: none; }
    .pc-banner {
      background: linear-gradient(135deg, #0f2942 0%, #1c4f7c 100%);
      color: #fff; padding: 18px 24px; font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
    }
    .pc-banner h1 { margin: 0 0 4px; font-size: 19px; font-weight: 600; letter-spacing: -0.2px; }
    .pc-banner p { margin: 0; font-size: 13px; opacity: 0.85; }
    .pc-banner a { color: #7ec8ff; text-decoration: none; margin-right: 16px; font-size: 13px; }
    .pc-banner a:hover { text-decoration: underline; }
    .pc-banner code { background: rgba(255,255,255,0.12); padding: 1px 6px; border-radius: 4px; font-size: 12px; }
    .pc-links { margin-top: 10px; }
    .swagger-ui .info { margin: 24px 0; }
  </style>
</head>
<body>
  <div class="pc-banner">
    <h1>Production Core &mdash; Vehicle Assembly MES API</h1>
    <p>NorthStar Motors &middot; Windsor Assembly Plant, Ontario &middot; built on Node-RED.
      Reads are open; ${keyHint}.</p>
    <div class="pc-links">
      <a href="/">&#8592; Plant HMI</a>
      ${nodeRed ? '<a href="/red" target="_blank" rel="noopener">Node-RED flows</a>' : ''}
      <a href="/openapi.json">openapi.json</a>
      <a href="/docs/API">API guide</a>
      <a href="/docs/ARCHITECTURE">Architecture</a>
    </div>
  </div>
  <div id="swagger-ui"></div>
  <script src="/api-docs/swagger-ui-bundle.js"></script>
  <script src="/api-docs/swagger-ui-standalone-preset.js"></script>
  <script>
    window.ui = SwaggerUIBundle({
      url: '/openapi.json',
      dom_id: '#swagger-ui',
      deepLinking: true,
      docExpansion: 'none',
      defaultModelsExpandDepth: 0,
      filter: true,
      tryItOutEnabled: true,
      persistAuthorization: true,
      displayRequestDuration: true,
      presets: [SwaggerUIBundle.presets.apis, SwaggerUIStandalonePreset],
      plugins: [SwaggerUIBundle.plugins.DownloadUrl],
      layout: 'StandaloneLayout'
    });
  </script>
</body>
</html>`;
}

/** Serve Swagger UI at /api-docs. */
function mountSwagger(app) {
  const distPath = swaggerAssetsPath();
  if (!distPath) {
    log.warn('swagger-ui-dist is not installed; /api-docs will not be available');
    app.get('/api-docs', (_req, res) =>
      res.status(503).type('text/plain').send(
        'Swagger UI is not installed. Run `npm install` and restart.\n' +
        'The raw specification is still available at /openapi.json'
      ));
    return;
  }

  // Our page must win over the bundled index.html, so it is registered first.
  const page = swaggerPage();
  app.get(['/api-docs', '/api-docs/', '/api-docs/index.html'], (_req, res) =>
    res.type('html').send(page));

  app.use('/api-docs', express.static(distPath, { index: false }));

  log.info('swagger ui mounted', { path: '/api-docs' });
}

module.exports = { mountSwagger, swaggerPage, swaggerAssetsPath, SWAGGER_ASSETS };
