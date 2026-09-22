#!/usr/bin/env node
'use strict';

/**
 * End-to-end smoke test.
 *
 * Boots the whole application in a real process - store, embedded MQTT broker,
 * Express, Node-RED and the simulator - and exercises it the way a visitor and
 * a plant system would. Run it after a deploy, or locally with `npm run smoke`.
 *
 * This lives outside Jest on purpose. aedes 1.x is pure ESM, and Jest's CJS
 * module registry cannot `require()` ESM until Node 24.9, so the broker can
 * only be integration-tested in a plain Node process. Doing it here also gets
 * the Node-RED runtime and the real HTTP stack under test, which the unit
 * suites deliberately stub out.
 */

process.env.NODE_ENV = process.env.NODE_ENV || 'development';
process.env.PC_LOG_LEVEL = process.env.PC_LOG_LEVEL || 'warn';
process.env.PC_STORE = 'memory';
process.env.PC_SEED_SHIFTS = process.env.PC_SEED_SHIFTS || '1';
process.env.PC_SIM_SPEED = process.env.PC_SIM_SPEED || '60';
process.env.PORT = process.env.PORT || '18880';
process.env.PC_MQTT_PORT = process.env.PC_MQTT_PORT || '18883';

const { Server } = require('../src/server');
const config = require('../src/config');

const BASE = `http://127.0.0.1:${config.http.port}`;
const API_KEY = config.security.apiKey;

const ESC = String.fromCharCode(27);
const green = (text) => `${ESC}[32m${text}${ESC}[0m`;
const red = (text) => `${ESC}[31m${text}${ESC}[0m`;
const dim = (text) => `${ESC}[90m${text}${ESC}[0m`;

const results = [];
let failures = 0;

/** Run one named check, recording the outcome rather than throwing. */
async function check(name, fn) {
  const started = Date.now();
  try {
    const detail = await fn();
    results.push({ name, ok: true, ms: Date.now() - started, detail });
    process.stdout.write(`  ${green('PASS')} ${name}${detail ? dim(` - ${detail}`) : ''}\n`);
  } catch (error) {
    failures += 1;
    results.push({ name, ok: false, ms: Date.now() - started, error: error.message });
    process.stdout.write(`  ${red('FAIL')} ${name}\n         ${red(error.message)}\n`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const wait = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

async function getJson(path) {
  const response = await fetch(`${BASE}${path}`);
  const body = await response.json().catch(() => ({}));
  assert(response.ok, `GET ${path} returned ${response.status}: ${JSON.stringify(body).slice(0, 160)}`);
  return body;
}

async function postJson(path, payload, expectedStatus = 200) {
  const response = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': API_KEY },
    body: JSON.stringify(payload)
  });
  const body = await response.json().catch(() => ({}));
  assert(
    response.status === expectedStatus,
    `POST ${path} returned ${response.status}, expected ${expectedStatus}: ${JSON.stringify(body).slice(0, 160)}`
  );
  return body;
}

async function main() {
  process.stdout.write('\nProduction Core - smoke test\n');
  process.stdout.write(`${'='.repeat(62)}\n`);

  const server = new Server();
  const bootStarted = Date.now();
  await server.start();
  const bootMs = Date.now() - bootStarted;

  process.stdout.write(`\nBooted in ${bootMs} ms on ${BASE}\n\n`);

  // ---- HTTP surface ------------------------------------------------------
  process.stdout.write('HTTP\n');

  await check('health reports ok', async () => {
    const health = await getJson('/api/v1/health');
    assert(health.status === 'ok', `status was ${health.status}`);
    return `${health.store.collections.units} vehicles, ${health.memory.rssMb} MB RSS`;
  });

  await check('readiness probe passes', async () => {
    const ready = await getJson('/api/v1/ready');
    assert(ready.stations === 43, `expected 43 stations, got ${ready.stations}`);
    return `${ready.stations} stations`;
  });

  await check('plant hierarchy is complete', async () => {
    const plant = await getJson('/api/v1/plant');
    const lines = plant.areas.flatMap((a) => a.lines);
    const stations = lines.flatMap((l) => l.stations);
    assert(lines.length === 7, `expected 7 lines, got ${lines.length}`);
    assert(stations.length === 43, `expected 43 stations, got ${stations.length}`);
    return `${plant.areas.length} areas, ${lines.length} lines, ${stations.length} stations`;
  });

  await check('KPI dashboard returns plausible numbers', async () => {
    const dashboard = await getJson('/api/v1/kpi/dashboard');
    assert(dashboard.headline.oee >= 0 && dashboard.headline.oee <= 100,
      `OEE out of range: ${dashboard.headline.oee}`);
    assert(dashboard.lines.length === 7, 'expected 7 lines');
    return `OEE ${dashboard.headline.oee}%, ${dashboard.headline.jph} JPH`;
  });

  await check('writes are rejected without an API key', async () => {
    const response = await fetch(`${BASE}/api/v1/work-orders`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ modelCode: 'NS-AURORA-EV', quantity: 1 })
    });
    assert(response.status === 401, `expected 401, got ${response.status}`);
    return '401 as expected';
  });

  await check('OpenAPI document is served', async () => {
    const spec = await getJson('/openapi.json');
    assert(spec.openapi.startsWith('3.'), `unexpected version ${spec.openapi}`);
    const operations = Object.values(spec.paths).reduce((n, p) => n + Object.keys(p).length, 0);
    return `${Object.keys(spec.paths).length} paths, ${operations} operations`;
  });

  await check('Swagger UI renders and its assets load', async () => {
    const response = await fetch(`${BASE}/api-docs`);
    const html = await response.text();
    assert(response.ok && html.includes('swagger-ui'), 'Swagger UI page did not render');

    // Checking only the HTML is not enough: the page can render while every
    // asset 404s, which is exactly what a relative path bug looks like.
    for (const asset of ['swagger-ui.css', 'swagger-ui-bundle.js', 'swagger-ui-standalone-preset.js']) {
      const res = await fetch(`${BASE}/api-docs/${asset}`);
      assert(res.ok, `${asset} returned ${res.status}`);
      const type = res.headers.get('content-type') || '';
      const expected = asset.endsWith('.css') ? 'css' : 'javascript';
      assert(type.includes(expected), `${asset} served as '${type}', expected ${expected}`);
    }
    return 'page plus 3 assets with correct MIME types';
  });

  await check('plant HMI is served', async () => {
    const response = await fetch(`${BASE}/`);
    const html = await response.text();
    assert(response.ok && html.includes('Production Core'), 'HMI did not render');
    return `${(html.length / 1024).toFixed(1)} KB`;
  });

  // ---- domain behaviour --------------------------------------------------
  process.stdout.write('\nDomain\n');

  let builtVin;

  await check('a work order releases vehicles with valid VINs', async () => {
    const order = await postJson('/api/v1/work-orders',
      { modelCode: 'NS-AURORA-EV', quantity: 2 }, 201);
    const released = await postJson(`/api/v1/work-orders/${order.id}/release`, { createUnits: 1 });

    builtVin = released.units[0].vin;
    const { isValidVin } = require('../src/core/ids');
    assert(isValidVin(builtVin), `VIN failed check-digit validation: ${builtVin}`);
    return builtVin;
  });

  await check('routing is enforced', async () => {
    await postJson(`/api/v1/units/${builtVin}/move`, { stationId: 'BODY-10' });
    await postJson(`/api/v1/units/${builtVin}/move`, { stationId: 'FINAL-40' }, 409);
    return 'station skip rejected with 409';
  });

  await check('a quality gate blocks a defective vehicle', async () => {
    for (const stationId of ['BODY-20', 'BODY-30', 'BODY-40', 'BODY-50']) {
      await postJson(`/api/v1/units/${builtVin}/move`, { stationId });
    }
    await postJson('/api/v1/quality/defects',
      { code: 'DIM_OUT_OF_TOL', vin: builtVin, stationId: 'BODY-50' }, 201);

    const blocked = await postJson(`/api/v1/units/${builtVin}/move`, { stationId: 'PAINT-10' }, 409);
    assert(blocked.error.code === 'QUALITY_HOLD', `expected QUALITY_HOLD, got ${blocked.error.code}`);
    return 'held at BODY-50 with 409 QUALITY_HOLD';
  });

  await check('genealogy records parts with supplier lots', async () => {
    const genealogy = await getJson(`/api/v1/units/${builtVin}/genealogy`);
    assert(genealogy.stats.parts > 0, 'no parts recorded');
    assert(genealogy.stats.distinctLots > 0, 'no supplier lots recorded');
    return `${genealogy.stats.totalNodes} components, ${genealogy.stats.distinctLots} lots`;
  });

  await check('recall analysis answers across the build history', async () => {
    const lots = await getJson('/api/v1/trace/lots?limit=20');
    assert(lots.items.length > 0, 'no lots recorded');

    const started = Date.now();
    const report = await postJson('/api/v1/trace/recall',
      { lotCode: lots.items[0].lotCode, reason: 'smoke test' });
    const elapsed = Date.now() - started;

    assert(report.affectedCount > 0, 'recall found nothing');
    assert(report.recommendation.action, 'no recommendation returned');
    return `${report.affectedCount} vehicles in ${elapsed} ms, action ${report.recommendation.action}`;
  });

  // ---- MQTT --------------------------------------------------------------
  process.stdout.write('\nMQTT\n');

  const mqtt = require('mqtt');
  const client = mqtt.connect(`mqtt://127.0.0.1:${config.mqtt.port}`, {
    clientId: 'smoke-probe', connectTimeout: 8000, reconnectPeriod: 0
  });

  await check('embedded broker accepts a client connection', async () => {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('connect timed out')), 8000);
      client.once('connect', () => { clearTimeout(timer); resolve(); });
      client.once('error', (error) => { clearTimeout(timer); reject(error); });
    });
    return `connected to mqtt://127.0.0.1:${config.mqtt.port}`;
  });

  await check('plant events are mirrored onto the topic tree', async () => {
    const topics = await new Promise((resolve, reject) => {
      const seen = [];
      client.on('message', (topic) => seen.push(topic));
      client.subscribe('northstar/#', (error) => {
        if (error) return reject(error);
        // The simulator is running, so traffic arrives on its own.
        setTimeout(() => resolve(seen), 4000);
      });
    });

    assert(topics.length > 0, 'no MQTT traffic seen in 4 s');
    const distinct = [...new Set(topics)];
    return `${topics.length} messages across ${distinct.length} topics`;
  });

  await check('the flows publish a retained plant status', async () => {
    const status = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), 25000);
      client.subscribe('northstar/win/plant/status', () => {});
      client.on('message', (topic, payload) => {
        if (topic !== 'northstar/win/plant/status') return;
        clearTimeout(timer);
        try {
          resolve(JSON.parse(payload.toString()));
        } catch (_error) {
          resolve(null);
        }
      });
    });

    assert(status, 'no plant status published within 25 s');
    assert(typeof status.oee === 'number', 'status carried no OEE');
    return `OEE ${status.oee}%, ${status.lines.length} lines`;
  });

  client.end(true);

  // ---- Node-RED ----------------------------------------------------------
  process.stdout.write('\nNode-RED\n');

  await check('the flow runtime is running', async () => {
    const runtime = server.nodeRed?.status();
    assert(runtime?.running, 'Node-RED is not running');
    assert(runtime.nodeCount > 100, `expected more than 100 nodes, got ${runtime.nodeCount}`);
    return `${runtime.nodeCount} nodes loaded`;
  });

  await check('the editor is reachable', async () => {
    const response = await fetch(`${BASE}/red/`, { redirect: 'follow' });
    assert(response.ok, `editor returned ${response.status}`);
    return `${response.status} at /red`;
  });

  await check('flow-served API responds', async () => {
    const status = await getJson('/factory/status');
    assert(status.servedBy && status.servedBy.includes('node-red'),
      'response did not come from a flow');
    return status.servedBy;
  });

  await check('flow-served HTML board renders', async () => {
    const response = await fetch(`${BASE}/factory/board`);
    const html = await response.text();
    assert(response.ok && html.includes('Line Board'), 'board did not render');
    return `${(html.length / 1024).toFixed(1)} KB`;
  });

  // ---- simulator ---------------------------------------------------------
  process.stdout.write('\nSimulator\n');

  await check('the plant is producing', async () => {
    const before = await getJson('/api/v1/simulator');
    await wait(5000);
    const after = await getJson('/api/v1/simulator');

    assert(after.counters.stationCycles > before.counters.stationCycles,
      'no station cycles completed in 5 s');
    return `${after.counters.stationCycles} cycles, ` +
      `${after.counters.unitsCompleted} vehicles released, ` +
      `${after.simulatedHours} simulated hours`;
  });

  await check('an injected fault stops a station', async () => {
    await postJson('/api/v1/simulator/inject-fault',
      { stationId: 'PAINT-40', reasonCode: 'ROBOT_FAULT', durationSeconds: 120 });
    const station = await getJson('/api/v1/stations/PAINT-40');
    assert(station.state.state === 'DOWN', `expected DOWN, got ${station.state.state}`);
    return 'PAINT-40 is DOWN';
  });

  // ---- report ------------------------------------------------------------
  await server.stop();

  const passed = results.filter((r) => r.ok).length;
  process.stdout.write(`\n${'='.repeat(62)}\n`);
  process.stdout.write(
    failures === 0
      ? `${green(`All ${passed} checks passed`)} (boot ${bootMs} ms)\n\n`
      : `${red(`${failures} of ${results.length} checks failed`)}\n\n`
  );

  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  process.stderr.write(`\n${red('Smoke test crashed:')} ${error.message}\n${error.stack}\n`);
  process.exit(1);
});
