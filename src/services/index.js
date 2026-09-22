'use strict';

/**
 * Composition root for the service layer.
 *
 * Wires the repository, event bus and services together and returns a single
 * context object. The HTTP layer, the Node-RED nodes and the simulator all
 * receive this same context, which is what keeps them consistent - there is
 * exactly one repository and one event bus in the process.
 */

const { Repository } = require('../store/repository');
const { EventBus } = require('./eventBus');
const { ProductionService } = require('./productionService');
const { QualityService } = require('./qualityService');
const { OperationsService } = require('./operationsService');
const { KpiService } = require('./kpiService');
const { TraceService } = require('./traceService');
const { seedPlant } = require('../store/seed');
const config = require('../config');
const { createLogger } = require('../logger');

const log = createLogger('context');

/**
 * Build the application context.
 *
 * @param {object} [options]
 * @param {'memory'|'file'} [options.store]  overrides config
 * @param {boolean} [options.seed]           seed demo data
 * @param {number}  [options.seedDays]
 * @param {boolean} [options.loadSnapshot]
 * @returns {object} {repository, eventBus, production, quality, operations, kpi, trace, ...}
 */
function createContext(options = {}) {
  const repository = new Repository({
    driver: options.store || config.store.driver,
    dataDir: options.dataDir
  });

  const eventBus = new EventBus();

  // Every published event lands in the append-only log. Registered first so
  // nothing that happens during seeding is missed.
  eventBus.onAny((envelope) => repository.append('events', envelope));

  const production = new ProductionService(repository, eventBus);
  const operations = new OperationsService(repository, eventBus);
  const quality = new QualityService(repository, eventBus, production);
  // The KPI layer needs the simulator's speed to flag compressed figures, but
  // must not depend on the simulator existing - it is attached later, and is
  // absent entirely in tests and in production deployments that disable it.
  const context = {};
  const kpi = new KpiService(repository, production, operations, {
    getSimulatorSpeed: () => context.simulator?.speed ?? 1
  });
  const trace = new TraceService(repository, eventBus);

  Object.assign(context, {
    repository, eventBus, production, quality, operations, kpi, trace, config
  });

  // Restore first; only seed when there is nothing to restore, so a local
  // developer's plant history survives a restart.
  const restored = options.loadSnapshot !== false && repository.loadSnapshot();

  const shouldSeed = options.seed ?? (config.seed.onBoot && !restored);
  if (shouldSeed) {
    if (restored) repository.reset();
    seedPlant(context, { days: options.seedDays ?? config.seed.days });
  }

  // Station states must exist even when nothing was seeded.
  operations.ensureStationStates();

  if (options.autoSnapshot !== false) repository.startAutoSnapshot();

  log.info('application context ready', {
    store: repository.driver,
    restored,
    seeded: shouldSeed,
    units: repository.count('units'),
    workOrders: repository.count('workOrders')
  });

  return context;
}

module.exports = { createContext };
