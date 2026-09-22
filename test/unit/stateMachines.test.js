'use strict';

const workOrder = require('../../src/core/workOrder');
const unit = require('../../src/core/unit');
const sub = require('../../src/core/subAssembly');
const { MAIN_STATION_ROUTE } = require('../../src/core/plantModel');
const ids = require('../../src/core/ids');

const vin = ids.buildVin({ vds: 'AURE1', year: 2026, sequence: 1 });

describe('work order lifecycle', () => {
  const make = () => workOrder.createWorkOrder({
    id: 'WO-TEST-1', modelCode: 'NS-AURORA-EV', quantity: 10
  });

  it('starts in DRAFT', () => {
    expect(make().status).toBe('DRAFT');
  });

  it('rejects an unknown model and a bad quantity together', () => {
    expect.assertions(2);
    try {
      workOrder.createWorkOrder({ id: 'X', modelCode: 'NOPE', quantity: 0 });
    } catch (error) {
      expect(error.code).toBe('VALIDATION_FAILED');
      // All problems are reported at once, not one per round trip.
      expect(error.details).toHaveLength(2);
    }
  });

  it('rejects a colour the model is not offered in', () => {
    expect.assertions(1);
    try {
      workOrder.createWorkOrder({
        id: 'X', modelCode: 'NS-AURORA-EV', quantity: 1, colour: 'Fluorescent Pink'
      });
    } catch (error) {
      // Field-level problems are reported in details so a client can map them
      // back onto form fields; the top-level message stays generic.
      expect(error.details).toContainEqual(
        expect.objectContaining({ field: 'colour' })
      );
    }
  });

  it('walks DRAFT -> RELEASED -> IN_PROGRESS -> COMPLETED', () => {
    let order = make();
    order = workOrder.transition(order, 'RELEASED');
    expect(order.releasedAt).toBeTruthy();
    order = workOrder.transition(order, 'IN_PROGRESS');
    expect(order.startedAt).toBeTruthy();
    order = workOrder.transition(order, 'COMPLETED');
    expect(order.completedAt).toBeTruthy();
  });

  it('refuses an illegal transition and names what is allowed', () => {
    const order = workOrder.transition(make(), 'RELEASED');
    expect(() => workOrder.transition(order, 'DRAFT'))
      .toThrow(/cannot move RELEASED -> DRAFT; allowed: IN_PROGRESS, ON_HOLD, CANCELLED/);
  });

  it('treats COMPLETED and CANCELLED as terminal', () => {
    const done = workOrder.transition(
      workOrder.transition(workOrder.transition(make(), 'RELEASED'), 'IN_PROGRESS'),
      'COMPLETED'
    );
    expect(workOrder.isTerminal(done.status)).toBe(true);
    expect(() => workOrder.transition(done, 'IN_PROGRESS')).toThrow(/no longer change state/);
  });

  it('records and clears the hold reason', () => {
    let order = workOrder.transition(make(), 'RELEASED');
    order = workOrder.transition(order, 'ON_HOLD', { reason: 'Awaiting seats' });
    expect(order.holdReason).toBe('Awaiting seats');
    order = workOrder.transition(order, 'IN_PROGRESS');
    expect(order.holdReason).toBeNull();
  });

  it('computes progress and yield', () => {
    const order = { ...make(), quantityStarted: 10, quantityCompleted: 7, quantityScrapped: 1 };
    const progress = workOrder.progress(order);

    expect(progress.completionPct).toBe(70);
    expect(progress.yieldPct).toBe(87.5); // 7 good of 8 finished
    expect(progress.wip).toBe(2);
  });

  it('flags an order that cannot make its due date at the current rate', () => {
    const order = {
      ...make(),
      status: 'IN_PROGRESS',
      quantity: 500,
      quantityCompleted: 100,
      dueDate: '2026-09-17T00:00:00Z'
    };
    const risk = workOrder.scheduleRisk(order, 20, new Date('2026-09-16T12:00:00Z'));

    expect(risk.atRisk).toBe(true);
    expect(risk.hoursRequired).toBe(20);
    expect(risk.hoursAvailable).toBe(12);
    expect(risk.shortfallHours).toBe(8);
  });
});

describe('vehicle lifecycle', () => {
  const make = () => unit.createUnit({
    vin, workOrderId: 'WO-1', modelCode: 'NS-AURORA-EV', buildNumber: 1
  });

  it('rejects a VIN that fails its check digit', () => {
    expect.assertions(1);
    try {
      unit.createUnit({
        vin: '2NSAURE10TW000001', workOrderId: 'WO-1', modelCode: 'NS-AURORA-EV'
      });
    } catch (error) {
      expect(error.details).toContainEqual({
        field: 'vin', message: 'vin failed ISO 3779 check-digit validation'
      });
    }
  });

  it('enforces the routing - a vehicle cannot skip stations', () => {
    const moved = unit.moveToStation(make(), MAIN_STATION_ROUTE[0]);
    expect(() => unit.moveToStation(moved, 'FINAL-40'))
      .toThrow(/Routing violation: .* must go to BODY-20 next, not FINAL-40/);
  });

  it('allows a routing override, and records that one happened', () => {
    const moved = unit.moveToStation(make(), MAIN_STATION_ROUTE[0]);
    const forced = unit.moveToStation(moved, 'FINAL-40', { force: true, operator: 'supervisor' });

    expect(forced.currentStation).toBe('FINAL-40');
    expect(forced.lastOverrideBy).toBe('supervisor');
    expect(forced.lastOverrideAt).toBeTruthy();
  });

  it('allows re-entering the same station, which is a rework loop', () => {
    const moved = unit.moveToStation(make(), MAIN_STATION_ROUTE[0]);
    expect(() => unit.moveToStation(moved, MAIN_STATION_ROUTE[0])).not.toThrow();
  });

  it('records a station visit with cycle time and variance on exit', () => {
    const start = new Date('2026-09-16T12:00:00Z');
    let vehicle = unit.moveToStation(make(), 'BODY-10', { at: start });
    vehicle = unit.moveToStation(vehicle, 'BODY-20', {
      at: new Date(start.getTime() + 70000), operator: 'op-1'
    });

    const visit = vehicle.history[0];
    expect(visit.stationId).toBe('BODY-10');
    expect(visit.cycleSeconds).toBe(70);
    expect(visit.idealCycleSeconds).toBe(56);
    expect(visit.cycleVarianceSeconds).toBe(14); // 70 - 56, a performance loss
    expect(visit.operator).toBe('op-1');
  });

  it('tracks which quality gates have been cleared', () => {
    let vehicle = make();
    for (const stationId of MAIN_STATION_ROUTE.slice(0, 6)) {
      vehicle = unit.moveToStation(vehicle, stationId);
    }
    expect(vehicle.gatesPassed).toContain('BODY-50');
  });

  it('refuses to complete anywhere but the release station', () => {
    const vehicle = unit.moveToStation(make(), 'BODY-10');
    expect(() => unit.complete(vehicle)).toThrow(/not the end-of-line release station/);
  });

  it('refuses to complete a vehicle carrying an open defect', () => {
    let vehicle = make();
    for (const stationId of MAIN_STATION_ROUTE) {
      vehicle = unit.moveToStation(vehicle, stationId);
    }
    vehicle = unit.addDefect(vehicle, 'DEF-1');
    expect(() => unit.complete(vehicle)).toThrow(/open defect/);

    vehicle = unit.clearDefect(vehicle, 'DEF-1');
    expect(() => unit.complete(vehicle)).not.toThrow();
  });

  it('is terminal once completed', () => {
    let vehicle = make();
    for (const stationId of MAIN_STATION_ROUTE) vehicle = unit.moveToStation(vehicle, stationId);
    const done = unit.complete(vehicle);

    expect(done.status).toBe('COMPLETED');
    expect(() => unit.moveToStation(done, 'BODY-10')).toThrow(/cannot be moved/);
    expect(() => unit.scrap(done, 'too late')).toThrow(/no further transitions/);
  });

  it('is terminal once scrapped, and remembers where', () => {
    const vehicle = unit.moveToStation(make(), 'BODY-10');
    const scrapped = unit.scrap(vehicle, 'Weld burn-through', { operator: 'qa-1' });

    expect(scrapped.status).toBe('SCRAPPED');
    expect(scrapped.scrappedAtStation).toBe('BODY-10');
    expect(scrapped.currentStation).toBeNull();
  });

  it('counts a vehicle as first-pass only if it never failed or was reworked', () => {
    let clean = make();
    for (const stationId of MAIN_STATION_ROUTE) clean = unit.moveToStation(clean, stationId);
    expect(unit.isFirstPass(unit.complete(clean))).toBe(true);

    let dirty = unit.moveToStation(make(), 'BODY-10');
    dirty = unit.moveToStation(dirty, 'BODY-20', { result: 'REWORKED' });
    expect(unit.isFirstPass(dirty)).toBe(false);
  });

  it('reports route progress from 0 to 100', () => {
    expect(unit.routeProgress(make())).toBe(0);
    let vehicle = make();
    for (const stationId of MAIN_STATION_ROUTE) vehicle = unit.moveToStation(vehicle, stationId);
    expect(unit.routeProgress(vehicle)).toBe(100);
    expect(unit.routeProgress(unit.complete(vehicle))).toBe(100);
  });

  it('walks HOLD -> REWORK -> IN_PROCESS', () => {
    let vehicle = unit.moveToStation(make(), 'BODY-10');
    vehicle = unit.hold(vehicle, 'Suspect lot');
    expect(vehicle.status).toBe('HOLD');
    vehicle = unit.sendToRework(vehicle, 'Repair');
    expect(vehicle.reworkCount).toBe(1);
    vehicle = unit.release(vehicle);
    expect(vehicle.status).toBe('IN_PROCESS');
    expect(vehicle.holdReason).toBeNull();
  });
});

describe('sub-assembly lifecycle', () => {
  const makePwt = () => sub.createSubAssembly({ serial: 'PWT-26259-000001', classCode: 'PWT' });

  it('requires forVin for a broadcast-built class', () => {
    expect.assertions(1);
    try {
      sub.createSubAssembly({ serial: 'DRS-1', classCode: 'DRS' });
    } catch (error) {
      expect(error.details).toContainEqual(
        expect.objectContaining({ field: 'forVin' })
      );
    }
  });

  it('can be consumed exactly once, ever', () => {
    const built = sub.completeBuild(makePwt());
    const consumed = sub.consume(built, vin, 'CHAS-10');

    expect(consumed.consumedByVin).toBe(vin);
    expect(() => sub.consume(consumed, 'OTHER-VIN', 'CHAS-10'))
      .toThrow(/no further transitions/);
  });

  it('refuses to fit a broadcast module to the wrong vehicle', () => {
    const doors = sub.completeBuild(sub.createSubAssembly({
      serial: 'DRS-26259-000001', classCode: 'DRS', forVin: vin
    }));

    expect(() => sub.consume(doors, '2NSAURE12TW009999', 'FINAL-30'))
      .toThrow(/broadcast-built for .* and cannot be fitted/);
    expect(() => sub.consume(doors, vin, 'FINAL-30')).not.toThrow();
  });

  it('quarantines a module that failed its functional test', () => {
    let module = makePwt();
    module = sub.addTestResult(module, { testId: 'IP-PT-HOTTEST', passed: false });
    module = sub.completeBuild(module);

    expect(module.status).toBe('QUARANTINED');
    expect(module.quarantineReason).toMatch(/Failed 1 test/);
    // The quarantine reason must survive into the refusal, so an operator is
    // told why rather than just that a state transition was illegal.
    expect(() => sub.consume(module, vin, 'CHAS-10'))
      .toThrow(/quarantined and cannot be fitted: Failed 1 test/);
  });

  it('refuses components once the build is closed', () => {
    const built = sub.completeBuild(makePwt());
    expect(() => sub.addComponent(built, { partNumber: 'PN-ALTERNATOR' }))
      .toThrow(/only be added while a sub-assembly is BUILDING/);
  });

  it('knows where each class is installed', () => {
    expect(sub.installStationFor('PWT')).toBe('CHAS-10');
    expect(sub.installStationFor('WHS')).toBe('FINAL-10');
    expect(sub.classesConsumedAt('CHAS-10')).toContain('PWT');
  });
});
