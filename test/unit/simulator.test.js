'use strict';

const { Simulator } = require('../../src/simulator');
const { FaultModel } = require('../../src/simulator/faultModel');
const { makeContext, releaseUnits, walkRoute } = require('../helpers/factory');
const { createRandom } = require('../../src/core/ids');
const plantModel = require('../../src/core/plantModel');

/** Drive the simulator synchronously, without waiting on real timers. */
function runTicks(simulator, count) {
  for (let i = 0; i < count; i += 1) simulator.tick();
}

describe('fault model', () => {
  const station = plantModel.getStation('PAINT-40');

  it('never fails anything when faults are disabled', () => {
    const model = new FaultModel(createRandom(1), { enabled: false });
    for (let i = 0; i < 1000; i += 1) {
      expect(model.shouldFail(station, 3600)).toBe(false);
    }
  });

  it('fails at roughly the rate its MTBF implies', () => {
    // PAINT-40 has a 360-minute MTBF, so over a simulated hour the hazard is
    // 1 - exp(-1/6) ~ 15%. Checked as a band, not a point, to stay stable.
    const model = new FaultModel(createRandom(99));
    let failures = 0;
    for (let i = 0; i < 2000; i += 1) {
      if (model.shouldFail(station, 3600)) failures += 1;
    }
    const rate = failures / 2000;
    expect(rate).toBeGreaterThan(0.10);
    expect(rate).toBeLessThan(0.22);
  });

  it('honours an explicit repair deadline over the MTTR distribution', () => {
    const model = new FaultModel(createRandom(3));
    model.scheduleRepair(station.id, 300);

    expect(model.shouldRepair(station, 100)).toBe(false);
    expect(model.shouldRepair(station, 100)).toBe(false);
    expect(model.shouldRepair(station, 200)).toBe(true);
    // The deadline is consumed, so the next call falls back to MTTR.
    expect(typeof model.shouldRepair(station, 1)).toBe('boolean');
  });

  it('chooses a call type that matches what the station does', () => {
    const model = new FaultModel(createRandom(5));
    const robotCell = plantModel.getStation('BODY-20');       // 12 robots
    const testStation = plantModel.getStation('EOL-30');      // TEST

    const robotCalls = new Set();
    const testCalls = new Set();
    for (let i = 0; i < 200; i += 1) {
      robotCalls.add(model.callTypeFor(robotCell));
      testCalls.add(model.callTypeFor(testStation));
    }

    expect(robotCalls.has('MAINTENANCE')).toBe(true);
    expect(testCalls.has('QUALITY')).toBe(true);
    // A robot cell never calls for material.
    expect(robotCalls.has('MATERIAL')).toBe(false);
  });

  it('shapes telemetry by what the station physically does', () => {
    const model = new FaultModel(createRandom(7));

    const weld = model.telemetryFor(plantModel.getStation('BODY-20'), 'RUNNING');
    expect(weld).toHaveProperty('weldCurrentA');
    expect(weld).toHaveProperty('electrodeForceN');

    const paint = model.telemetryFor(plantModel.getStation('PAINT-40'), 'RUNNING');
    expect(paint).toHaveProperty('boothHumidityPct');
    expect(paint).toHaveProperty('filmThicknessUm');

    const torque = model.telemetryFor(plantModel.getStation('CHAS-10'), 'RUNNING');
    expect(torque).toHaveProperty('lastTorqueNm');

    const inspect = model.telemetryFor(plantModel.getStation('BODY-50'), 'RUNNING');
    expect(inspect).toHaveProperty('scanCoveragePct');
  });

  it('reports idle values for a stopped station', () => {
    const model = new FaultModel(createRandom(9));
    const stopped = model.telemetryFor(plantModel.getStation('BODY-20'), 'DOWN');

    expect(stopped.cycleSeconds).toBe(0);
    expect(stopped.weldCurrentA).toBe(0);
  });

  it('produces an operator symptom and a corrective action for every call type', () => {
    const model = new FaultModel(createRandom(11));
    for (const callType of ['MAINTENANCE', 'QUALITY', 'MATERIAL', 'TOOLING', 'PROCESS', 'SAFETY']) {
      expect(typeof model.symptomFor(callType)).toBe('string');
      expect(typeof model.correctiveAction(callType)).toBe('string');
    }
    // Unknown types fall back rather than returning undefined.
    expect(typeof model.symptomFor('NONSENSE')).toBe('string');
  });
});

describe('simulator', () => {
  let ctx;
  let simulator;

  beforeEach(() => {
    ctx = makeContext();
    simulator = new Simulator(ctx, { speed: 60, tickMs: 250, seed: 20260916, faults: true });
    ctx.simulator = simulator;
  });

  afterEach(() => simulator.stop());

  it('reports its configuration and counters', () => {
    const status = simulator.status();

    expect(status.enabled).toBe(true);
    expect(status.running).toBe(false);
    expect(status.speed).toBe(60);
    expect(status.counters.ticks).toBe(0);
  });

  it('starts, changes speed and stops', () => {
    simulator.start();
    expect(simulator.status().running).toBe(true);

    simulator.setSpeed(10);
    expect(simulator.status().speed).toBe(10);

    simulator.stop();
    expect(simulator.status().running).toBe(false);
  });

  it('is idempotent on repeated starts', () => {
    simulator.start();
    const first = simulator.startedAt;
    simulator.start();
    expect(simulator.startedAt).toBe(first);
  });

  it('launches vehicles and moves them down the line', () => {
    simulator.start();
    runTicks(simulator, 400);

    expect(simulator.counters.unitsLaunched).toBeGreaterThan(0);
    expect(simulator.counters.stationCycles).toBeGreaterThan(0);
    expect(ctx.repository.count('units')).toBeGreaterThan(0);
  });

  it('opens a work order of its own when the plant has run dry', () => {
    simulator.start();
    runTicks(simulator, 50);

    expect(ctx.repository.count('workOrders')).toBeGreaterThan(0);
  });

  it('completes vehicles end to end, sealing their genealogy', () => {
    simulator.start();
    // ~27 stations at 60 s each, 15 simulated seconds per tick.
    runTicks(simulator, 2000);

    expect(simulator.counters.unitsCompleted).toBeGreaterThan(0);

    const completed = ctx.repository.all('units').filter((u) => u.status === 'COMPLETED');
    for (const unit of completed.slice(0, 5)) {
      expect(ctx.repository.get('genealogies', unit.vin).sealedAt).toBeTruthy();
    }
  });

  it('keeps the feeder buffers supplied', () => {
    simulator.start();
    runTicks(simulator, 400);

    expect(simulator.counters.subAssembliesBuilt).toBeGreaterThan(0);
    const buffers = ctx.production.bufferLevels();
    expect(buffers.some((b) => b.available > 0)).toBe(true);
  });

  it('emits telemetry for a sample of stations rather than all of them', () => {
    simulator.start();
    runTicks(simulator, 20);

    const telemetry = ctx.repository.seriesRaw('telemetry');
    expect(telemetry.length).toBeGreaterThan(0);
    // A sample, not the whole plant on every tick.
    expect(telemetry.length).toBeLessThan(20 * plantModel.ALL_STATIONS.length);
    expect(telemetry[0]).toHaveProperty('metrics');
  });

  it('never leaves a vehicle stuck on hold forever', () => {
    // The repair bay must drain held vehicles; without it they accumulate at
    // the end of the line and back the whole quality line up.
    simulator.start();
    runTicks(simulator, 1500);
    const peakHeld = ctx.repository.count('units', (u) => u.status === 'HOLD');

    runTicks(simulator, 1500);
    const laterHeld = ctx.repository.count('units', (u) => u.status === 'HOLD');

    expect(laterHeld).toBeLessThanOrEqual(Math.max(peakHeld, 5));
  });

  it('injects a fault on demand and schedules its repair', () => {
    const result = simulator.injectFault('PAINT-40', 'ROBOT_FAULT', 600);

    expect(result.state.state).toBe('DOWN');
    expect(ctx.operations.currentStops().some((s) => s.stationId === 'PAINT-40')).toBe(true);
    expect(simulator.counters.faultsInjected).toBe(1);
  });

  it('rejects a fault injected at an unknown station', () => {
    expect(() => simulator.injectFault('NOPE-99')).toThrow(/Station 'NOPE-99' was not found/);
  });

  it('injects a defect on demand', () => {
    const { vins: [vin] } = releaseUnits(ctx, 1);
    walkRoute(ctx, vin, { through: 3 });

    const defect = simulator.injectDefect(vin, 'TORQUE_LOW');
    expect(defect.code).toBe('TORQUE_LOW');
    expect(defect.severity).toBe('CRITICAL');
    expect(ctx.repository.get('units', vin).openDefectIds).toContain(defect.id);
  });

  it('picks up vehicles already on the floor when it starts', () => {
    const { vins: [vin] } = releaseUnits(ctx, 1);
    walkRoute(ctx, vin, { through: 4 });

    simulator.start();
    const occupied = simulator.status().occupancy.map((o) => o.vin);
    expect(occupied).toContain(vin);
  });

  it('reconciles station states with where the vehicles actually are', () => {
    // Seeded demo data assigns states at random; if the head of the line comes
    // up marked BLOCKED, the simulator would never launch anything.
    ctx.operations.setStationState('BODY-10', 'BLOCKED');
    simulator.start();

    expect(ctx.operations.getStationState('BODY-10').state).toBe('IDLE');
  });

  it('survives a tick that throws, rather than taking the plant down', () => {
    simulator.start();
    const broken = jest.spyOn(ctx.production, 'moveUnit').mockImplementation(() => {
      throw new Error('simulated failure');
    });

    expect(() => runTicks(simulator, 5)).not.toThrow();
    broken.mockRestore();
  });

  it('runs deterministically for a given seed', () => {
    const a = new Simulator(makeContext(), { speed: 60, tickMs: 250, seed: 777 });
    const b = new Simulator(makeContext(), { speed: 60, tickMs: 250, seed: 777 });

    a.start(); b.start();
    runTicks(a, 300); runTicks(b, 300);

    expect(a.counters.unitsLaunched).toBe(b.counters.unitsLaunched);
    expect(a.counters.stationCycles).toBe(b.counters.stationCycles);

    a.stop(); b.stop();
  });
});
