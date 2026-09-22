#!/usr/bin/env node
'use strict';

/**
 * Run the Vercel deployment locally, without a Vercel account.
 *
 *   npm run start:serverless          # http://localhost:3000
 *
 * Reproduces the parts of Vercel's routing this app relies on, in the same
 * order: static files first (public/, plus the Swagger UI the build step
 * writes), then the vercel.json rewrites, then the single function in
 * api/index.js. What you see here is what the deployment serves - no Node-RED,
 * no MQTT, a simulator advanced by requests.
 *
 * `vercel dev` is the official equivalent and needs the CLI and a login.
 */

process.env.VERCEL = process.env.VERCEL || '1';

const os = require('os');
const path = require('path');
const express = require('express');

const { buildStatic } = require('./vercel-build');

const ROOT = path.resolve(__dirname, '..');
const port = Number(process.env.PORT || 3000);

// The build output goes to a temp directory rather than public/, so running
// this leaves the working tree as it was.
const { outDir } = buildStatic(path.join(os.tmpdir(), 'production-core-vercel', 'api-docs'));
const handler = require('../api');

const edge = express();
edge.get('/api-docs', (_req, res) => res.sendFile(path.join(outDir, 'index.html')));
edge.use('/api-docs', express.static(outDir));
edge.use(express.static(path.join(ROOT, 'public')));
edge.use((req, res) => handler(req, res));

edge.listen(port, () => {
  process.stdout.write([
    '',
    '  Production Core - serverless (Vercel) mode, locally',
    `  Plant HMI    http://localhost:${port}/`,
    `  Swagger UI   http://localhost:${port}/api-docs`,
    `  Docs         http://localhost:${port}/docs`,
    '  Node-RED and MQTT are not part of this deployment shape.',
    ''
  ].join('\n'));
});
