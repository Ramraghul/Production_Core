'use strict';

/**
 * The documentation site, served at /docs.
 *
 *   /docs                     -> the overview
 *   /docs/ARCHITECTURE        a rendered page (also accepts ARCHITECTURE.md)
 *   /docs/raw/ARCHITECTURE    the markdown itself
 *   /docs/source/<path>       a repository file, highlighted, with line anchors
 *   /docs/search-index.json   headings of every page, for the search box
 *
 * A browser asking for `/docs/ARCHITECTURE.md` gets the rendered page; a
 * client that does not ask for HTML (curl, a script) gets the markdown. The
 * same URL therefore works for a reader and for a tool.
 */

const fs = require('fs');
const path = require('path');
const express = require('express');

const { PAGES, findPage } = require('./catalogue');
const { renderMarkdown, highlight, escapeHtml, isViewableSource } = require('./renderer');
const { layout, pageBody, sourceBody, directoryBody, notFoundBody } = require('./template');
const { requestOrigin, isLocalOrigin } = require('../api/origin');
const config = require('../config');

const ROOT = config.rootDir;

/** Rendered pages, keyed by slug and invalidated by file mtime. */
const cache = new Map();

function loadPage(page) {
  const file = path.join(ROOT, page.file);
  const stat = fs.statSync(file);
  const cached = cache.get(page.slug);
  if (cached && cached.mtimeMs === stat.mtimeMs) return cached;

  const source = fs.readFileSync(file, 'utf8');
  const rendered = renderMarkdown(source, page.file);
  const entry = { ...rendered, source, mtimeMs: stat.mtimeMs, updatedAt: stat.mtime };
  cache.set(page.slug, entry);
  return entry;
}

/**
 * Point the examples at the address the reader is on.
 *
 * The markdown is written for someone running the app locally, so its curl
 * examples say `localhost:1880`. Read on the live site, they should say the
 * live URL - a visitor copying an example should hit the instance they are
 * looking at, not one that is not running on their machine. Only code blocks
 * are touched: prose such as "run npm start, then open localhost:1880" is a
 * local-run instruction and stays one. Other ports (MQTT on 1883, the local
 * serverless preview on 3000) are local by nature and are left alone.
 */
function retargetExamples(html, origin) {
  if (isLocalOrigin(origin)) return html;
  return html.replace(/<pre[\s\S]*?<\/pre>/g, (block) =>
    block.replace(/(?:https?:\/\/)?localhost:1880/g, origin));
}

/** True when the client wants a page rather than the raw markdown. */
const wantsHtml = (req) =>
  req.query.format !== 'md' && (req.get('accept') || '').includes('text/html');

const LANGUAGE_BY_EXTENSION = {
  '.js': 'javascript', '.json': 'json', '.md': 'markdown', '.yml': 'yaml', '.yaml': 'yaml',
  '.html': 'xml', '.css': 'css', '.toml': 'ini', '.example': 'ini', '.sh': 'bash'
};

function languageFor(file) {
  const base = path.basename(file);
  if (base === 'Dockerfile') return 'dockerfile';
  return LANGUAGE_BY_EXTENSION[path.extname(file)] || 'text';
}

/**
 * Resolve a requested source path safely. It must be on the allow-list AND
 * resolve to a location inside the repository once `..` and symlinks are
 * taken into account - the allow-list alone is not a path-traversal defence.
 */
function resolveSource(relative) {
  const clean = decodeURIComponent(relative || '').replace(/^\/+/, '');
  if (!isViewableSource(clean) && !isViewableSource(`${clean.replace(/\/$/, '')}/`)) return null;

  const absolute = path.resolve(ROOT, clean);
  if (absolute !== ROOT && !absolute.startsWith(ROOT + path.sep)) return null;
  if (!fs.existsSync(absolute)) return null;

  const real = fs.realpathSync(absolute);
  if (real !== ROOT && !real.startsWith(fs.realpathSync(ROOT) + path.sep)) return null;
  return { clean: clean.replace(/\/$/, ''), absolute: real };
}

function createDocsRouter() {
  const router = express.Router();

  router.use('/assets', express.static(path.join(__dirname, 'assets'), {
    maxAge: config.isProduction ? '1h' : 0
  }));

  router.get('/', (_req, res) => res.redirect(302, '/docs/README'));

  router.get('/search-index.json', (_req, res) => {
    const index = PAGES.map((page) => {
      try {
        const { title, toc } = loadPage(page);
        return {
          slug: page.slug,
          title: page.title,
          heading: title,
          blurb: page.blurb,
          colour: page.colour,
          sections: toc.map((t) => ({ text: t.text, slug: t.slug, level: t.level }))
        };
      } catch (_error) {
        return null;
      }
    }).filter(Boolean);
    res.json(index);
  });

  router.get('/raw/:page', (req, res, next) => {
    const page = findPage(req.params.page);
    if (!page) return next();
    res.type('text/markdown; charset=utf-8').send(loadPage(page).source);
  });

  router.get(/^\/source\/(.*)$/, (req, res) => {
    const target = resolveSource(req.params[0]);
    if (!target) {
      return res.status(404).type('html').send(layout({
        title: 'Not viewable', body: notFoundBody(`/docs/source/${req.params[0]}`), pages: PAGES
      }));
    }

    const stat = fs.statSync(target.absolute);
    if (stat.isDirectory()) {
      const entries = fs.readdirSync(target.absolute, { withFileTypes: true })
        .filter((entry) => isViewableSource(`${target.clean}/${entry.name}${entry.isDirectory() ? '/' : ''}`))
        .map((entry) => ({ name: entry.name, dir: entry.isDirectory() }))
        .sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name));
      return res.type('html').send(layout({
        title: target.clean, body: directoryBody(target.clean, entries), pages: PAGES
      }));
    }

    if (stat.size > 512 * 1024) {
      return res.type('text/plain').send(fs.readFileSync(target.absolute, 'utf8'));
    }

    const code = fs.readFileSync(target.absolute, 'utf8');
    const language = languageFor(target.clean);
    const highlighted = language === 'text' ? escapeHtml(code) : highlight(code, language);
    return res.type('html').send(layout({
      title: target.clean,
      body: sourceBody({ file: target.clean, language, highlighted, lines: code.split('\n').length, size: stat.size }),
      pages: PAGES
    }));
  });

  router.get('/:page', (req, res, next) => {
    const page = findPage(req.params.page);
    if (!page) return next();

    const rendered = loadPage(page);
    if (!wantsHtml(req)) {
      return res.type('text/markdown; charset=utf-8').send(rendered.source);
    }

    const position = PAGES.indexOf(page);
    return res.type('html').send(layout({
      title: `${page.title} - Production Core docs`,
      accent: page.colour,
      current: page.slug,
      pages: PAGES,
      toc: rendered.toc,
      body: pageBody({
        page,
        rendered: { ...rendered, html: retargetExamples(rendered.html, requestOrigin(req)) },
        previous: PAGES[position - 1] || null,
        next: PAGES[position + 1] || null,
        readingMinutes: Math.max(1, Math.round(rendered.words / 220))
      })
    }));
  });

  router.use((req, res) => {
    res.status(404).type('html').send(layout({
      title: 'Not found', body: notFoundBody(req.originalUrl), pages: PAGES
    }));
  });

  return router;
}

module.exports = { createDocsRouter, resolveSource, loadPage, retargetExamples };
