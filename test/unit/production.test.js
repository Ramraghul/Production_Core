'use strict';

const {
  makeContext, releaseUnits, fillBuffers, walkRoute, buildVehicle, MAIN_STATION_ROUTE
} = require('../helpers/factory');
const { isValidVin } = require('../../src/core/ids');

describe('releasing a work order', () => {
  it('mints one vehicle per unit, each with a valid VIN and an open genealogy', () => {
    const ctx = makeContext();
    const { vins } = releaseUnits(ctx, 3);

    expect(vins).toHaveLength(3);
    vins.forEach((vin) => {
      expect(isValidVin(vin)).toBe(true);
      expect(ctx.repository.get('genealogies', vin)).toBeTruthy();
    });
    expect(new Set(vins).size).toBe(3); // no duplicates
  });

  it('is incremental - releasing again pulls the next few vehicles', () => {
    const ctx = makeContext();
    const workOrder = ctx.production.createWorkOrder({ modelCode: 'NS-AURORA-EV', quantity: 10 });

    ctx.production.releaseWorkOrder(workOrder.id, { createUnits: 3 });
    ctx.production.releaseWorkOrder(workOrder.id, { createUnits: 4 });

    expect(ctx.repository.count('units', (u) => u.workOrderId === workOrder.id)).toBe(7);
  });

  it('never mints more vehicles than the order quantity', () => {
    const ctx = makeContext();
    const workOrder = ctx.production.createWorkOrder({ modelCode: 'NS-AURORA-EV', quantity: 2 });
    ctx.production.releaseWorkOrder(workOrder.id);

    expect(() => ctx.production.releaseWorkOrder(workOrder.id, { createUnits: 5 }))
      .toThrow(/already created all 2 of its units/);
  });

  it('refuses a duplicate work order id', () => {
    const ctx = makeContext();
    ctx.production.createWorkOrder({ id: 'WO-DUP', modelCode: 'NS-AURORA-EV', quantity: 1 });
    expect(() => ctx.production.createWorkOrder({
      id: 'WO-DUP', modelCode: 'NS-AURORA-EV', quantity: 1
    })).toThrow(/already exists/);
  });
});

describe('moving a vehicle through the plant', () => {
  it('back-flushes the parts consumed at each station into genealogy', () => {
    const ctx = makeContext();
    const { vins: [vin] } = releaseUnits(ctx, 1);

    ctx.production.moveUnit(vin, 'BODY-10');
    const genealogy = ctx.repository.get('genealogies', vin);
    const partNumbers = genealogy.components.map((c) => c.partNumber);

    // BODY-10 consumes the floor pan and both underbody rails.
    expect(partNumbers).toEqual(
      expect.arrayContaining(['PN-UB-FLOOR', 'PN-UB-RAIL-L', 'PN-UB-RAIL-R'])
    );
  });

  it('records a supplier lot for lot-controlled parts, and indexes it', () => {
    const ctx = makeContext();
    const { vins: [vin] } = releaseUnits(ctx, 1);
    ctx.production.moveUnit(vin, 'BODY-10');

    const floorPan = ctx.repository
      .get('genealogies', vin).components
      .find((c) => c.partNumber === 'PN-UB-FLOOR');

    expect(floorPan.lotCode).toMatch(/^MAGNA-PN-UB-FLOOR-/);
    expect(ctx.repository.vinsForLot(floorPan.lotCode)).toContain(vin);
  });

  it('installs the sub-assembly a station is due to fit', () => {
    const ctx = makeContext();
    const { vins: [vin] } = releaseUnits(ctx, 1);
    fillBuffers(ctx, vin);
    walkRoute(ctx, vin, { through: MAIN_STATION_ROUTE.indexOf('CHAS-10') + 1 });

    const powertrain = ctx.repository
      .all('subAssemblies')
      .find((s) => s.classCode === 'PWT' && s.consumedByVin === vin);

    expect(powertrain).toBeTruthy();
    expect(powertrain.consumedAtStation).toBe('CHAS-10');
    expect(ctx.repository.get('genealogies', vin).serialIndex).toContain(powertrain.serial);
  });

  it('carries on when a feeder has not delivered, rather than failing the move', () => {
    const ctx = makeContext();
    const { vins: [vin] } = releaseUnits(ctx, 1);
    // Deliberately no buffers: CHAS-10 has no powertrain to fit.
    expect(() => walkRoute(ctx, vin, { through: MAIN_STATION_ROUTE.indexOf('CHAS-10') + 1 }))
      .not.toThrow();

    expect(ctx.repository.get('units', vin).currentStation).toBe('CHAS-10');
  });

  it('advances to whatever the plant model says comes next', () => {
    const ctx = makeContext();
    const { vins: [vin] } = releaseUnits(ctx, 1);

    ctx.production.advanceUnit(vin);
    expect(ctx.repository.get('units', vin).currentStation).toBe('BODY-10');
    ctx.production.advanceUnit(vin);
    expect(ctx.repository.get('units', vin).currentStation).toBe('BODY-20');
  });

  it('publishes a unit.moved event with progress', () => {
    const ctx = makeContext();
    const { vins: [vin] } = releaseUnits(ctx, 1);
    ctx.production.moveUnit(vin, 'BODY-10');

    const [moved] = ctx.eventsOfType('unit.moved');
    expect(moved.payload.stationId).toBe('BODY-10');
    expect(moved.payload.lineId).toBe('BODY');
    expect(moved.vin).toBe(vin);
  });
});

describe('completing a vehicle', () => {
  it('seals the genealogy record, making it immutable', () => {
    const ctx = makeContext();
    const built = buildVehicle(ctx);
    const genealogy = ctx.repository.get('genealogies', built.vin);

    expect(genealogy.sealedAt).toBeTruthy();
    expect(() => require('../../src/core/genealogy').recordPart(
      genealogy, { partNumber: 'PN-HOOD' }, 'BODY-40'
    )).toThrow(/sealed .* and is immutable/);
  });

  it('increments the work order and closes it when the quantity is met', () => {
    const ctx = makeContext();
    const workOrder = ctx.production.createWorkOrder({ modelCode: 'NS-AURORA-EV', quantity: 1 });
    const { units } = ctx.production.releaseWorkOrder(workOrder.id);
    const vin = units[0].vin;

    fillBuffers(ctx, vin);
    const clock = walkRoute(ctx, vin);
    ctx.production.completeUnit(vin, {}, clock);

    const closed = ctx.repository.get('workOrders', workOrder.id);
    expect(closed.quantityCompleted).toBe(1);
    expect(closed.status).toBe('COMPLETED');
  });

  it('builds a full genealogy tree with sub-assemblies and lots', () => {
    const ctx = makeContext();
    const built = buildVehicle(ctx);
    const report = ctx.production.genealogyReport(built.vin);

    expect(report.stats.subAssemblies).toBe(7);
    expect(report.stats.parts).toBeGreaterThan(40);
    expect(report.stats.maxDepth).toBe(2); // vehicle -> sub-assembly -> part
    expect(report.stats.distinctLots).toBeGreaterThan(20);
    expect(report.estimatedMaterialCostCad).toBeGreaterThan(5000);
  });
});

describe('quality gates', () => {
  it('blocks a vehicle carrying an open critical defect', () => {
    const ctx = makeContext();
    const { vins: [vin] } = releaseUnits(ctx, 1);
    walkRoute(ctx, vin, { through: MAIN_STATION_ROUTE.indexOf('BODY-50') + 1 });

    ctx.quality.raiseDefect({ code: 'DIM_OUT_OF_TOL', vin, stationId: 'BODY-50' });

    expect(() => ctx.production.moveUnit(vin, 'PAINT-10'))
      .toThrow(/is held at BODY-50 by 1 open defect/);
    expect(ctx.repository.get('units', vin).currentStation).toBe('BODY-50');
  });

  it('lets the vehicle through once the defect is closed', () => {
    const ctx = makeContext();
    const { vins: [vin] } = releaseUnits(ctx, 1);
    walkRoute(ctx, vin, { through: MAIN_STATION_ROUTE.indexOf('BODY-50') + 1 });

    const defect = ctx.quality.raiseDefect({ code: 'DIM_OUT_OF_TOL', vin, stationId: 'BODY-50' });
    ctx.quality.dispositionDefect(defect.id, 'REWORK', { operator: 'tech-1' });
    ctx.quality.closeDefect(defect.id, { operator: 'qa-1' });

    expect(() => ctx.production.moveUnit(vin, 'PAINT-10')).not.toThrow();
  });

  it('publishes a gate.blocked event naming the blocking defects', () => {
    const ctx = makeContext();
    const { vins: [vin] } = releaseUnits(ctx, 1);
    walkRoute(ctx, vin, { through: MAIN_STATION_ROUTE.indexOf('BODY-50') + 1 });
    ctx.quality.raiseDefect({ code: 'DIM_OUT_OF_TOL', vin, stationId: 'BODY-50' });

    expect(() => ctx.production.moveUnit(vin, 'PAINT-10')).toThrow();

    const [blocked] = ctx.eventsOfType('quality.gate.blocked');
    expect(blocked.payload.stationId).toBe('BODY-50');
    expect(blocked.payload.defects).toHaveLength(1);
  });

  it('can be overridden, which is what a manual MES override looks like', () => {
    const ctx = makeContext();
    const { vins: [vin] } = releaseUnits(ctx, 1);
    walkRoute(ctx, vin, { through: MAIN_STATION_ROUTE.indexOf('BODY-50') + 1 });
    ctx.quality.raiseDefect({ code: 'DIM_OUT_OF_TOL', vin, stationId: 'BODY-50' });

    expect(() => ctx.production.moveUnit(vin, 'PAINT-10', { force: true })).not.toThrow();
  });

  it('does not block on a minor defect', () => {
    const ctx = makeContext();
    const { vins: [vin] } = releaseUnits(ctx, 1);
    walkRoute(ctx, vin, { through: MAIN_STATION_ROUTE.indexOf('BODY-50') + 1 });
    ctx.quality.raiseDefect({ code: 'SCRATCH', vin, stationId: 'BODY-50' });

    expect(ctx.quality.evaluateGate(vin, 'BODY-50').pass).toBe(true);
  });

  it('runs an inspection plan and raises a defect per out-of-spec characteristic', () => {
    const ctx = makeContext();
    const { vins: [vin] } = releaseUnits(ctx, 1);

    const { inspection, defects } = ctx.quality.recordInspection({
      stationId: 'BODY-50',
      vin,
      measurements: { 'CMM-A-PILLAR': 1.4, 'CMM-ROCKER': 0.2, 'WELD-COUNT': 409 },
      inspector: 'qa-1'
    });

    expect(inspection.passed).toBe(false);
    expect(inspection.failedCharacteristics).toEqual(['CMM-A-PILLAR', 'WELD-COUNT']);
    expect(defects.map((d) => d.code).sort()).toEqual(['DIM_OUT_OF_TOL', 'WELD_MISSING']);
    expect(defects.every((d) => d.severity === 'CRITICAL')).toBe(true);
  });

  it('refuses an inspection that is missing a measurement', () => {
    const ctx = makeContext();
    const { vins: [vin] } = releaseUnits(ctx, 1);

    expect(() => ctx.quality.recordInspection({
      stationId: 'BODY-50', vin, measurements: { 'CMM-A-PILLAR': 0.1 }
    })).toThrow(/Missing measurement for characteristic 'CMM-ROCKER'/);
  });

  it('scraps the vehicle when a defect is dispositioned SCRAP', () => {
    const ctx = makeContext();
    const { vins: [vin] } = releaseUnits(ctx, 1);
    walkRoute(ctx, vin, { through: 3 });

    const defect = ctx.quality.raiseDefect({ code: 'WELD_MISSING', vin, stationId: 'BODY-30' });
    ctx.quality.dispositionDefect(defect.id, 'SCRAP', { operator: 'qa-1' });

    expect(ctx.repository.get('units', vin).status).toBe('SCRAPPED');
  });

  it('never allows a critical defect to be waived USE_AS_IS', () => {
    const ctx = makeContext();
    const { vins: [vin] } = releaseUnits(ctx, 1);
    const defect = ctx.quality.raiseDefect({ code: 'TORQUE_LOW', vin, stationId: 'CHAS-10' });

    expect(() => ctx.quality.dispositionDefect(defect.id, 'USE_AS_IS'))
      .toThrow(/CRITICAL defect cannot be dispositioned USE_AS_IS/);
  });
});

describe('recall analysis', () => {
  it('finds every vehicle containing a suspect lot', () => {
    const ctx = makeContext();
    const built = [buildVehicle(ctx), buildVehicle(ctx), buildVehicle(ctx)];

    const lotCode = ctx.repository
      .get('genealogies', built[0].vin)
      .lotIndex.find((lot) => lot.startsWith('MAGNA-PN-UB-FLOOR'));

    const report = ctx.trace.recall({ lotCode, reason: 'test' });

    expect(report.affectedCount).toBeGreaterThan(0);
    expect(report.affected.map((a) => a.vin)).toContain(built[0].vin);
    expect(report.affected[0].matches[0].lotCode).toBe(lotCode);
  });

  it('splits the affected vehicles by where they are now', () => {
    const ctx = makeContext();
    const built = buildVehicle(ctx);
    const lotCode = ctx.repository.get('genealogies', built.vin).lotIndex[0];

    const report = ctx.trace.recall({ lotCode });
    const total = Object.values(report.byContainment).reduce((a, b) => a + b, 0);

    expect(total).toBe(report.affectedCount);
    expect(report.containableNow).toBeLessThanOrEqual(report.affectedCount);
  });

  it('recommends containment when nothing has shipped', () => {
    const ctx = makeContext();
    const built = buildVehicle(ctx);
    const lotCode = ctx.repository.get('genealogies', built.vin).lotIndex[0];

    // Judged an hour after the build, so nothing has had time to ship.
    const report = ctx.trace.recall({ lotCode }, new Date('2026-09-16T13:30:00Z'));
    expect(report.recommendation.action).toBe('CONTAIN_IN_PLANT');
  });

  it('judges containment at the query clock, not the wall clock', () => {
    // Regression: containment read Date.now(), so this exact scenario flipped
    // from CONTAIN_IN_PLANT to SAFETY_RECALL a day after the test was written.
    const ctx2 = makeContext();
    const built = buildVehicle(ctx2);
    const lotCode = ctx2.repository.get('genealogies', built.vin).lotIndex[0];

    const soon = ctx2.trace.recall({ lotCode }, new Date('2026-09-16T13:30:00Z'));
    const later = ctx2.trace.recall({ lotCode }, new Date('2026-09-20T13:30:00Z'));

    expect(soon.byContainment.FINISHED_GOODS).toBe(1);
    expect(later.byContainment.SHIPPED).toBe(1);
  });

  it('reports no action for a lot the plant never used', () => {
    const ctx = makeContext();
    buildVehicle(ctx);
    const report = ctx.trace.recall({ lotCode: 'NOBODY-PN-NOTHING-9999Z' });

    expect(report.affectedCount).toBe(0);
    expect(report.recommendation.action).toBe('NO_ACTION');
  });

  it('requires something to search on', () => {
    const ctx = makeContext();
    expect(() => ctx.trace.recall({})).toThrow(/requires one of lotCode, serial or partNumber/);
  });

  it('traces a serialised sub-assembly back to exactly one vehicle', () => {
    const ctx = makeContext();
    const built = buildVehicle(ctx);
    const serial = ctx.repository.get('genealogies', built.vin).serialIndex[0];

    const report = ctx.trace.recall({ serial });
    expect(report.affectedCount).toBe(1);
    expect(report.affected[0].vin).toBe(built.vin);
  });

  it('reports where a lot was consumed across the plant', () => {
    const ctx = makeContext();
    buildVehicle(ctx);
    buildVehicle(ctx);

    const lotCode = ctx.repository.knownLots().find((l) => ctx.repository.vinsForLot(l).length > 1)
      || ctx.repository.knownLots()[0];
    const usage = ctx.trace.lotUsage(lotCode);

    expect(usage.vinCount).toBeGreaterThan(0);
    expect(usage.stations.length).toBeGreaterThan(0);
    expect(usage.firstUsedAt).toBeTruthy();
  });
});

describe('andon and downtime coupling', () => {
  it('a line-stopping call puts the station down and opens a downtime record', () => {
    const ctx = makeContext();
    const andon = ctx.operations.raiseAndon({
      stationId: 'PAINT-40', callType: 'MAINTENANCE', raisedBy: 'op-1'
    });

    expect(andon.stopsLine).toBe(true);
    expect(ctx.operations.getStationState('PAINT-40').state).toBe('DOWN');
    expect(andon.downtimeId).toBeTruthy();
    expect(ctx.operations.currentStops()).toHaveLength(1);
  });

  it('resolving the call brings the station back and closes the downtime', () => {
    const ctx = makeContext();
    const at = new Date('2026-09-16T08:00:00Z');
    const andon = ctx.operations.raiseAndon(
      { stationId: 'PAINT-40', callType: 'MAINTENANCE' }, at
    );

    ctx.operations.acknowledgeAndon(andon.id, 'maint-1', new Date(at.getTime() + 60000));
    ctx.operations.resolveAndon(
      andon.id, 'Replaced drive', 'maint-1', new Date(at.getTime() + 900000)
    );

    expect(ctx.operations.getStationState('PAINT-40').state).toBe('RUNNING');
    expect(ctx.operations.currentStops()).toHaveLength(0);
    expect(ctx.repository.get('downtimes', andon.downtimeId).durationSeconds).toBe(900);
  });

  it('a non-stopping call leaves the line running', () => {
    const ctx = makeContext();
    ctx.operations.setStationState('TRIM-10', 'RUNNING');
    ctx.operations.raiseAndon({ stationId: 'TRIM-10', callType: 'MATERIAL' });

    expect(ctx.operations.getStationState('TRIM-10').state).toBe('RUNNING');
  });

  it('discards a micro-stop rather than logging it as downtime', () => {
    const ctx = makeContext();
    const at = new Date('2026-09-16T08:00:00Z');

    ctx.operations.setStationState('TRIM-10', 'RUNNING', {}, at);
    ctx.operations.setStationState('TRIM-10', 'BLOCKED', {}, at);
    // Four seconds of blocking is a minor stoppage, not a breakdown.
    ctx.operations.setStationState('TRIM-10', 'RUNNING', {}, new Date(at.getTime() + 4000));

    expect(ctx.repository.count('downtimes')).toBe(0);
    expect(ctx.operations.microStops.total).toBe(1);
  });

  it('keeps a stop that exceeds the threshold', () => {
    const ctx = makeContext();
    const at = new Date('2026-09-16T08:00:00Z');

    ctx.operations.setStationState('TRIM-10', 'RUNNING', {}, at);
    ctx.operations.setStationState('TRIM-10', 'BLOCKED', {}, at);
    ctx.operations.setStationState('TRIM-10', 'RUNNING', {}, new Date(at.getTime() + 180000));

    expect(ctx.repository.count('downtimes')).toBe(1);
    expect(ctx.operations.microStops.total).toBe(0);
  });

  it('escalates a call that has blown its SLA', () => {
    const ctx = makeContext();
    const at = new Date('2026-09-16T08:00:00Z');
    ctx.operations.raiseAndon({ stationId: 'TRIM-10', callType: 'MATERIAL' }, at);

    // MATERIAL has a 180 s SLA; sweep 10 minutes later.
    const escalated = ctx.operations.sweepEscalations(new Date(at.getTime() + 600000));

    expect(escalated).toHaveLength(1);
    expect(escalated[0].status).toBe('ESCALATED');
    expect(escalated[0].escalatedTo).toBe('AREA_SUPERVISOR');
  });
});
