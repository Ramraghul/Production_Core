'use strict';

const request = require('supertest');
const { createApp, finalizeApp } = require('../../src/api/app');
const { makeContext, buildVehicle, releaseUnits, walkRoute, MAIN_STATION_ROUTE } = require('../helpers/factory');
const config = require('../../src/config');

const API_KEY = config.security.apiKey;

let ctx;
let app;
let sampleVin;

beforeAll(() => {
  ctx = makeContext();
  // A small but complete plant: three released vehicles plus one on the floor.
  buildVehicle(ctx);
  const built = buildVehicle(ctx);
  sampleVin = built.vin;

  const { vins } = releaseUnits(ctx, 1);
  walkRoute(ctx, vins[0], { through: 6 });

  app = finalizeApp(createApp(ctx));
});

describe('system endpoints', () => {
  it('GET /api/v1/health reports store diagnostics', async () => {
    const response = await request(app).get('/api/v1/health').expect(200);

    expect(response.body.status).toBe('ok');
    expect(response.body.site.name).toBe('Windsor Assembly Plant');
    expect(response.body.store.collections.units).toBeGreaterThan(0);
  });

  it('GET /api/v1/ready returns 200 once stations are loaded', async () => {
    const response = await request(app).get('/api/v1/ready').expect(200);
    expect(response.body.stations).toBe(43);
  });

  it('echoes a request id back on every response', async () => {
    const response = await request(app)
      .get('/api/v1/health')
      .set('x-request-id', 'test-correlation-1');

    expect(response.headers['x-request-id']).toBe('test-correlation-1');
  });
});

describe('authentication', () => {
  it('allows reads without a key, so the demo is browsable', async () => {
    await request(app).get('/api/v1/lines').expect(200);
  });

  it('rejects a write with no key', async () => {
    const response = await request(app)
      .post('/api/v1/work-orders')
      .send({ modelCode: 'NS-AURORA-EV', quantity: 1 })
      .expect(401);

    expect(response.body.error.code).toBe('UNAUTHORIZED');
    expect(response.body.error.message).toMatch(/x-api-key/);
  });

  it('rejects a write with the wrong key', async () => {
    await request(app)
      .post('/api/v1/work-orders')
      .set('x-api-key', 'not-the-key')
      .send({ modelCode: 'NS-AURORA-EV', quantity: 1 })
      .expect(401);
  });

  it('accepts the key as a bearer token too', async () => {
    await request(app)
      .post('/api/v1/work-orders')
      .set('authorization', `Bearer ${API_KEY}`)
      .send({ modelCode: 'NS-AURORA-EV', quantity: 1 })
      .expect(201);
  });
});

describe('plant model', () => {
  it('GET /api/v1/plant returns the ISA-95 hierarchy', async () => {
    const response = await request(app).get('/api/v1/plant').expect(200);

    expect(response.body.enterprise).toBe('NorthStar Motors');
    expect(response.body.areas).toHaveLength(5);
    const lines = response.body.areas.flatMap((a) => a.lines);
    expect(lines).toHaveLength(7);
    expect(lines.flatMap((l) => l.stations)).toHaveLength(43);
  });

  it('GET /api/v1/lines/:id includes capacity and the design bottleneck', async () => {
    const response = await request(app).get('/api/v1/lines/MAINASM').expect(200);

    expect(response.body.name).toBe('Main Assembly');
    expect(response.body.bottleneck).toBe('CHAS-10');
    expect(response.body.capacityJph).toBeGreaterThan(0);
  });

  it('404s an unknown line with a machine-readable code', async () => {
    const response = await request(app).get('/api/v1/lines/NOPE').expect(404);
    expect(response.body.error.code).toBe('NOT_FOUND');
    expect(response.body.error.details.entity).toBe('Line');
  });

  it('GET /api/v1/stations/:id includes the parts it back-flushes', async () => {
    const response = await request(app).get('/api/v1/stations/TIRE-10').expect(200);

    const partNumbers = response.body.partsConsumed.map((p) => p.partNumber);
    expect(partNumbers).toContain('PN-TIRE-235');
    // Four fitted plus a spare.
    expect(response.body.partsConsumed.find((p) => p.partNumber === 'PN-TIRE-235').quantity).toBe(5);
  });

  it('GET /api/v1/boms/:model derives the BOM from the routing', async () => {
    const response = await request(app).get('/api/v1/boms/NS-AURORA-EV').expect(200);

    expect(response.body.lineCount).toBeGreaterThan(40);
    expect(response.body.materialCostCad).toBeGreaterThan(10000);
    expect(response.body.subAssemblies.map((s) => s.classCode)).toContain('PWT');
  });

  it('serves the reference code tables', async () => {
    const defects = await request(app).get('/api/v1/reference/defect-codes?family=PAINT').expect(200);
    expect(defects.body.items.every((d) => d.family === 'PAINT')).toBe(true);

    const reasons = await request(app).get('/api/v1/reference/downtime-reasons?category=PLANNED').expect(200);
    expect(reasons.body.items.every((r) => r.category === 'PLANNED')).toBe(true);
  });
});

describe('work orders and units', () => {
  it('creates, releases and tracks a work order', async () => {
    const created = await request(app)
      .post('/api/v1/work-orders')
      .set('x-api-key', API_KEY)
      .send({ modelCode: 'NS-BOREALIS-HEV', quantity: 4, priority: 'HIGH' })
      .expect(201);

    expect(created.body.status).toBe('DRAFT');

    const released = await request(app)
      .post(`/api/v1/work-orders/${created.body.id}/release`)
      .set('x-api-key', API_KEY)
      .send({ createUnits: 2 })
      .expect(200);

    expect(released.body.units).toHaveLength(2);

    const fetched = await request(app).get(`/api/v1/work-orders/${created.body.id}`).expect(200);
    expect(fetched.body.progress.quantity).toBe(4);
    expect(fetched.body.units).toHaveLength(2);
  });

  it('reports validation problems field by field', async () => {
    const response = await request(app)
      .post('/api/v1/work-orders')
      .set('x-api-key', API_KEY)
      .send({ modelCode: 'NOT-A-MODEL', quantity: 0 })
      .expect(400);

    expect(response.body.error.code).toBe('VALIDATION_FAILED');
    expect(response.body.error.details.map((d) => d.field).sort()).toEqual(['modelCode', 'quantity']);
  });

  it('rejects malformed JSON with a clear code', async () => {
    const response = await request(app)
      .post('/api/v1/work-orders')
      .set('x-api-key', API_KEY)
      .set('content-type', 'application/json')
      .send('{ not json')
      .expect(400);

    expect(response.body.error.code).toBe('MALFORMED_JSON');
  });

  it('GET /api/v1/units filters by status and line', async () => {
    const completed = await request(app).get('/api/v1/units?status=COMPLETED').expect(200);
    expect(completed.body.items.every((u) => u.status === 'COMPLETED')).toBe(true);

    const onLine = await request(app).get('/api/v1/units?lineId=BODY').expect(200);
    expect(onLine.body.items.every((u) => u.currentLine === 'BODY')).toBe(true);
  });

  it('GET /api/v1/units/:vin/history returns the route and every visit', async () => {
    const response = await request(app)
      .get(`/api/v1/units/${sampleVin}/history`)
      .expect(200);

    expect(response.body.visits).toHaveLength(MAIN_STATION_ROUTE.length);
    expect(response.body.route).toHaveLength(MAIN_STATION_ROUTE.length);
    expect(response.body.route.every((r) => r.state === 'DONE')).toBe(true);
    expect(response.body.progressPct).toBe(100);
  });

  it('refuses to move a vehicle off its route', async () => {
    const created = await request(app)
      .post('/api/v1/work-orders')
      .set('x-api-key', API_KEY)
      .send({ modelCode: 'NS-AURORA-EV', quantity: 1 })
      .expect(201);
    const released = await request(app)
      .post(`/api/v1/work-orders/${created.body.id}/release`)
      .set('x-api-key', API_KEY)
      .send({})
      .expect(200);
    const vin = released.body.units[0].vin;

    await request(app)
      .post(`/api/v1/units/${vin}/move`)
      .set('x-api-key', API_KEY)
      .send({ stationId: 'BODY-10' })
      .expect(200);

    const bad = await request(app)
      .post(`/api/v1/units/${vin}/move`)
      .set('x-api-key', API_KEY)
      .send({ stationId: 'FINAL-40' })
      .expect(409);

    expect(bad.body.error.code).toBe('INVALID_STATE_TRANSITION');
    expect(bad.body.error.message).toMatch(/Routing violation/);
  });

  it('returns 409 QUALITY_HOLD when a gate blocks a move', async () => {
    const created = await request(app)
      .post('/api/v1/work-orders')
      .set('x-api-key', API_KEY)
      .send({ modelCode: 'NS-AURORA-EV', quantity: 1 })
      .expect(201);
    const released = await request(app)
      .post(`/api/v1/work-orders/${created.body.id}/release`)
      .set('x-api-key', API_KEY)
      .send({})
      .expect(200);
    const vin = released.body.units[0].vin;

    for (const stationId of MAIN_STATION_ROUTE.slice(0, 5)) {
      await request(app)
        .post(`/api/v1/units/${vin}/move`)
        .set('x-api-key', API_KEY)
        .send({ stationId })
        .expect(200);
    }

    await request(app)
      .post('/api/v1/quality/defects')
      .set('x-api-key', API_KEY)
      .send({ code: 'DIM_OUT_OF_TOL', vin, stationId: 'BODY-50' })
      .expect(201);

    const blocked = await request(app)
      .post(`/api/v1/units/${vin}/move`)
      .set('x-api-key', API_KEY)
      .send({ stationId: 'PAINT-10' })
      .expect(409);

    expect(blocked.body.error.code).toBe('QUALITY_HOLD');
    expect(blocked.body.error.details.defects).toHaveLength(1);
  });
});

describe('station control', () => {
  it('returns a control view with the legal actions', async () => {
    const response = await request(app).get('/api/v1/stations/PAINT-40/control').expect(200);

    expect(response.body.control.mode).toBe('AUTO');
    expect(response.body.allowedActions).toEqual(expect.arrayContaining(['stop', 'maintenance']));
    expect(response.body.blockedActions.start).toBeTruthy();
    expect(response.body.pm).toHaveProperty('intervalCycles');
  });

  it('requires the API key to stop a station', async () => {
    await request(app).post('/api/v1/stations/PAINT-40/stop').send({}).expect(401);
  });

  it('stops, refuses a second stop with a reason, then starts', async () => {
    const stopped = await request(app)
      .post('/api/v1/stations/PAINT-50/stop')
      .set('x-api-key', API_KEY)
      .send({ operator: 'op-1', reasonCode: 'SHIFT_MEETING', reason: 'Toolbox talk' })
      .expect(200);
    expect(stopped.body.state).toBe('STOPPED');
    expect(stopped.body.control.reasonCode).toBe('SHIFT_MEETING');

    const again = await request(app)
      .post('/api/v1/stations/PAINT-50/stop')
      .set('x-api-key', API_KEY)
      .send({})
      .expect(409);
    expect(again.body.error.message).toMatch(/Already stopped/);

    const locked = await request(app)
      .post('/api/v1/stations/PAINT-50/state')
      .set('x-api-key', API_KEY)
      .send({ state: 'RUNNING' })
      .expect(409);
    expect(locked.body.error.message).toMatch(/locked in STOPPED/);

    const started = await request(app)
      .post('/api/v1/stations/PAINT-50/start')
      .set('x-api-key', API_KEY)
      .send({ operator: 'op-1' })
      .expect(200);
    expect(started.body.control.mode).toBe('AUTO');
  });

  it('rejects an unknown stop reason code', async () => {
    const response = await request(app)
      .post('/api/v1/stations/PAINT-10/stop')
      .set('x-api-key', API_KEY)
      .send({ reasonCode: 'BECAUSE' })
      .expect(400);
    expect(response.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('runs a maintenance order from start to sign-off', async () => {
    const started = await request(app)
      .post('/api/v1/stations/EOL-20/maintenance')
      .set('x-api-key', API_KEY)
      .send({ type: 'PREVENTIVE', technician: 'maint-771', plannedMinutes: 15 })
      .expect(201);

    const order = started.body.activeMaintenance;
    expect(order.id).toMatch(/^MWO-/);
    expect(order.checklist.length).toBeGreaterThan(0);

    await request(app)
      .post('/api/v1/stations/EOL-20/start')
      .set('x-api-key', API_KEY)
      .send({})
      .expect(409);

    const done = await request(app)
      .post('/api/v1/stations/EOL-20/maintenance/complete')
      .set('x-api-key', API_KEY)
      .send({ findings: 'Lens cleaned', checklist: [order.checklist[0].task] })
      .expect(200);
    expect(done.body.completedOrder.checklistComplete).toBe(false);

    const fetched = await request(app).get(`/api/v1/maintenance/${order.id}`).expect(200);
    expect(fetched.body.status).toBe('COMPLETED');

    const history = await request(app).get('/api/v1/stations/EOL-20/maintenance').expect(200);
    expect(history.body.history[0].id).toBe(order.id);
  });

  it('lists maintenance orders and the PM board', async () => {
    const orders = await request(app).get('/api/v1/maintenance?status=COMPLETED').expect(200);
    expect(orders.body.items.every((o) => o.status === 'COMPLETED')).toBe(true);

    const due = await request(app).get('/api/v1/maintenance/due').expect(200);
    expect(due.body.items).toHaveLength(43);
    expect(due.body.summary).toBeDefined();
  });

  it('serves maintenance reference data', async () => {
    const response = await request(app).get('/api/v1/reference/maintenance-types').expect(200);
    expect(response.body.items.map((t) => t.code).sort()).toEqual(['CORRECTIVE', 'PREDICTIVE', 'PREVENTIVE']);
  });
});

describe('quality', () => {
  it('records an inspection and raises defects for out-of-spec values', async () => {
    const response = await request(app)
      .post('/api/v1/quality/inspections')
      .set('x-api-key', API_KEY)
      .send({
        stationId: 'EOL-10',
        vin: sampleVin,
        inspector: 'qa-1',
        measurements: { 'TOE-FRONT': 0.42, 'CAMBER-FRONT': -0.5, 'THRUST-ANGLE': 0.02 }
      })
      .expect(201);

    expect(response.body.inspection.passed).toBe(false);
    expect(response.body.defects).toHaveLength(1);
    expect(response.body.defects[0].code).toBe('ALIGNMENT_OOS');
  });

  it('evaluates a gate without moving anything', async () => {
    const response = await request(app)
      .get(`/api/v1/quality/gate/${sampleVin}/EOL-60`)
      .expect(200);

    expect(response.body).toHaveProperty('pass');
    expect(response.body).toHaveProperty('recommendation');
  });

  it('summarises quality with Pareto, FPY and DPMO', async () => {
    const response = await request(app).get('/api/v1/quality/summary').expect(200);

    expect(response.body).toHaveProperty('firstPassYield');
    expect(response.body).toHaveProperty('paretoByCode');
    expect(response.body).toHaveProperty('sigmaLevel');
  });
});

describe('KPI', () => {
  it('GET /api/v1/kpi/dashboard returns every panel the HMI needs', async () => {
    const response = await request(app).get('/api/v1/kpi/dashboard').expect(200);

    expect(response.body.headline).toHaveProperty('oee');
    expect(response.body.lines).toHaveLength(7);
    expect(response.body.buffers.length).toBeGreaterThan(0);
    expect(response.body).toHaveProperty('quality');
    expect(response.body).toHaveProperty('workOrders');
  });

  it('GET /api/v1/kpi/oee keeps every factor inside 0..100', async () => {
    const response = await request(app).get('/api/v1/kpi/oee').expect(200);

    for (const line of response.body.lines) {
      expect(line.availability).toBeGreaterThanOrEqual(0);
      expect(line.availability).toBeLessThanOrEqual(100);
      expect(line.performance).toBeLessThanOrEqual(100);
      expect(line.quality).toBeLessThanOrEqual(100);
      expect(line.oee).toBeLessThanOrEqual(100);
    }
  });

  it('GET /api/v1/kpi/trend clamps the shift count', async () => {
    const response = await request(app).get('/api/v1/kpi/trend?shifts=999').expect(200);
    expect(response.body.items.length).toBeLessThanOrEqual(30);
  });
});

describe('traceability', () => {
  it('POST /api/v1/trace/recall finds the vehicles containing a lot', async () => {
    const lots = await request(app).get('/api/v1/trace/lots?limit=5').expect(200);
    const lotCode = lots.body.items[0].lotCode;

    const response = await request(app)
      .post('/api/v1/trace/recall')
      .set('x-api-key', API_KEY)
      .send({ lotCode, reason: 'api test' })
      .expect(200);

    expect(response.body.affectedCount).toBeGreaterThan(0);
    expect(response.body).toHaveProperty('byContainment');
    expect(response.body.recommendation.action).toMatch(/CONTAIN_IN_PLANT|FIELD_CAMPAIGN|SAFETY_RECALL/);
  });

  it('rejects a recall query with no search key', async () => {
    const response = await request(app)
      .post('/api/v1/trace/recall')
      .set('x-api-key', API_KEY)
      .send({ reason: 'nothing to search on' })
      .expect(400);

    expect(response.body.error.code).toBe('VALIDATION_FAILED');
  });

  it('GET /api/v1/trace/vehicle/:vin returns the complete as-built record', async () => {
    const response = await request(app).get(`/api/v1/trace/vehicle/${sampleVin}`).expect(200);

    expect(response.body.genealogy.stats.totalNodes).toBeGreaterThan(40);
    expect(response.body.subAssemblies.length).toBeGreaterThan(0);
    expect(response.body.suppliers.length).toBeGreaterThan(0);
    expect(response.body.genealogy.sealedAt).toBeTruthy();
  });

  it('404s an unknown VIN', async () => {
    const response = await request(app).get('/api/v1/trace/vehicle/2NSAURE1XTW999999').expect(404);
    expect(response.body.error.code).toBe('NOT_FOUND');
  });
});

describe('events', () => {
  it('GET /api/v1/events returns the log newest first', async () => {
    const response = await request(app).get('/api/v1/events?limit=10').expect(200);

    expect(response.body.items.length).toBeGreaterThan(0);
    const timestamps = response.body.items.map((e) => Date.parse(e.timestamp));
    expect(timestamps).toEqual([...timestamps].sort((a, b) => b - a));
  });

  it('filters events by type', async () => {
    const response = await request(app).get('/api/v1/events?type=unit.completed').expect(200);
    expect(response.body.items.every((e) => e.type === 'unit.completed')).toBe(true);
  });
});

describe('routing and documentation', () => {
  it('404s an unknown API route in JSON, not HTML', async () => {
    const response = await request(app).get('/api/v1/does-not-exist').expect(404);

    expect(response.body.error.code).toBe('ROUTE_NOT_FOUND');
    expect(response.body.error.details.hint).toMatch(/api-docs/);
  });

  it('serves the OpenAPI document', async () => {
    const response = await request(app).get('/openapi.json').expect(200);

    expect(response.body.openapi).toMatch(/^3\./);
    expect(Object.keys(response.body.paths).length).toBeGreaterThan(50);
  });

  it('serves Swagger UI', async () => {
    const response = await request(app).get('/api-docs').expect(200);
    expect(response.text).toMatch(/swagger-ui/);
  });

  it('serves the HMI at the root', async () => {
    const response = await request(app).get('/').expect(200);
    expect(response.text).toMatch(/Production Core/);
  });
});
