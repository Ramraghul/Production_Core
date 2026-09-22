'use strict';

/**
 * The documentation set, in reading order.
 *
 * Each page gets an accent colour and an icon so the site is navigable at a
 * glance - and so a reader who lands on "Runbook" from a search can tell where
 * they are without reading the heading.
 */

const PAGES = Object.freeze([
  {
    slug: 'README', file: 'README.md', title: 'Overview',
    blurb: 'What this is, how to run it, and why it is not a toy.',
    colour: '#6366f1', icon: 'home'
  },
  {
    slug: 'ARCHITECTURE', file: 'docs/ARCHITECTURE.md', title: 'Architecture',
    blurb: 'The layering, the decisions behind it, and the trade-offs that went the other way.',
    colour: '#0ea5e9', icon: 'layers'
  },
  {
    slug: 'DOMAIN-MODEL', file: 'docs/DOMAIN-MODEL.md', title: 'Domain model',
    blurb: 'The plant, the entities and their state machines, and the ISO 22400 KPIs.',
    colour: '#10b981', icon: 'cube'
  },
  {
    slug: 'STATION-CONTROL', file: 'docs/STATION-CONTROL.md', title: 'Station control',
    blurb: 'Operator start and stop with lockout, maintenance orders and PM scheduling.',
    colour: '#d946ef', icon: 'wrench'
  },
  {
    slug: 'API', file: 'docs/API.md', title: 'REST API',
    blurb: 'Every endpoint with runnable examples against this instance.',
    colour: '#f59e0b', icon: 'plug'
  },
  {
    slug: 'FLOWS', file: 'docs/FLOWS.md', title: 'Node-RED flows',
    blurb: 'Flows as code, the thirteen tabs, and the seven custom nodes.',
    colour: '#ef4444', icon: 'flow'
  },
  {
    slug: 'DEPLOYMENT', file: 'docs/DEPLOYMENT.md', title: 'Deployment',
    blurb: 'Free-tier hosting, platform by platform, and the constraint that shapes it.',
    colour: '#8b5cf6', icon: 'cloud'
  },
  {
    slug: 'TESTING', file: 'docs/TESTING.md', title: 'Testing',
    blurb: 'What each test layer proves, and the bugs the tests caught.',
    colour: '#14b8a6', icon: 'check'
  },
  {
    slug: 'RUNBOOK', file: 'docs/RUNBOOK.md', title: 'Runbook',
    blurb: 'Operating it: health, failure modes and recovery.',
    colour: '#f97316', icon: 'terminal'
  }
]);

const BY_SLUG = new Map(PAGES.map((page) => [page.slug.toUpperCase(), page]));

/**
 * Find a page from a URL segment. Accepts `ARCHITECTURE`, `architecture`,
 * `ARCHITECTURE.md` and `README.md`, so every link style that exists in the
 * wild - including the ones in the markdown itself - lands somewhere.
 */
function findPage(segment) {
  if (!segment) return null;
  const key = String(segment).replace(/\.md$/i, '').toUpperCase();
  return BY_SLUG.get(key) || null;
}

/**
 * Repository files a reader may view from the docs, by prefix. Everything
 * else - node_modules, data/, a real .env - is refused. The docs link to the
 * code they describe, so the code has to be reachable; nothing more does.
 */
const SOURCE_PREFIXES = Object.freeze([
  'src/', 'api/', 'nodes/', 'flows/', 'tools/', 'scripts/', 'test/', 'public/', 'deploy/', '.github/', 'docs/'
]);

const SOURCE_FILES = Object.freeze([
  'README.md', 'package.json', 'Dockerfile', 'docker-compose.yml', 'render.yaml', 'fly.toml',
  'vercel.json', '.vercelignore',
  '.env.example', 'eslint.config.js', 'jest.config.js', '.dockerignore', '.gitignore', 'LICENSE'
]);

module.exports = { PAGES, findPage, SOURCE_PREFIXES, SOURCE_FILES };
