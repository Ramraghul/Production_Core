#!/usr/bin/env node
'use strict';

/**
 * Vercel build step: put Swagger UI into public/ so the CDN serves it.
 *
 * On a server, Express serves /api-docs straight out of node_modules. On
 * Vercel, only the function's traced files exist at runtime, and
 * swagger-ui-dist's stylesheet and bundles are read from disk rather than
 * required - so they are not traced, and a Swagger page served by the function
 * comes up blank or unstyled. Copying them into public/api-docs/ at build time
 * makes them plain static files: faster, cached at the edge, and independent
 * of the function entirely.
 *
 *   node scripts/vercel-build.js [outDir]    (default: public/api-docs)
 *
 * The output is generated, so it is git-ignored.
 */

const fs = require('fs');
const path = require('path');

const { swaggerPage, swaggerAssetsPath, SWAGGER_ASSETS } = require('../src/api/swagger');

function buildStatic(outDir = path.resolve(__dirname, '..', 'public', 'api-docs')) {
  const distPath = swaggerAssetsPath();
  if (!distPath) throw new Error('swagger-ui-dist is not installed - run npm install first');

  fs.mkdirSync(outDir, { recursive: true });
  for (const file of SWAGGER_ASSETS) {
    fs.copyFileSync(path.join(distPath, file), path.join(outDir, file));
  }
  fs.writeFileSync(path.join(outDir, 'index.html'), swaggerPage());

  return { outDir, files: [...SWAGGER_ASSETS, 'index.html'] };
}

if (require.main === module) {
  const { outDir, files } = buildStatic(process.argv[2] && path.resolve(process.argv[2]));
  console.log(`Swagger UI written to ${path.relative(process.cwd(), outDir) || '.'}: ${files.join(', ')}`);
}

module.exports = { buildStatic };
