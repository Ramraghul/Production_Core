'use strict';

const request = require('supertest');
const { createApp, finalizeApp } = require('../../src/api/app');
const { makeContext } = require('../helpers/factory');
const { renderMarkdown, isViewableSource } = require('../../src/docs/renderer');
const { PAGES, findPage } = require('../../src/docs/catalogue');
const { resolveSource, loadPage } = require('../../src/docs');
const { allStateMachines } = require('../../src/core/stateMachines');
const controlCore = require('../../src/core/stationControl');

const HTML = 'text/html,application/xhtml+xml';

let app;

beforeAll(() => {
  app = finalizeApp(createApp(makeContext()));
});

describe('documentation site', () => {
  it('redirects /docs to the overview', async () => {
    const response = await request(app).get('/docs').expect(302);
    expect(response.headers.location).toBe('/docs/README');
  });

  it('renders every catalogued page, with its own accent and navigation', async () => {
    for (const page of PAGES) {
      const response = await request(app).get(`/docs/${page.slug}`).set('accept', HTML).expect(200);
      expect(response.headers['content-type']).toMatch(/text\/html/);
      expect(response.text).toContain(`--accent:${page.colour}`);
      expect(response.text).toContain('class="nav-item is-current"');
      // Every page in the catalogue is reachable from every other.
      for (const other of PAGES) expect(response.text).toContain(`href="/docs/${other.slug}"`);
    }
  });

  it('serves the same URL as a page to a browser and as markdown to a tool', async () => {
    const browser = await request(app).get('/docs/ARCHITECTURE.md').set('accept', HTML).expect(200);
    expect(browser.text).toMatch(/^<!doctype html>/);

    const tool = await request(app).get('/docs/ARCHITECTURE.md').set('accept', '*/*').expect(200);
    expect(tool.headers['content-type']).toMatch(/text\/markdown/);
    expect(tool.text.startsWith('# Architecture')).toBe(true);

    const forced = await request(app).get('/docs/ARCHITECTURE?format=md').set('accept', HTML).expect(200);
    expect(forced.headers['content-type']).toMatch(/text\/markdown/);
  });

  it('finds pages case-insensitively and with or without .md', () => {
    expect(findPage('architecture')).toBe(findPage('ARCHITECTURE.md'));
    expect(findPage('station-control').file).toBe('docs/STATION-CONTROL.md');
    expect(findPage('nope')).toBeNull();
  });

  it('turns a live marker plus its ASCII diagram into a widget, keeping the text version', async () => {
    const response = await request(app).get('/docs/ARCHITECTURE').set('accept', HTML).expect(200);
    expect(response.text).toContain('data-widget="architecture"');
    expect(response.text).toContain('data-widget="eventbus"');
    expect(response.text).toContain('data-widget="boot"');
    expect(response.text).toContain('<summary>Text version</summary>');
    // The marker comment itself is not left in the page.
    expect(response.text).not.toContain('<!-- live:');
  });

  it('draws every state machine a page asks for from one that exists', () => {
    const machines = allStateMachines();
    for (const page of PAGES) {
      for (const [, args] of loadPage(page).html.matchAll(/data-widget="state-machine" data-args="([^"]*)"/g)) {
        expect(Object.keys(machines)).toContain(args);
      }
    }
  });

  it('rewrites links between docs and into the source browser', async () => {
    const response = await request(app).get('/docs/README').set('accept', HTML).expect(200);
    expect(response.text).toContain('href="/docs/ARCHITECTURE"');
    expect(response.text).toContain('href="/docs/source/flows/plant.spec.js"');
  });

  it('returns raw markdown and a search index', async () => {
    const raw = await request(app).get('/docs/raw/STATION-CONTROL').expect(200);
    expect(raw.text).toContain('# Station control');

    const index = await request(app).get('/docs/search-index.json').expect(200);
    expect(index.body.map((p) => p.slug)).toEqual(PAGES.map((p) => p.slug));
    const control = index.body.find((p) => p.slug === 'STATION-CONTROL');
    expect(control.sections.map((s) => s.text)).toContain('The MQTT command channel');
  });

  it('serves its assets', async () => {
    await request(app).get('/docs/assets/docs.css').expect(200).expect('content-type', /css/);
    await request(app).get('/docs/assets/widgets.js').expect(200).expect('content-type', /javascript/);
  });

  it('answers an unknown page with a styled 404', async () => {
    const response = await request(app).get('/docs/NOT-A-PAGE').set('accept', HTML).expect(404);
    expect(response.text).toContain('Nothing here');
  });
});

describe('source browser', () => {
  it('shows a source file highlighted, with line anchors', async () => {
    const response = await request(app).get('/docs/source/src/core/stationControl.js').expect(200);
    expect(response.text).toContain('id="L1"');
    expect(response.text).toContain('hljs-keyword');
  });

  it('lists a directory', async () => {
    const response = await request(app).get('/docs/source/src/core').expect(200);
    expect(response.text).toContain('stationControl.js');
  });

  it('shows allow-listed root files', async () => {
    await request(app).get('/docs/source/package.json').expect(200);
  });

  it.each([
    ['/docs/source/.env'],
    ['/docs/source/node_modules/express/package.json'],
    ['/docs/source/src/../node_modules/express/package.json'],
    ['/docs/source/src/..%2f..%2f..%2fetc/passwd'],
    ['/docs/source/src/%2e%2e/%2e%2e/etc/passwd'],
    ['/docs/source/data/production-core.snapshot.json']
  ])('refuses %s', async (url) => {
    await request(app).get(url).expect(404);
  });

  it('resolves only paths that stay inside the repository', () => {
    expect(resolveSource('src/core/oee.js')).not.toBeNull();
    expect(resolveSource('src/../../outside.js')).toBeNull();
    expect(resolveSource('src/%2e%2e/%2e%2e/etc/passwd')).toBeNull();
    expect(isViewableSource('src/node_modules/x.js')).toBe(false);
  });
});

describe('renderer', () => {
  it('claims a code block only when it starts on the line after the marker', () => {
    const adjacent = renderMarkdown('# T\n\n<!-- live:plant -->\n```\nascii\n```\n', 'x.md');
    expect(adjacent.html).toContain('data-widget="plant"');
    expect(adjacent.html).toContain('Text version');

    const separated = renderMarkdown('# T\n\n<!-- live:plant -->\n\n```js\nconst a = 1;\n```\n', 'x.md');
    expect(separated.html).toContain('data-widget="plant"');
    expect(separated.html).not.toContain('Text version');
    expect(separated.html).toContain('class="code-block"');
  });

  it('builds a table of contents with stable slugs and a lede', () => {
    const result = renderMarkdown('# Title\n\nFirst paragraph.\n\n## Two words\n\n### Deeper (one)\n', 'x.md');
    expect(result.title).toBe('Title');
    expect(result.lede).toContain('First paragraph.');
    expect(result.toc.map((t) => t.slug)).toEqual(['two-words', 'deeper-one']);
  });

  it('marks GET curl examples as runnable', () => {
    const result = renderMarkdown('# T\n\n```bash\ncurl -s localhost:1880/api/v1/health\n```\n', 'x.md');
    expect(result.html).toContain('data-runnable="1"');
  });
});

describe('reference endpoints behind the widgets', () => {
  it('GET /api/v1/reference/state-machines returns the tables the domain enforces', async () => {
    const response = await request(app).get('/api/v1/reference/state-machines').expect(200);
    const control = response.body.stationControl;

    expect(control.initial).toBe('AUTO');
    expect(control.transitions).toEqual(expect.arrayContaining(
      controlCore.CONTROL_TRANSITIONS.map((t) => expect.objectContaining({ from: t.from, to: t.to, label: t.action }))
    ));
    for (const machine of Object.values(response.body)) {
      const states = new Set(machine.states.map((s) => s.id));
      expect(states.has(machine.initial)).toBe(true);
      for (const t of machine.transitions) {
        expect(states.has(t.from)).toBe(true);
        expect(states.has(t.to)).toBe(true);
      }
    }
  });

  it('GET /api/v1/kpi/calculate runs the OEE engine on supplied figures', async () => {
    const response = await request(app).get('/api/v1/kpi/calculate').query({
      plannedBusySeconds: 26400, downtimeSeconds: 2520, idealCycleSeconds: 60, totalCount: 390, goodCount: 378
    }).expect(200);

    expect(response.body.availability).toBeCloseTo(90.5, 0);
    expect(response.body.oee).toBeGreaterThan(0);
    const l = response.body.losses;
    // The loss waterfall sums back to planned time.
    expect(l.availabilityLossSeconds + l.performanceLossSeconds + l.qualityLossSeconds + l.valueAddingSeconds)
      .toBeCloseTo(26400, -1);
  });

  it('GET /api/v1/kpi/calculate caps performance and says so', async () => {
    const response = await request(app).get('/api/v1/kpi/calculate').query({
      plannedBusySeconds: 3600, idealCycleSeconds: 60, totalCount: 90, goodCount: 90
    }).expect(200);

    expect(response.body.performance).toBe(100);
    expect(response.body.warnings.map((w) => w.code)).toContain('PERFORMANCE_CAPPED');
  });

  it('GET /api/v1/kpi/calculate rejects nonsense', async () => {
    await request(app).get('/api/v1/kpi/calculate').query({ plannedBusySeconds: -5 }).expect(400);
  });
});
