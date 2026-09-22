'use strict';

/**
 * Production orchestration.
 *
 * This is the transaction boundary of the system. The core modules are pure
 * functions over immutable documents; this service is what decides when to
 * call them, persists the results, keeps derived counters consistent, and
 * publishes the event. If a rule spans more than one entity - "completing a
 * unit also increments its work order and seals its genealogy" - it lives here,
 * not in the entity modules.
 */

const {
  MAIN_STATION_ROUTE, getStation, getLine, getModel, nextMainStation, MODELS, SERIAL_COMPONENTS
} = require('../core/plantModel');
const workOrderCore = require('../core/workOrder');
const unitCore = require('../core/unit');
const subCore = require('../core/subAssembly');
const genealogyCore = require('../core/genealogy');
const bomCore = require('../core/bom');
const ids = require('../core/ids');
const { EVENT_TYPES } = require('./eventBus');
const {
  NotFoundError, ValidationError, ConflictError, QualityHoldError, StateTransitionError
} = require('../core/errors');
const { isLocked, controlOf } = require('../core/stationControl');
const config = require('../config');
const { createLogger } = require('../logger');

const log = createLogger('production');

class ProductionService {
  /**
   * @param {import('../store/repository').Repository} repository
   * @param {import('./eventBus').EventBus} eventBus
   * @param {object} [options] {random} deterministic PRNG for lot selection
   */
  constructor(repository, eventBus, options = {}) {
    this.repo = repository;
    this.bus = eventBus;
    this.random = options.random || ids.createRandom(config.simulator.seed);
  }

  // ======================================================================
  // Work orders
  // ======================================================================

  /** Create a work order in DRAFT. */
  createWorkOrder(input, now = new Date()) {
    const id = input.id || ids.sequentialId(`WO-${now.getUTCFullYear()}`, this.repo.nextSequence('workOrder'), 4);
    if (this.repo.has('workOrders', id)) {
      throw new ConflictError(`Work order '${id}' already exists`, { id });
    }

    const workOrder = workOrderCore.createWorkOrder({ ...input, id }, now);
    this.repo.put('workOrders', workOrder);
    this.bus.publish(EVENT_TYPES.WORK_ORDER_CREATED, workOrder, { source: 'api' });
    log.info('work order created', { id, model: workOrder.modelCode, qty: workOrder.quantity });
    return workOrder;
  }

  getWorkOrder(id) {
    const workOrder = this.repo.get('workOrders', id);
    if (!workOrder) throw new NotFoundError('WorkOrder', id);
    return workOrder;
  }

  listWorkOrders(query = {}) {
    return this.repo.find('workOrders', {
      where: (wo) =>
        (!query.status || wo.status === query.status)
        && (!query.modelCode || wo.modelCode === query.modelCode)
        && (!query.priority || wo.priority === query.priority),
      sort: query.sort || 'createdAt',
      order: query.order || 'desc',
      limit: query.limit,
      offset: query.offset
    });
  }

  /**
   * Release a work order to the floor. This is the moment units come into
   * existence: every planned vehicle gets its VIN up front so feeder lines can
   * be sequenced against it.
   *
   * Releasing an order that is already RELEASED or IN_PROGRESS is legal and
   * simply mints more units from it - that is how a line pulls the next few
   * vehicles rather than materialising a whole 500-unit order at once. Only the
   * first call performs the DRAFT -> RELEASED transition.
   *
   * @param {string} id
   * @param {object} [options] {createUnits} defaults to the whole remaining quantity
   */
  releaseWorkOrder(id, options = {}, now = new Date()) {
    const workOrder = this.getWorkOrder(id);
    const alreadyOnFloor = ['RELEASED', 'IN_PROGRESS'].includes(workOrder.status);

    const released = alreadyOnFloor
      ? workOrder
      : workOrderCore.transition(workOrder, workOrderCore.WORK_ORDER_STATES.RELEASED, { at: now });
    this.repo.put('workOrders', released);

    // Never mint more vehicles than the order asked for.
    const existing = this.repo.count('units', (u) => u.workOrderId === id);
    const remaining = Math.max(0, released.quantity - existing);
    const count = Math.min(options.createUnits ?? remaining, remaining);

    if (count === 0 && options.createUnits) {
      throw new ConflictError(
        `Work order '${id}' has already created all ${released.quantity} of its units`,
        { id, quantity: released.quantity, existing }
      );
    }

    const created = [];
    for (let index = 0; index < count; index += 1) {
      created.push(this.#createUnitFor(released, existing + index + 1, now));
    }

    this.bus.publish(EVENT_TYPES.WORK_ORDER_RELEASED, {
      ...released, unitsCreated: created.length
    }, { source: 'api' });
    log.info('work order released', { id, units: created.length });

    return { workOrder: released, units: created.map(unitCore.summarise) };
  }

  /** Apply an arbitrary legal state transition to a work order. */
  transitionWorkOrder(id, nextState, context = {}, now = new Date()) {
    const workOrder = this.getWorkOrder(id);
    const next = workOrderCore.transition(workOrder, nextState, { ...context, at: now });
    this.repo.put('workOrders', next);
    this.bus.publish(
      nextState === 'COMPLETED' ? EVENT_TYPES.WORK_ORDER_COMPLETED : EVENT_TYPES.WORK_ORDER_UPDATED,
      next,
      { source: context.source || 'api' }
    );
    return next;
  }

  #createUnitFor(workOrder, buildNumber, now) {
    const model = getModel(workOrder.modelCode);
    const sequence = this.repo.nextSequence('vin', 1000);
    const vin = ids.buildVin({
      vds: model.vds,
      year: model.modelYear,
      plantCode: config.site.plantCode,
      sequence
    });

    const unit = unitCore.createUnit({
      vin,
      workOrderId: workOrder.id,
      modelCode: workOrder.modelCode,
      colour: workOrder.colour,
      buildNumber
    }, now);

    this.repo.put('units', unit);
    this.repo.put('genealogies', genealogyCore.createGenealogy(vin, {
      workOrderId: workOrder.id,
      modelCode: workOrder.modelCode,
      site: config.site.id
    }, now));

    this.bus.publish(EVENT_TYPES.UNIT_CREATED, unitCore.summarise(unit), { vin, source: 'api' });
    return unit;
  }

  // ======================================================================
  // Units
  // ======================================================================

  getUnit(vin) {
    const unit = this.repo.get('units', vin);
    if (!unit) throw new NotFoundError('Unit', vin);
    return unit;
  }

  listUnits(query = {}) {
    const result = this.repo.find('units', {
      where: (u) =>
        (!query.status || u.status === query.status)
        && (!query.lineId || u.currentLine === query.lineId)
        && (!query.stationId || u.currentStation === query.stationId)
        && (!query.workOrderId || u.workOrderId === query.workOrderId)
        && (!query.modelCode || u.modelCode === query.modelCode),
      sort: query.sort || 'updatedAt',
      order: query.order || 'desc',
      limit: query.limit ?? 50,
      offset: query.offset
    });
    return { ...result, items: result.items.map(unitCore.summarise) };
  }

  /** Units physically on the floor right now. */
  workInProgress() {
    return this.repo
      .all('units')
      .filter((u) => ['IN_PROCESS', 'HOLD', 'REWORK'].includes(u.status))
      .map(unitCore.summarise);
  }

  /**
   * Advance a unit to a station.
   *
   * Beyond the routing rules in core/unit.js, this method performs the three
   * side effects a station visit has in a real plant:
   *
   *   1. back-flush the parts consumed at that station into genealogy
   *   2. install any serialised sub-assembly the station is due to fit
   *   3. enforce the quality gate if the station has one
   */
  moveUnit(vin, stationId, options = {}, now = new Date()) {
    const unit = this.getUnit(vin);
    const station = getStation(stationId);
    if (!station) throw new NotFoundError('Station', stationId);

    // --- lockout on the station being ENTERED -----------------------------
    // A station an operator stopped, or that is under maintenance, does not
    // accept a vehicle - whichever interface is asking. `force` is the audited
    // supervisor override, as it is for routing.
    const target = this.repo.get('stationStates', stationId);
    if (target && isLocked(target) && !options.force) {
      const { mode, by } = controlOf(target);
      throw new StateTransitionError(
        'Station', stationId, mode, 'ENTER',
        `Station ${stationId} is ${mode === 'MAINTENANCE' ? 'under maintenance' : 'stopped'} ` +
        `(${by}) and cannot accept ${vin}`
      );
    }

    // --- quality gate on the station being LEFT --------------------------
    const leaving = unit.currentStation ? getStation(unit.currentStation) : null;
    if (leaving?.qualityGate && !options.force) {
      const openDefects = this.#openDefectsFor(vin);
      const blocking = openDefects.filter(
        (d) => d.severity === 'CRITICAL' || (d.severity === 'MAJOR' && !d.disposition)
      );
      if (blocking.length) {
        this.bus.publish(EVENT_TYPES.GATE_BLOCKED, {
          vin, stationId: leaving.id, defects: blocking.map((d) => d.id)
        }, { vin, stationId: leaving.id, lineId: leaving.lineId });
        throw new QualityHoldError(vin, leaving.id, blocking.map((d) => ({
          id: d.id, code: d.code, severity: d.severity
        })));
      }
    }

    const moved = unitCore.moveToStation(unit, stationId, { ...options, at: now });
    this.repo.put('units', moved);

    // --- back-flush material and install sub-assemblies -------------------
    this.#backflush(moved, station, now);
    const installed = this.#installSubAssemblies(moved, station, now);

    // --- first station on the route starts the work order -----------------
    if (!unit.startedAt) {
      const workOrder = this.repo.get('workOrders', moved.workOrderId);
      if (workOrder) {
        const bumped = { ...workOrder, quantityStarted: workOrder.quantityStarted + 1 };
        this.repo.put('workOrders', bumped.status === 'RELEASED'
          ? workOrderCore.transition(bumped, 'IN_PROGRESS', { at: now })
          : bumped);
      }
    }

    this.bus.publish(EVENT_TYPES.UNIT_MOVED, {
      vin,
      stationId,
      stationName: station.name,
      lineId: station.lineId,
      previousStation: unit.currentStation,
      progressPct: unitCore.routeProgress(moved),
      installedSerials: installed
    }, { vin, stationId, lineId: station.lineId, source: options.source || 'api' });

    return moved;
  }

  /** Advance a unit to whatever the plant model says comes next. */
  advanceUnit(vin, options = {}, now = new Date()) {
    const unit = this.getUnit(vin);
    const next = unit.currentStation
      ? nextMainStation(unit.currentStation)
      : MAIN_STATION_ROUTE[0];

    if (!next) {
      // End of the route: release the vehicle.
      return this.completeUnit(vin, options, now);
    }
    return this.moveUnit(vin, next, options, now);
  }

  /** Record consumed parts against the vehicle's genealogy. */
  #backflush(unit, station, now) {
    const parts = station.consumes;
    if (!parts.length) return;

    let genealogy = this.repo.get('genealogies', unit.vin);
    if (!genealogy || genealogy.sealedAt) return;

    for (const partNumber of parts) {
      const part = bomCore.getPart(partNumber);
      // Lot-controlled parts carry a supplier batch; others do not.
      const lotCode = part.lotControlled
        ? ids.buildLotCode(
            part.supplier,
            partNumber,
            now,
            String.fromCharCode(65 + this.random.int(0, 3))
          )
        : null;

      genealogy = genealogyCore.recordPart(genealogy, {
        partNumber,
        description: part.description,
        lotCode,
        supplier: part.supplier,
        quantity: bomCore.quantityPer(partNumber),
        safetyCritical: part.safetyCritical
      }, station.id, now);

      if (lotCode) this.repo.indexLot(lotCode, unit.vin);
    }

    this.repo.put('genealogies', genealogy);
  }

  /** Pull sub-assemblies from the buffer and marry them into the vehicle. */
  #installSubAssemblies(unit, station, now) {
    const classes = station.consumesSerial;
    if (!classes.length) return [];

    const installed = [];
    let genealogy = this.repo.get('genealogies', unit.vin);

    for (const classCode of classes) {
      const candidate = this.repo
        .all('subAssemblies')
        .find((s) => s.classCode === classCode && subCore.isAvailableFor(s, unit.vin));

      if (!candidate) {
        // Starved: the feeder line has not delivered. Real, and worth seeing.
        log.warn('no sub-assembly available', {
          vin: unit.vin, classCode, station: station.id
        });
        continue;
      }

      const consumed = subCore.consume(candidate, unit.vin, station.id, now);
      this.repo.put('subAssemblies', consumed);

      if (genealogy && !genealogy.sealedAt) {
        genealogy = genealogyCore.recordSubAssembly(genealogy, consumed, station.id, now);
        this.repo.indexSerial(consumed.serial, unit.vin);
        (consumed.components || []).forEach((c) => {
          if (c.lotCode) this.repo.indexLot(c.lotCode, unit.vin);
        });
      }

      installed.push(consumed.serial);
      this.bus.publish(EVENT_TYPES.SUB_CONSUMED, {
        serial: consumed.serial, classCode, vin: unit.vin, stationId: station.id
      }, { vin: unit.vin, stationId: station.id, lineId: station.lineId });
    }

    if (genealogy) this.repo.put('genealogies', genealogy);
    return installed;
  }

  /** Put a unit on hold. */
  holdUnit(vin, reason, options = {}, now = new Date()) {
    const held = unitCore.hold(this.getUnit(vin), reason, { ...options, at: now });
    this.repo.put('units', held);
    this.bus.publish(EVENT_TYPES.UNIT_HELD, {
      vin, reason, stationId: held.currentStation
    }, { vin, stationId: held.currentStation, lineId: held.currentLine });
    return held;
  }

  reworkUnit(vin, reason, options = {}, now = new Date()) {
    const reworked = unitCore.sendToRework(this.getUnit(vin), reason, { ...options, at: now });
    this.repo.put('units', reworked);
    this.bus.publish(EVENT_TYPES.UNIT_REWORK, {
      vin, reason, reworkCount: reworked.reworkCount, stationId: reworked.currentStation
    }, { vin, stationId: reworked.currentStation, lineId: reworked.currentLine });
    return reworked;
  }

  releaseUnit(vin, options = {}, now = new Date()) {
    const released = unitCore.release(this.getUnit(vin), { ...options, at: now });
    this.repo.put('units', released);
    this.bus.publish(EVENT_TYPES.UNIT_RELEASED, {
      vin, stationId: released.currentStation
    }, { vin, stationId: released.currentStation, lineId: released.currentLine });
    return released;
  }

  /** Release the vehicle to the yard: seals genealogy and closes the order. */
  completeUnit(vin, options = {}, now = new Date()) {
    const unit = this.getUnit(vin);
    const completed = unitCore.complete(unit, { ...options, at: now });
    this.repo.put('units', completed);

    const genealogy = this.repo.get('genealogies', vin);
    if (genealogy && !genealogy.sealedAt) {
      this.repo.put('genealogies', genealogyCore.seal(genealogy, now));
    }

    this.#bumpWorkOrder(completed.workOrderId, { completed: 1 }, now);

    this.bus.publish(EVENT_TYPES.UNIT_COMPLETED, {
      vin,
      workOrderId: completed.workOrderId,
      modelCode: completed.modelCode,
      buildMinutes: completed.buildMinutes,
      firstPass: unitCore.isFirstPass(completed),
      reworkCount: completed.reworkCount
    }, { vin, source: options.source || 'api' });

    log.info('vehicle released', { vin, buildMinutes: completed.buildMinutes });
    return completed;
  }

  scrapUnit(vin, reason, options = {}, now = new Date()) {
    const unit = this.getUnit(vin);
    const scrapped = unitCore.scrap(unit, reason, { ...options, at: now });
    this.repo.put('units', scrapped);
    this.#bumpWorkOrder(scrapped.workOrderId, { scrapped: 1 }, now);

    this.bus.publish(EVENT_TYPES.UNIT_SCRAPPED, {
      vin, reason, stationId: unit.currentStation, modelCode: unit.modelCode
    }, { vin, stationId: unit.currentStation, lineId: unit.currentLine });

    log.warn('unit scrapped', { vin, reason, at: unit.currentStation });
    return scrapped;
  }

  /** Keep work-order counters in step and auto-close when fulfilled. */
  #bumpWorkOrder(workOrderId, delta, now) {
    const workOrder = this.repo.get('workOrders', workOrderId);
    if (!workOrder) return;

    let next = {
      ...workOrder,
      quantityCompleted: workOrder.quantityCompleted + (delta.completed || 0),
      quantityScrapped: workOrder.quantityScrapped + (delta.scrapped || 0),
      updatedAt: now.toISOString()
    };

    if (workOrderCore.isFulfilled(next) && next.status === 'IN_PROGRESS') {
      next = workOrderCore.transition(next, 'COMPLETED', { at: now });
      this.bus.publish(EVENT_TYPES.WORK_ORDER_COMPLETED, next, { source: 'core' });
      log.info('work order fulfilled', { id: next.id, built: next.quantityCompleted });
    }
    this.repo.put('workOrders', next);
  }

  #openDefectsFor(vin) {
    return this.repo.all('defects').filter((d) => d.vin === vin && d.status !== 'CLOSED');
  }

  // ======================================================================
  // Sub-assemblies
  // ======================================================================

  /**
   * Build a sub-assembly end to end: open the record, back-flush its parts,
   * run its functional test, and put it in the buffer.
   *
   * @param {string} classCode e.g. 'PWT'
   * @param {object} [options] {forVin, passed, measurements}
   */
  buildSubAssembly(classCode, options = {}, now = new Date()) {
    const spec = SERIAL_COMPONENTS[classCode];
    if (!spec) throw new ValidationError(`Unknown component class '${classCode}'`, { classCode });

    const serial = ids.buildSerial(classCode, this.repo.nextSequence(`serial:${classCode}`), now);
    let sub = subCore.createSubAssembly({
      serial,
      classCode,
      builtAt: spec.builtAt,
      forVin: options.forVin || null,
      buildMode: options.buildMode
    }, now);

    // Back-flush the parts consumed by the cell that builds this class.
    const station = getStation(spec.builtAt);
    const line = getLine(spec.builtOnLine);
    const cellStations = (line?.stations || []).filter(
      (s) => !station?.cell || s.cell === station.cell
    );

    for (const cellStation of cellStations) {
      for (const partNumber of cellStation.consumes || []) {
        const part = bomCore.getPart(partNumber);
        sub = subCore.addComponent(sub, {
          partNumber,
          description: part.description,
          supplier: part.supplier,
          quantity: bomCore.quantityPer(partNumber),
          safetyCritical: part.safetyCritical,
          lotCode: part.lotControlled
            ? ids.buildLotCode(
                part.supplier, partNumber, now,
                String.fromCharCode(65 + this.random.int(0, 3))
              )
            : null
        }, now);
      }
    }

    if (station?.inspectionPlan || options.testId) {
      sub = subCore.addTestResult(sub, {
        testId: options.testId || station.inspectionPlan,
        stationId: spec.builtAt,
        passed: options.passed !== false,
        measurements: options.measurements || {}
      }, now);
    }

    sub = subCore.completeBuild(sub, now);
    this.repo.put('subAssemblies', sub);

    this.bus.publish(
      sub.status === 'QUARANTINED' ? EVENT_TYPES.SUB_QUARANTINED : EVENT_TYPES.SUB_BUILT,
      {
        serial: sub.serial,
        classCode,
        status: sub.status,
        forVin: sub.forVin,
        stationId: spec.builtAt,
        quarantineReason: sub.quarantineReason || null
      },
      { stationId: spec.builtAt, lineId: spec.builtOnLine }
    );

    return sub;
  }

  getSubAssembly(serial) {
    const sub = this.repo.get('subAssemblies', serial);
    if (!sub) throw new NotFoundError('SubAssembly', serial);
    return sub;
  }

  listSubAssemblies(query = {}) {
    return this.repo.find('subAssemblies', {
      where: (s) =>
        (!query.classCode || s.classCode === query.classCode)
        && (!query.status || s.status === query.status)
        && (!query.forVin || s.forVin === query.forVin)
        && (!query.consumedByVin || s.consumedByVin === query.consumedByVin),
      sort: query.sort || 'createdAt',
      order: query.order || 'desc',
      limit: query.limit ?? 50,
      offset: query.offset
    });
  }

  /** How many of each class are sitting in the buffer right now. */
  bufferLevels() {
    const levels = {};
    for (const sub of this.repo.all('subAssemblies')) {
      if (sub.status !== 'AVAILABLE' && sub.status !== 'ALLOCATED') continue;
      levels[sub.classCode] = (levels[sub.classCode] || 0) + 1;
    }
    return Object.entries(SERIAL_COMPONENTS).map(([code, spec]) => ({
      classCode: code,
      description: spec.description,
      builtAt: spec.builtAt,
      installsAt: spec.installedAt,
      available: levels[code] || 0,
      // Below two units of buffer, a feeder hiccup starves final assembly.
      starvationRisk: (levels[code] || 0) < 2
    }));
  }

  // ======================================================================
  // Genealogy
  // ======================================================================

  getGenealogy(vin) {
    const genealogy = this.repo.get('genealogies', vin);
    if (!genealogy) throw new NotFoundError('Genealogy', vin);
    return genealogy;
  }

  /** Genealogy with a flattened tree and summary stats, for the API. */
  genealogyReport(vin) {
    const genealogy = this.getGenealogy(vin);
    const unit = this.repo.get('units', vin);
    return {
      ...genealogy,
      unit: unit ? unitCore.summarise(unit) : null,
      flattened: genealogyCore.flatten(genealogy),
      stats: genealogyCore.stats(genealogy),
      estimatedMaterialCostCad: bomCore.genealogyCost(genealogy)
    };
  }

  /** Station-by-station history for one vehicle. */
  unitHistory(vin) {
    const unit = this.getUnit(vin);
    const defects = this.repo.all('defects').filter((d) => d.vin === vin);

    return {
      vin,
      status: unit.status,
      currentStation: unit.currentStation,
      progressPct: unitCore.routeProgress(unit),
      firstPass: unitCore.isFirstPass(unit),
      totalCycleSeconds: unit.totalCycleSeconds,
      buildMinutes: unit.buildMinutes ?? null,
      visits: unit.history,
      openVisit: unit.currentStation
        ? {
            stationId: unit.currentStation,
            stationName: getStation(unit.currentStation)?.name,
            enteredAt: unit.enteredStationAt
          }
        : null,
      defects: defects.map((d) => ({
        id: d.id, code: d.code, severity: d.severity, status: d.status, stationId: d.stationId
      })),
      route: MAIN_STATION_ROUTE.map((stationId) => {
        const visit = unit.history.find((v) => v.stationId === stationId);
        return {
          stationId,
          stationName: getStation(stationId)?.name,
          lineId: getStation(stationId)?.lineId,
          state: visit ? 'DONE' : (stationId === unit.currentStation ? 'CURRENT' : 'PENDING'),
          cycleSeconds: visit?.cycleSeconds ?? null,
          result: visit?.result ?? null
        };
      })
    };
  }

  // ======================================================================
  // Reference data
  // ======================================================================

  listModels() {
    return MODELS.map((model) => ({
      ...model,
      bom: { lineCount: bomCore.bomForModel(model.code).lineCount }
    }));
  }
}

module.exports = { ProductionService };
