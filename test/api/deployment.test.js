'use strict';

/**
 * The serverless (Vercel) deployment and the hardening a public demo needs.
 *
 * Serverless mode is switched on before anything reads the configuration.
 * Jest gives each test file its own module registry, so this does not leak
 * into the other suites.
 */

process.env.PC_SERVERLESS = 'true';
// test/setup.js pins these for every suite; clear them so this one sees the
// defaults serverless mode actually chooses.
delete process.env.PC_STORE;
delete process.env.PC_MQTT_ENABLED;
delete process.env.PC_NODERED_ENABLED;
process.env.PC_SIM_ENABLED = 'true';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');
const request = require('supertest');

const config = require('../../src/config');
const { createServerlessApp } = require('../../src/serverless');
const { swaggerPage } = require('../../src/api/swagger');
const { buildStatic } = require('../../scripts/vercel-build');
const { PAGES, SOURCE_FILES, SOURCE_PREFIXES } = require('../../src/docs/catalogue');

const ROOT = path.resolve(__dirname, '..', '..');

let app;
let ctx;

beforeAll(() => {
  app = createServerlessApp({ context: { seed: false }, simulate: false });
  ctx = app.locals.ctx;
});

afterAll(() => ctx.simulator?.stop());

describe('serverless configuration', () => {
  it('turns off everything that needs a long-running process', () => {
    expect(config.runtime.serverless).toBe(true);
    expect(config.nodeRed.enabled).toBe(false);
    expect(config.mqtt.enabled).toBe(false);
    expect(config.store.driver).toBe('memory');
    expect(config.simulator.catchUpSeconds).toBeGreaterThan(0);
    expect(config.http.sseMaxSeconds).toBeGreaterThan(0);
  });

  it('reports the runtime in the health check', async () => {
    const response = await request(app).get('/api/v1/health').expect(200);
    expect(response.body.runtime).toEqual({ mode: 'serverless', nodeRed: false, fullRuntimeUrl: null });
    expect(response.body.mqtt.enabled).toBe(false);
  });

  it('serves the API, Swagger UI and the docs from the one handler', async () => {
    await request(app).get('/api/v1/stations').expect(200);
    await request(app).get('/openapi.json').expect(200).expect('content-type', /json/);
    await request(app).get('/api-docs').expect(200).expect('content-type', /html/);
    await request(app).get('/api-docs/swagger-ui.css').expect(200).expect('content-type', /css/);
    await request(app).get('/docs/ARCHITECTURE').set('accept', 'text/html').expect(200);
  });

  it('does not load Node-RED or the MQTT broker on the serverless path', () => {
    // A separate process, so the answer is Node's real module cache. What is
    // not loaded is not traced into the function bundle either.
    const loaded = execFileSync(process.execPath, ['-e', `
      require('./src/serverless');
      const heavy = Object.keys(require.cache)
        .filter((file) => /node_modules[\\\\/](node-red|@node-red|aedes|mqtt)[\\\\/]/.test(file));
      process.stdout.write(JSON.stringify(heavy));
    `], { cwd: ROOT, env: { ...process.env, PC_LOG_LEVEL: 'silent' } }).toString();
    expect(JSON.parse(loaded)).toEqual([]);
  });
});

describe('paths only the full runtime serves', () => {
  it.each(['/red', '/red/flows', '/factory/status', '/mqtt'])('explains %s instead of a bare 404', async (url) => {
    const json = await request(app).get(url).set('accept', 'application/json').expect(404);
    expect(json.body.error.code).toBe('NOT_ON_SERVERLESS');

    const html = await request(app).get(url).set('accept', 'text/html').expect(404);
    expect(html.text).toContain('Not on this deployment');
  });

  it('redirects to the full runtime when one is configured', async () => {
    config.runtime.fullRuntimeUrl = 'https://production-core.onrender.com';
    try {
      const response = await request(app).get('/red/flows?x=1').expect(302);
      expect(response.headers.location).toBe('https://production-core.onrender.com/red/flows?x=1');
    } finally {
      config.runtime.fullRuntimeUrl = '';
    }
  });

  it('leaves the flow editor link off the Swagger page when there is no editor', () => {
    expect(swaggerPage({ nodeRed: false })).not.toContain('href="/red"');
    expect(swaggerPage({ nodeRed: true })).toContain('href="/red"');
  });
});

describe('addresses: localhost locally, the live URL when deployed, never both', () => {
  const LIVE = { host: 'production-factory-core.vercel.app', proto: 'https' };
  const LOCAL = { host: 'localhost:1880', proto: 'http' };
  const from = (req, { host, proto }) => req.set('Host', host).set('X-Forwarded-Proto', proto);
  const codeBlocks = (html) => (html.match(/<pre[\s\S]*?<\/pre>/g) || []).join('\n');

  it('lists only the address being read from as the OpenAPI server', async () => {
    const live = await from(request(app).get('/openapi.json'), LIVE).expect(200);
    expect(live.body.servers).toEqual([
      { url: 'https://production-factory-core.vercel.app/api/v1', description: 'Live deployment' }
    ]);

    const local = await from(request(app).get('/openapi.json'), LOCAL).expect(200);
    expect(local.body.servers).toEqual([
      { url: 'http://localhost:1880/api/v1', description: 'Local - this machine' }
    ]);
  });

  it('points the docs examples at the live URL on the live site', async () => {
    const live = await from(request(app).get('/docs/API').set('accept', 'text/html'), LIVE).expect(200);
    const examples = codeBlocks(live.text);
    expect(examples).toContain('https://production-factory-core.vercel.app/api/v1');
    expect(examples).not.toContain('localhost:1880');

    const local = await from(request(app).get('/docs/API').set('accept', 'text/html'), LOCAL).expect(200);
    expect(codeBlocks(local.text)).toContain('localhost:1880');
    expect(codeBlocks(local.text)).not.toContain('vercel.app');
  });

  it('leaves local-only addresses alone on the live site', async () => {
    // MQTT and the local serverless preview only exist on the reader's machine.
    const flows = await from(request(app).get('/docs/FLOWS').set('accept', 'text/html'), LIVE).expect(200);
    expect(codeBlocks(flows.text)).toContain('-h localhost -p 1883');
    const deployment = await from(request(app).get('/docs/DEPLOYMENT').set('accept', 'text/html'), LIVE).expect(200);
    expect(codeBlocks(deployment.text)).toContain('localhost:3000');
  });
});

describe('a frozen instance catches up', () => {
  beforeEach(() => ctx.simulator.start());
  afterEach(() => ctx.simulator.stop());

  it('replays the ticks missed while frozen before answering an API request', async () => {
    const { simulator } = ctx;
    simulator.clockAt = Date.now() - 5000;
    const before = simulator.counters.catchUpTicks;

    await request(app).get('/api/v1/kpi/dashboard').expect(200);

    // 5 s at a 250 ms tick.
    expect(simulator.counters.catchUpTicks - before).toBeGreaterThanOrEqual(19);
    expect(simulator.counters.catchUpTicks - before).toBeLessThanOrEqual(21);
  });

  it('still catches up when the overdue timer fires first on thaw', () => {
    // Regression, seen on Vercel: waking a frozen instance fires the overdue
    // interval once before the request is read. That tick must account for
    // its own 250 ms only, not declare the whole freeze made up.
    const { simulator } = ctx;
    simulator.clockAt = Date.now() - 5000;
    simulator.tick();

    expect(simulator.catchUp(config.simulator.catchUpSeconds)).toBeGreaterThanOrEqual(18);
  });

  it('skips a gap longer than the limit instead of replaying all of it', () => {
    const { simulator } = ctx;
    simulator.clockAt = Date.now() - 10 * 60 * 1000;

    const ticks = simulator.catchUp(config.simulator.catchUpSeconds);

    expect(ticks).toBe((config.simulator.catchUpSeconds * 1000) / simulator.tickMs);
    expect(simulator.catchUp(config.simulator.catchUpSeconds)).toBe(0);
  });

  it('does nothing for a stopped simulator or on a server', () => {
    ctx.simulator.stop();
    ctx.simulator.clockAt = Date.now() - 5000;
    expect(ctx.simulator.catchUp(30)).toBe(0);
    ctx.simulator.start();
    expect(ctx.simulator.catchUp(0)).toBe(0);
  });
});

describe('the live event stream on serverless', () => {
  it('ends itself before the platform limit and tells the browser to reconnect', async () => {
    const saved = config.http.sseMaxSeconds;
    config.http.sseMaxSeconds = 1;
    const server = app.listen(0);
    try {
      const { port } = server.address();
      const started = Date.now();
      const body = await new Promise((resolve, reject) => {
        http.get(`http://127.0.0.1:${port}/api/v1/events/stream`, (res) => {
          let text = '';
          res.on('data', (chunk) => { text += chunk; });
          res.on('end', () => resolve(text));
        }).on('error', reject);
      });

      expect(body).toContain('event: connected');
      expect(body).toContain('retry: 2000');
      expect(Date.now() - started).toBeLessThan(5000);
    } finally {
      config.http.sseMaxSeconds = saved;
      server.close();
    }
  });
});

describe('write rate limit', () => {
  afterEach(() => { config.security.writesPerMinute = 0; });

  it('refuses a client that exceeds the limit, with Retry-After', async () => {
    config.security.writesPerMinute = 2;
    // Counted before authentication, so guessing keys is limited too.
    await request(app).post('/api/v1/work-orders').send({}).expect(401);
    const second = await request(app).post('/api/v1/work-orders').send({}).expect(401);
    expect(second.headers['ratelimit-remaining']).toBe('0');

    const refused = await request(app).post('/api/v1/work-orders').send({}).expect(429);
    expect(refused.body.error.code).toBe('RATE_LIMITED');
    expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('never limits reads', async () => {
    config.security.writesPerMinute = 1;
    for (let index = 0; index < 3; index += 1) {
      await request(app).get('/api/v1/health').expect(200);
    }
  });
});

describe('Vercel build and configuration', () => {
  it('writes Swagger UI as static files for the CDN', () => {
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-swagger-'));
    try {
      const { files } = buildStatic(outDir);
      for (const file of files) expect(fs.statSync(path.join(outDir, file)).size).toBeGreaterThan(100);
      const page = fs.readFileSync(path.join(outDir, 'index.html'), 'utf8');
      expect(page).toContain('href="/api-docs/swagger-ui.css"');
      expect(page).toContain("url: '/openapi.json'");
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  });

  it('points vercel.json at files and scripts that exist', () => {
    const vercel = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

    expect(vercel.framework).toBeNull(); // or Vercel auto-detects src/index.js as an Express server
    expect(pkg.scripts[vercel.buildCommand.replace('npm run ', '')]).toBeTruthy();
    expect(fs.existsSync(path.join(ROOT, vercel.outputDirectory, 'index.html'))).toBe(true);

    for (const [fn, settings] of Object.entries(vercel.functions)) {
      expect(fs.existsSync(path.join(ROOT, fn))).toBe(true);
      expect(settings.maxDuration).toBeGreaterThan(config.http.sseMaxSeconds);
    }
  });

  it('bundles every file the function reads from disk, within Vercel\'s 256-character limit', () => {
    const vercel = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
    const { includeFiles } = vercel.functions['api/index.js'];
    // Vercel rejects the project at import time above this length.
    expect(includeFiles.length).toBeLessThanOrEqual(256);

    // What the docs read at runtime rather than require(): every page, the
    // site's assets, and everything the source browser offers.
    const needed = [
      ...PAGES.map((page) => page.file),
      ...SOURCE_FILES.filter((file) => fs.existsSync(path.join(ROOT, file))),
      ...SOURCE_PREFIXES.map((prefix) => `${prefix}example.js`),
      'src/docs/assets/docs.css'
    ];
    const missing = needed.filter((file) => !path.matchesGlob(file, includeFiles));
    expect(missing).toEqual([]);

    // And nothing that would bloat the bundle or leak a secret.
    for (const file of ['node_modules/express/index.js', 'data/production-core.snapshot.json', '.env']) {
      expect(path.matchesGlob(file, includeFiles)).toBe(false);
    }

    // The catch-all must come last, after the static Swagger page.
    expect(vercel.rewrites[vercel.rewrites.length - 1]).toEqual({ source: '/(.*)', destination: '/api' });
  });

  it('exports a request handler from the function entry', () => {
    const entry = fs.readFileSync(path.join(ROOT, 'api', 'index.js'), 'utf8');
    expect(entry).toMatch(/module\.exports = createServerlessApp\(\)/);
  });
});
