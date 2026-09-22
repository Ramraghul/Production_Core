'use strict';

const control = require('../../src/core/stationControl');
const { getStation } = require('../../src/core/plantModel');
const { Simulator } = require('../../src/simulator');
const config = require('../../src/config');
const { makeContext, releaseUnits, walkRoute } = require('../helpers/factory');

const at = (minutes) => new Date(Date.UTC(2026, 8, 21, 14, 0, 0) + minutes * 60000);

describe('control rules', () => {
  const stationState = (overrides) => ({
    stationId: 'PAINT-40', state: 'RUNNING', control: { mode: 'AUTO' }, ...overrides
  });

  it('treats a missing control block as AUTO', () => {
    expect(control.controlOf({}).mode).toBe('AUTO');
    expect(control.isLocked({ state: 'RUNNING' })).toBe(false);
  });

  it('offers stop and maintenance on a running station, never start', () => {
    const { allowed, blocked } = control.availableActions(stationState());
    expect(allowed.sort()).toEqual(['maintenance', 'stop']);
    expect(blocked.start).toMatch(/Already in service/);
  });

  it('offers start and maintenance on an operator stop', () => {
    const { allowed } = control.availableActions(stationState({
      state: 'STOPPED', control: { mode: 'STOPPED' }
    }));
    expect(allowed.sort()).toEqual(['maintenance', 'start']);
  });

  it('offers only completion while under maintenance', () => {
    const { allowed, blocked } = control.availableActions(stationState({
      state: 'MAINTENANCE', control: { mode: 'MAINTENANCE' }
    }));
    expect(allowed).toEqual(['completeMaintenance']);
    expect(blocked.start).toMatch(/Complete the maintenance order first/);
  });

  it('will not restart a station held down by an open andon call', () => {
    const { allowed, blocked } = control.availableActions(stationState({
      state: 'DOWN', openAndonId: 'AND-000007'
    }));
    expect(allowed).toEqual(['maintenance']);
    expect(blocked.start).toMatch(/Resolve andon AND-000007 first/);
  });

  it('lets a fault with no andon behind it be reset', () => {
    const { allowed } = control.availableActions(stationState({ state: 'DOWN' }));
    expect(allowed).toContain('start');
  });

  it('agrees with the documented transition table in every mode', () => {
    // The table drives the state diagram in the docs; availableActions drives
    // the buttons. If they ever disagree, one of them is lying.
    const modes = { AUTO: 'RUNNING', STOPPED: 'STOPPED', MAINTENANCE: 'MAINTENANCE' };
    for (const [mode, state] of Object.entries(modes)) {
      const fromTable = control.CONTROL_TRANSITIONS.filter((t) => t.from === mode).map((t) => t.action).sort();
      const { allowed } = control.availableActions(stationState({ state, control: { mode } }));
      expect(allowed.sort()).toEqual(fromTable);
    }
  });

  it('explains a refused action in the error', () => {
    expect(() => control.assertAction(stationState(), 'start'))
      .toThrow(/Cannot start PAINT-40: Already in service/);
  });
});

describe('maintenance orders', () => {
  it('defaults the type, duration and a capability-specific checklist', () => {
    const order = control.createMaintenanceOrder({ id: 'MWO-1', stationId: 'PAINT-40' }, at(0));

    expect(order.type).toBe('PREVENTIVE');
    expect(order.planned).toBe(true);
    expect(order.plannedMinutes).toBe(20);
    expect(order.checklist.map((c) => c.task)).toContain('Clean and inspect the bell cup');
    expect(order.checklist.every((c) => c.done === false)).toBe(true);
  });

  it('gives a weld station weld tasks and a torque station torque tasks', () => {
    expect(control.checklistFor(getStation('BODY-20'))[0]).toMatch(/weld tips/);
    expect(control.checklistFor(getStation('CHAS-10'))[0]).toMatch(/nutrunner/);
  });

  it('rejects an unknown type, station or duration together', () => {
    expect.assertions(2);
    try {
      control.createMaintenanceOrder({ id: 'X', stationId: 'NOPE', type: 'WISHFUL', plannedMinutes: 9999 });
    } catch (error) {
      expect(error.code).toBe('VALIDATION_FAILED');
      expect(error.details.map((d) => d.field).sort()).toEqual(['plannedMinutes', 'stationId', 'type']);
    }
  });

  it('records actual time, overrun, and which checklist tasks were skipped', () => {
    const order = control.createMaintenanceOrder({
      id: 'MWO-1', stationId: 'CHAS-10', plannedMinutes: 20
    }, at(0));
    const tasks = order.checklist.map((c) => c.task);

    const done = control.completeMaintenanceOrder(order, {
      technician: 'maint-771', checklist: tasks.slice(0, 2)
    }, at(26));

    expect(done.status).toBe('COMPLETED');
    expect(done.actualMinutes).toBe(26);
    expect(done.overrunMinutes).toBe(6);
    expect(done.checklistComplete).toBe(false);
    expect(done.checklist.filter((c) => c.done)).toHaveLength(2);
  });

  it('treats a sign-off with no checklist as everything done', () => {
    const order = control.createMaintenanceOrder({ id: 'MWO-1', stationId: 'CHAS-10' }, at(0));
    expect(control.completeMaintenanceOrder(order, {}, at(10)).checklistComplete).toBe(true);
  });

  it('cannot be completed twice', () => {
    const order = control.completeMaintenanceOrder(
      control.createMaintenanceOrder({ id: 'MWO-1', stationId: 'CHAS-10' }, at(0)), {}, at(10)
    );
    expect(() => control.completeMaintenanceOrder(order, {}, at(11))).toThrow(/is COMPLETED/);
  });
});

describe('preventive-maintenance scheduling', () => {
  it('derives the interval from MTBF, so fragile stations are serviced more often', () => {
    const fragile = control.pmIntervalCycles(getStation('BODY-20'));   // MTBF 300 min
    const sturdy = control.pmIntervalCycles(getStation('EOL-60'));     // MTBF 1400 min
    expect(fragile).toBeLessThan(sturdy);
    expect(fragile).toBe(Math.round((300 * 60 / 58) * 1.5));
  });

  it('bands status at 80, 100 and 120 percent of the interval', () => {
    const interval = control.pmIntervalCycles(getStation('BODY-20'));
    const status = (cycles) => control.pmStatus({ stationId: 'BODY-20', cyclesSinceMaintenance: cycles }).status;

    expect(status(Math.floor(interval * 0.5))).toBe('OK');
    expect(status(Math.ceil(interval * 0.85))).toBe('DUE_SOON');
    expect(status(Math.ceil(interval * 1.05))).toBe('DUE');
    expect(status(Math.ceil(interval * 1.25))).toBe('OVERDUE');
  });

  it('makes an overdue station more likely to fail, capped at 3x', () => {
    const interval = control.pmIntervalCycles(getStation('BODY-20'));
    const wear = (cycles) => control.wearFactor({ stationId: 'BODY-20', cyclesSinceMaintenance: cycles });

    expect(wear(interval)).toBe(1);
    expect(wear(interval * 1.5)).toBeCloseTo(2, 1);
    expect(wear(interval * 5)).toBe(3);
  });
});

describe('operator control through the service', () => {
  it('stops a station, locks it, and books downtime under the chosen reason', () => {
    const ctx = makeContext();
    const view = ctx.operations.stopStation('PAINT-40', {
      operator: 'op-1', reasonCode: 'SCHEDULED_BREAK', reason: 'Lunch'
    }, at(0));

    expect(view.state).toBe('STOPPED');
    expect(view.locked).toBe(true);
    expect(view.allowedActions.sort()).toEqual(['maintenance', 'start']);

    const downtime = ctx.repository.get('downtimes', ctx.operations.getStationState('PAINT-40').openDowntimeId);
    expect(downtime.reasonCode).toBe('SCHEDULED_BREAK');
    expect(downtime.category).toBe('PLANNED');
  });

  it('refuses automated state changes while locked - lockout', () => {
    const ctx = makeContext();
    ctx.operations.stopStation('PAINT-40', { operator: 'op-1' }, at(0));

    expect(() => ctx.operations.setStationState('PAINT-40', 'RUNNING', { source: 'simulator' }, at(1)))
      .toThrow(/locked in STOPPED by op-1/);
    expect(ctx.operations.getStationState('PAINT-40').state).toBe('STOPPED');
  });

  it('refuses to move a vehicle into a locked station unless forced', () => {
    const ctx = makeContext();
    const { vins: [vin] } = releaseUnits(ctx, 1);
    ctx.production.moveUnit(vin, 'BODY-10', {}, at(0));
    ctx.operations.startMaintenance('BODY-20', { type: 'PREVENTIVE', technician: 't' }, at(0));

    expect(() => ctx.production.moveUnit(vin, 'BODY-20', {}, at(1)))
      .toThrow(/BODY-20 is under maintenance \(t\) and cannot accept/);
    expect(() => ctx.production.moveUnit(vin, 'BODY-20', { force: true }, at(1))).not.toThrow();
  });

  it('starts a stopped station and closes its downtime with the full duration', () => {
    const ctx = makeContext();
    ctx.operations.stopStation('PAINT-40', { operator: 'op-1' }, at(0));
    const downtimeId = ctx.operations.getStationState('PAINT-40').openDowntimeId;

    const view = ctx.operations.startStation('PAINT-40', { operator: 'op-1' }, at(12));

    expect(view.control.mode).toBe('AUTO');
    expect(view.state).toBe('IDLE');
    expect(ctx.repository.get('downtimes', downtimeId).durationSeconds).toBe(720);
  });

  it('comes back RUNNING, not IDLE, when it is holding a vehicle', () => {
    const ctx = makeContext();
    const { vins: [vin] } = releaseUnits(ctx, 1);
    ctx.production.moveUnit(vin, 'BODY-10', {}, at(0));
    ctx.operations.stopStation('BODY-10', {}, at(1));

    expect(ctx.operations.startStation('BODY-10', {}, at(2)).state).toBe('RUNNING');
  });

  it('books preventive maintenance as planned downtime and resets the PM counter', () => {
    const ctx = makeContext();
    const state = ctx.operations.getStationState('PAINT-40');
    ctx.repository.put('stationStates', { ...state, cyclesSinceMaintenance: 700 });

    const started = ctx.operations.startMaintenance('PAINT-40', {
      type: 'PREVENTIVE', technician: 'maint-771', plannedMinutes: 20
    }, at(0));
    const downtime = ctx.repository.get('downtimes', started.openDowntimeId);
    expect(downtime.reasonCode).toBe('PREVENTIVE_MAINT');
    expect(downtime.countsAgainstOee).toBe(false);
    expect(started.activeMaintenance.cyclesAtStart).toBe(700);

    const done = ctx.operations.completeMaintenance('PAINT-40', { technician: 'maint-771' }, at(22));
    expect(done.completedOrder.actualMinutes).toBe(22);
    expect(done.pm.cyclesSinceMaintenance).toBe(0);
    expect(ctx.repository.get('downtimes', downtime.id).durationSeconds).toBe(1320);
  });

  it('keeps a failure as ONE downtime record through corrective maintenance, and resolves its andon', () => {
    const ctx = makeContext();
    const andon = ctx.operations.raiseAndon({ stationId: 'CHAS-10', callType: 'MAINTENANCE' }, at(0));

    const started = ctx.operations.startMaintenance('CHAS-10', { technician: 'maint-883' }, at(3));
    expect(started.activeMaintenance.type).toBe('CORRECTIVE');       // defaulted: station was down
    expect(started.openDowntimeId).toBe(andon.downtimeId);           // same outage, not a second record

    ctx.operations.completeMaintenance('CHAS-10', { findings: 'Servo replaced' }, at(25));

    expect(ctx.repository.get('andons', andon.id).status).toBe('RESOLVED');
    const downtime = ctx.repository.get('downtimes', andon.downtimeId);
    expect(downtime.durationSeconds).toBe(1500);
    expect(downtime.rootCause).toBe('Servo replaced');
    expect(ctx.repository.count('downtimes', (d) => d.stationId === 'CHAS-10')).toBe(1);
  });

  it('closes an operator stop and books fresh PM downtime when maintenance starts from a stop', () => {
    const ctx = makeContext();
    ctx.operations.stopStation('PAINT-40', { operator: 'op-1' }, at(0));
    const stopDowntime = ctx.operations.getStationState('PAINT-40').openDowntimeId;

    const started = ctx.operations.startMaintenance('PAINT-40', { type: 'PREVENTIVE' }, at(5));

    expect(ctx.repository.get('downtimes', stopDowntime).durationSeconds).toBe(300);
    expect(started.openDowntimeId).not.toBe(stopDowntime);
  });

  it('raises an andon on a locked station without fighting the lock', () => {
    const ctx = makeContext();
    ctx.operations.startMaintenance('PAINT-40', { type: 'PREVENTIVE' }, at(0));

    const andon = ctx.operations.raiseAndon({ stationId: 'PAINT-40', callType: 'MAINTENANCE' }, at(1));

    expect(andon.status).toBe('RAISED');
    expect(ctx.operations.getStationState('PAINT-40').state).toBe('MAINTENANCE');
  });

  it('publishes control and maintenance events', () => {
    const ctx = makeContext();
    ctx.operations.stopStation('PAINT-40', {}, at(0));
    ctx.operations.startStation('PAINT-40', {}, at(1));
    ctx.operations.startMaintenance('PAINT-40', {}, at(2));
    ctx.operations.completeMaintenance('PAINT-40', {}, at(3));

    expect(ctx.eventTypes()).toEqual(expect.arrayContaining([
      'station.stopped', 'station.started', 'maintenance.started', 'maintenance.completed'
    ]));
  });

  it('ranks the PM board most overdue first', () => {
    const ctx = makeContext();
    const setCycles = (id, cycles) => ctx.repository.put('stationStates', {
      ...ctx.operations.getStationState(id), cyclesSinceMaintenance: cycles
    });
    setCycles('BODY-20', 10000);
    setCycles('EOL-60', 2000);

    const due = ctx.operations.maintenanceDue({ dueOnly: true });
    expect(due[0].stationId).toBe('BODY-20');
    expect(due[0].status).toBe('OVERDUE');
    expect(due.every((d) => d.status !== 'OK')).toBe(true);
  });
});

describe('the simulator respects operators', () => {
  const originalRelease = config.simulator.autoReleaseMinutes;
  afterEach(() => { config.simulator.autoReleaseMinutes = originalRelease; });

  const runTicks = (sim, n) => { for (let i = 0; i < n; i += 1) sim.tick(); };

  it('does not cycle, restart or repair a locked station', () => {
    config.simulator.autoReleaseMinutes = 0; // drive by hand
    const ctx = makeContext();
    const sim = new Simulator(ctx, { speed: 60, tickMs: 250, seed: 1 });
    ctx.simulator = sim;

    ctx.operations.stopStation('BODY-10', { operator: 'op-1' });
    sim.start();
    runTicks(sim, 400);
    sim.stop();

    const state = ctx.operations.getStationState('BODY-10');
    expect(state.state).toBe('STOPPED');
    expect(state.cycleCount).toBe(0);
    // Nothing could be launched past a stopped head station.
    expect(sim.counters.unitsLaunched).toBe(0);
  });

  it('releases an abandoned operator stop after the configured time', () => {
    config.simulator.autoReleaseMinutes = 15;
    const ctx = makeContext();
    const sim = new Simulator(ctx, { speed: 1, tickMs: 250, seed: 1 });
    ctx.simulator = sim;

    ctx.operations.stopStation('PAINT-40', { operator: 'visitor' }, new Date(Date.now() - 16 * 60000));
    sim.start();
    sim.tick();
    sim.stop();

    const view = ctx.operations.stationControl('PAINT-40');
    expect(view.control.mode).toBe('AUTO');
    expect(view.control.by).toMatch(/auto-release/);
  });

  it('leaves a recent stop alone', () => {
    config.simulator.autoReleaseMinutes = 15;
    const ctx = makeContext();
    const sim = new Simulator(ctx, { speed: 1, tickMs: 250, seed: 1 });
    ctx.simulator = sim;

    ctx.operations.stopStation('PAINT-40', { operator: 'visitor' });
    sim.start();
    sim.tick();
    sim.stop();

    expect(ctx.operations.stationControl('PAINT-40').control.mode).toBe('STOPPED');
  });

  it('signs maintenance off once its planned time has run', () => {
    config.simulator.autoReleaseMinutes = 15;
    const ctx = makeContext();
    const sim = new Simulator(ctx, { speed: 1, tickMs: 250, seed: 1 });
    ctx.simulator = sim;

    ctx.operations.startMaintenance('PAINT-40', {
      type: 'PREVENTIVE', technician: 'maint-771', plannedMinutes: 10
    }, new Date(Date.now() - 11 * 60000));
    sim.start();
    sim.tick();
    sim.stop();

    expect(ctx.operations.stationControl('PAINT-40').control.mode).toBe('AUTO');
    expect(ctx.repository.all('maintenanceOrders')[0].status).toBe('COMPLETED');
  });

  it('blocks the station upstream of a stopped one instead of rolling a vehicle in', () => {
    config.simulator.autoReleaseMinutes = 0;
    const ctx = makeContext();
    const { vins: [vin] } = releaseUnits(ctx, 1);
    walkRoute(ctx, vin, { through: 1, startAt: new Date() });
    ctx.operations.stopStation('BODY-20', {});

    const sim = new Simulator(ctx, { speed: 60, tickMs: 250, seed: 1, faults: false });
    ctx.simulator = sim;
    sim.start();
    runTicks(sim, 40);
    sim.stop();

    expect(ctx.repository.get('units', vin).currentStation).toBe('BODY-10');
    expect(ctx.operations.getStationState('BODY-10').state).toBe('BLOCKED');
  });
});
