'use strict';

/**
 * Test factories.
 *
 * Every suite builds its plant through these, so a change to a service
 * constructor breaks in one place rather than twenty.
 */

const { Repository } = require('../../src/store/repository');
const { EventBus } = require('../../src/services/eventBus');
const { ProductionService } = require('../../src/services/productionService');
const { QualityService } = require('../../src/services/qualityService');
const { OperationsService } = require('../../src/services/operationsService');
const { KpiService } = require('../../src/services/kpiService');
const { TraceService } = require('../../src/services/traceService');
const { MAIN_STATION_ROUTE } = require('../../src/core/plantModel');

/**
 * A bare plant: services wired together, no demo data.
 * @returns {object} application context plus captured events
 */
function makeContext() {
  const repository = new Repository({ driver: 'memory' });
  const eventBus = new EventBus();

  const events = [];
  eventBus.onAny((envelope) => {
    repository.append('events', envelope);
    events.push(envelope);
  });

  const production = new ProductionService(repository, eventBus);
  const operations = new OperationsService(repository, eventBus);
  const quality = new QualityService(repository, eventBus, production);
  const kpi = new KpiService(repository, production, operations);
  const trace = new TraceService(repository, eventBus);

  return {
    repository, eventBus, production, quality, operations, kpi, trace,
    events,
    eventTypes: () => events.map((e) => e.type),
    eventsOfType: (type) => events.filter((e) => e.type === type)
  };
}

/**
 * Create a work order and release `count` vehicles from it.
 * @returns {{workOrder: object, vins: string[]}}
 */
function releaseUnits(ctx, count = 1, overrides = {}) {
  const workOrder = ctx.production.createWorkOrder({
    modelCode: 'NS-AURORA-EV',
    quantity: Math.max(count, 1),
    ...overrides
  });
  const released = ctx.production.releaseWorkOrder(workOrder.id, { createUnits: count });
  return { workOrder: released.workOrder, vins: released.units.map((u) => u.vin) };
}

/** Build one of every sub-assembly class so final assembly does not starve. */
function fillBuffers(ctx, vin) {
  ['PWT', 'CKP', 'SET', 'CNF', 'CNR', 'WHS'].forEach((classCode) => {
    ctx.production.buildSubAssembly(classCode);
  });
  if (vin) ctx.production.buildSubAssembly('DRS', { forVin: vin });
}

/**
 * Walk a vehicle along the main route.
 *
 * @param {object} ctx
 * @param {string} vin
 * @param {object} [options] {through, startAt, stepSeconds}
 * @returns {Date} the clock after the last move
 */
function walkRoute(ctx, vin, options = {}) {
  const through = options.through ?? MAIN_STATION_ROUTE.length;
  let clock = options.startAt ? new Date(options.startAt) : new Date('2026-09-16T12:00:00Z');
  const step = (options.stepSeconds ?? 60) * 1000;

  for (const stationId of MAIN_STATION_ROUTE.slice(0, through)) {
    ctx.production.moveUnit(vin, stationId, {}, clock);
    clock = new Date(clock.getTime() + step);
  }
  return clock;
}

/** Build one vehicle end to end and release it. Returns the completed unit. */
function buildVehicle(ctx, options = {}) {
  const { vins } = releaseUnits(ctx, 1);
  const vin = vins[0];
  fillBuffers(ctx, vin);
  const clock = walkRoute(ctx, vin, options);
  return ctx.production.completeUnit(vin, {}, clock);
}

module.exports = {
  makeContext,
  releaseUnits,
  fillBuffers,
  walkRoute,
  buildVehicle,
  MAIN_STATION_ROUTE
};
