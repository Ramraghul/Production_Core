'use strict';

/**
 * Vercel entry point.
 *
 * Vercel deploys every file in api/ as a function. vercel.json rewrites every
 * request that is not a static file in public/ to this one, and an Express app
 * is itself a (req, res) handler, so the whole application - API, Swagger,
 * HMI routes, docs - runs behind a single function.
 *
 * The app is built once per instance, at module load: the plant is seeded
 * during the cold start, and warm requests reuse it.
 */

const { createServerlessApp } = require('../src/serverless');

module.exports = createServerlessApp();
