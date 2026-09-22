'use strict';

/**
 * Production simulator.
 *
 * Drives the plant forward: launches vehicles against open work orders, walks
 * them through the routing at each station's cycle time, keeps the feeder lines
 * supplying sub-assemblies, and injects the failures a real plant has -
 * breakdowns, material shortages, defects and andon calls.
 *
 * Time is scaled by `speed`: at the default 30x a 60-second takt completes
 * every two seconds, so a visitor sees vehicles moving within a few seconds of
 * opening the page. All the domain rules still apply - the simulator only calls
 * the same services the REST API does, which means a simulated quality hold
 * blocks a vehicle exactly as a real one would.
 */

const {
  MAIN_STATION_ROUTE, ALL_STATIONS, getStation, MODELS,
  SERIAL_COMPONENTS, STATION_STATES, nextMainStation
} = require('../core/plantModel');
const unitCore = require('../core/unit');
const controlCore = require('../core/stationControl');
const { NotFoundError } = require('../core/errors');
const qualityCore = require('../core/quality');
const andonCore = require('../core/andon');
const ids = require('../core/ids');
const { FaultModel } = require('./faultModel');
const config = require('../config');
const { createLogger } = require('../logger');

const log = createLogger('simulator');

/** Weighted defect mix, matching what a plant actually writes on repair tags. */
const DEFECT_WEIGHTS = Object.freeze([
  ['DIRT_INCLUSION', 22], ['ORANGE_PEEL', 13], ['SCRATCH', 11], ['TRIM_GAP', 8],
  ['GAP_FLUSH_OOS', 8], ['RUN_SAG', 6], ['CLIP_BROKEN', 6], ['HARNESS_UNSEATED', 5],
  ['BALANCE_OOS', 4], ['ALIGNMENT_OOS', 4], ['THIN_FILM', 3], ['DOOR_EFFORT_HIGH', 3],
  ['TPMS_NO_SIGNAL', 2], ['RATTLE_BSR', 2], ['LAMP_INOP', 2], ['TORQUE_LOW', 1]
]);

const OPERATORS = ['op-1140', 'op-2271', 'op-3312', 'op-4408', 'op-5521', 'op-6634'];
const TECHNICIANS = ['maint-771', 'maint-772', 'maint-883'];
const INSPECTORS = ['qa-201', 'qa-202', 'qa-203'];

class Simulator {
  /**
   * @param {object} ctx application context
   * @param {object} [options] {speed, seed, faults}
   */
  constructor(ctx, options = {}) {
    this.ctx = ctx;
    this.production = ctx.production;
    this.quality = ctx.quality;
    this.operations = ctx.operations;
    this.repo = ctx.repository;

    this.speed = options.speed ?? config.simulator.speed;
    this.tickMs = options.tickMs ?? config.simulator.tickMs;
    this.random = ids.createRandom(options.seed ?? config.simulator.seed);
    this.faults = new FaultModel(this.random, {
      enabled: options.faults ?? config.simulator.faults
    });

    this.running = false;
    this.timer = null;
    this.startedAt = null;
    /** Wall-clock time of the last tick, for catching up after a freeze. */
    this.lastTickAt = null;

    /** Simulated seconds accumulated since start. */
    this.simSeconds = 0;
    /** @type {Map<string, {vin:string, remainingSeconds:number}>} */
    this.occupancy = new Map();
    /** Feeder build timers, keyed by component class. */
    this.feederTimers = new Map();

    this.counters = {
      ticks: 0, unitsLaunched: 0, unitsCompleted: 0, unitsScrapped: 0,
      stationCycles: 0, defectsRaised: 0, andonsRaised: 0, faultsInjected: 0,
      subAssembliesBuilt: 0, blockedMoves: 0, catchUpTicks: 0
    };
  }

  /** Begin stepping the plant forward. */
  start() {
    if (this.running) return this.status();
    this.running = true;
    this.startedAt = new Date().toISOString();
    this.lastTickAt = Date.now();
    this.#seedOccupancyFromWip();

    this.timer = setInterval(() => this.#safeTick(), this.tickMs);
    this.timer.unref?.();

    log.info('simulator started', { speed: this.speed, tickMs: this.tickMs });
    return this.status();
  }

  /**
   * Replay the ticks a frozen process missed.
   *
   * A serverless instance is suspended between requests, and its timer with
   * it. Called at the start of a request, this runs the missed ticks - up to
   * `maxSeconds` of them - so the plant has moved on by the time the response
   * is built. A longer gap is skipped rather than replayed: compressing ten
   * idle minutes into one request would be slow, and would stamp ten minutes
   * of output onto a single instant.
   *
   * @param {number} maxSeconds wall-clock seconds to replay at most
   * @returns {number} ticks run
   */
  catchUp(maxSeconds) {
    if (!this.running || !maxSeconds || this.lastTickAt === null) return 0;
    const behindMs = Date.now() - this.lastTickAt;
    if (behindMs < this.tickMs * 2) return 0;

    const ticks = Math.floor(Math.min(behindMs, maxSeconds * 1000) / this.tickMs);
    for (let index = 0; index < ticks; index += 1) this.#safeTick();
    this.lastTickAt = Date.now();
    this.counters.catchUpTicks += ticks;
    return ticks;
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.running = false;
    log.info('simulator stopped', { ...this.counters });
    return this.status();
  }

  /** @param {number} speed 1 = wall clock, 30 = 30x faster */
  setSpeed(speed) {
    this.speed = speed;
    log.info('simulator speed changed', { speed });
    return this.status();
  }

  /**
   * Advance the plant by one tick.
   *
   * Each tick represents `tickMs * speed / 1000` simulated seconds. Stations
   * count down their remaining cycle; when one reaches zero the vehicle moves
   * on, which frees the station for the next one.
   */
  tick() {
    const elapsed = (this.tickMs / 1000) * this.speed;
    this.simSeconds += elapsed;
    this.counters.ticks += 1;
    this.lastTickAt = Date.now();

    this.#stepStations(elapsed);
    this.#stepRepairBay();
    this.#stepOperators();
    this.#stepFeeders(elapsed);
    this.#launchNewUnits();
    this.#stepFaults(elapsed);
    this.#emitTelemetry();
    this.operations.sweepEscalations();
  }

  /** Move vehicles whose station cycle has elapsed. */
  /** A simulator bug must never take down the API or the flows. */
  #safeTick() {
    try {
      this.tick();
    } catch (error) {
      log.error('tick failed', { error: error.message, stack: error.stack?.split('\n')[1] });
    }
  }

  #stepStations(elapsed) {
    for (const [stationId, slot] of [...this.occupancy.entries()]) {
      const state = this.repo.get('stationStates', stationId);

      // A stopped station does not consume cycle time, and a locked one holds
      // its vehicle where it is until a person releases it.
      if (!this.#canWork(state)) continue;

      slot.remainingSeconds -= elapsed;
      if (slot.remainingSeconds > 0) continue;

      const unit = this.repo.get('units', slot.vin);
      if (!unit || unitCore.isTerminal(unit.status)) {
        this.occupancy.delete(stationId);
        continue;
      }

      // A held vehicle keeps its station until its defects are dispositioned -
      // which is exactly what an andon line does. The repair sweep below works
      // on it in parallel; this loop only has to avoid spinning on it.
      if (unit.status === 'HOLD') {
        slot.remainingSeconds = getStation(stationId).cycleSeconds;
        continue;
      }

      this.#completeStation(stationId, unit);
    }
  }

  /** Finish a vehicle's work at a station and push it downstream. */
  #completeStation(stationId, unit) {
    const station = getStation(stationId);
    const cycleSeconds = Math.max(
      5, Math.round(this.random.normal(station.cycleSeconds * 1.03, station.cycleSeconds * 0.08))
    );

    // Defect injection at this station's rate.
    let raisedDefect = null;
    if (this.faults.enabled && this.random.chance((station.scrapPpm / 1e6) * 7)) {
      raisedDefect = this.#raiseDefect(unit.vin, stationId);
    }

    this.operations.recordCycle(stationId, {
      vin: unit.vin, cycleSeconds, good: !raisedDefect
    });
    this.counters.stationCycles += 1;

    const next = nextMainStation(stationId);

    // End of the route: release the vehicle.
    if (!next) {
      try {
        this.production.completeUnit(unit.vin, { source: 'simulator', operator: this.random.pick(INSPECTORS) });
        this.counters.unitsCompleted += 1;
        this.occupancy.delete(stationId);
        this.#setState(stationId, STATION_STATES.IDLE);
      } catch (_error) {
        // Open defects block release. Hold the vehicle but keep it at the
        // station: dropping it from occupancy here was a real bug - the repair
        // sweep never saw it again, so held vehicles accumulated at EOL-60 and
        // backed the whole quality line up into a cascade of blocks.
        this.production.holdUnit(
          unit.vin,
          'Held at end of line with open defects',
          { operator: this.random.pick(INSPECTORS) }
        );
        this.occupancy.get(stationId).remainingSeconds = station.cycleSeconds;
      }
      return;
    }

    // Downstream is busy, stopped, down or under maintenance: this station is
    // blocked, not idle. Checking only occupancy used to let a vehicle roll
    // into a DOWN station and mark it RUNNING, silently "repairing" it.
    if (this.occupancy.has(next) || !this.#canAccept(next)) {
      this.#setState(stationId, STATION_STATES.BLOCKED);
      // Retry on the next tick rather than spinning.
      this.occupancy.get(stationId).remainingSeconds = 1;
      return;
    }

    try {
      this.production.moveUnit(unit.vin, next, {
        source: 'simulator', operator: this.random.pick(OPERATORS),
        result: raisedDefect ? unitCore.VISIT_RESULTS.REWORKED : unitCore.VISIT_RESULTS.PASS
      });
      this.occupancy.delete(stationId);
      this.occupancy.set(next, { vin: unit.vin, remainingSeconds: getStation(next).cycleSeconds });
      this.#setState(stationId, STATION_STATES.IDLE);
      this.#setState(next, STATION_STATES.RUNNING, unit.vin);
    } catch (error) {
      // Almost always a quality gate. Hold the vehicle and free the station so
      // the line behind it keeps moving - which is what a repair bay is for.
      this.counters.blockedMoves += 1;
      if (error.code === 'QUALITY_HOLD') {
        this.production.holdUnit(unit.vin, error.message, { operator: this.random.pick(INSPECTORS) });
        this.#raiseAndon(stationId, 'QUALITY', unit.vin);
      }
      this.occupancy.get(stationId).remainingSeconds = station.cycleSeconds;
    }
  }

  /**
   * Work the repair bay.
   *
   * Every held vehicle in the plant is a candidate, whether or not it is still
   * occupying a station. Anything that clears its defects rejoins the line, and
   * a vehicle held at the end-of-line release station is completed on the spot.
   */
  #stepRepairBay() {
    for (const unit of this.repo.all('units')) {
      if (unit.status !== 'HOLD') continue;

      this.#tryResolveHold(unit);
      const after = this.repo.get('units', unit.vin);
      if (after.status !== 'IN_PROCESS') continue;

      const station = getStation(after.currentStation);

      // Repaired at the release station: let it out of the plant.
      if (station?.terminal) {
        try {
          this.production.completeUnit(after.vin, {
            source: 'simulator', operator: this.random.pick(INSPECTORS)
          });
          this.counters.unitsCompleted += 1;
          this.occupancy.delete(after.currentStation);
          this.#setState(station.id, STATION_STATES.IDLE);
        } catch (_error) { /* a new defect appeared; it stays held */ }
        continue;
      }

      // Otherwise put it back in the cycle at its current station.
      if (after.currentStation && !this.occupancy.has(after.currentStation)) {
        this.occupancy.set(after.currentStation, {
          vin: after.vin,
          remainingSeconds: station?.cycleSeconds ?? 60
        });
        this.#setState(after.currentStation, STATION_STATES.RUNNING, after.vin);
      }
    }
  }

  /** A held vehicle gets its defects dispositioned and rejoins the line. */
  #tryResolveHold(unit) {
    if (!this.random.chance(0.15)) return; // repairs take time

    for (const defectId of unit.openDefectIds.slice()) {
      const defect = this.repo.get('defects', defectId);
      if (!defect || defect.status === 'CLOSED') continue;
      try {
        const decision = defect.severity === 'CRITICAL'
          ? this.random.weighted([['REWORK', 6], ['REPAIR', 3], ['SCRAP', 1]])
          : this.random.weighted([['REWORK', 7], ['REPAIR', 2], ['USE_AS_IS', 1]]);
        this.quality.dispositionDefect(defectId, decision, {
          operator: this.random.pick(TECHNICIANS), repairMinutes: this.random.int(4, 45)
        });
        const after = this.repo.get('defects', defectId);
        if (after.status !== 'CLOSED') {
          this.quality.closeDefect(defectId, { operator: this.random.pick(INSPECTORS) });
        }
      } catch (_error) { /* already dispositioned by another path */ }
    }

    const refreshed = this.repo.get('units', unit.vin);
    if (refreshed.status === 'HOLD' && !refreshed.openDefectIds.length) {
      this.production.releaseUnit(unit.vin);
    }
  }

  /** Keep the feeder buffers topped up. */
  #stepFeeders(elapsed) {
    for (const [classCode, spec] of Object.entries(SERIAL_COMPONENTS)) {
      if (classCode === 'DRS') continue; // broadcast-built when a VIN is launched

      const timer = (this.feederTimers.get(classCode) ?? 0) - elapsed;
      if (timer > 0) {
        this.feederTimers.set(classCode, timer);
        continue;
      }

      const available = this.repo.count('subAssemblies', (s) =>
        s.classCode === classCode && (s.status === 'AVAILABLE' || s.status === 'ALLOCATED'));

      // Pull, not push: only build when the buffer needs it.
      if (available < 6) {
        try {
          this.production.buildSubAssembly(classCode, {
            passed: !this.faults.enabled || !this.random.chance(0.015)
          });
          this.counters.subAssembliesBuilt += 1;
        } catch (error) {
          log.debug('feeder build failed', { classCode, error: error.message });
        }
      }

      const station = getStation(spec.builtAt);
      this.feederTimers.set(classCode, station?.cycleSeconds ?? 60);
    }
  }

  /** Launch a new vehicle at the head of the line when it is free. */
  #launchNewUnits() {
    const head = MAIN_STATION_ROUTE[0];
    if (this.occupancy.has(head)) return;

    if (!this.#canAccept(head)) return;

    // Prefer an existing planned unit; otherwise mint one against an open order.
    let unit = this.repo
      .all('units')
      .find((u) => u.status === 'PLANNED');

    if (!unit) {
      const order = this.#openWorkOrder();
      if (!order) return;
      const released = this.production.releaseWorkOrder(order.id, { createUnits: 1 });
      unit = released.units.length ? this.repo.get('units', released.units[0].vin) : null;
      if (!unit) return;
    }

    try {
      this.production.moveUnit(unit.vin, head, {
        source: 'simulator', operator: this.random.pick(OPERATORS)
      });
      this.occupancy.set(head, { vin: unit.vin, remainingSeconds: getStation(head).cycleSeconds });
      this.#setState(head, STATION_STATES.RUNNING, unit.vin);
      this.counters.unitsLaunched += 1;

      // Doors are removed from this body after paint, so the door set is
      // broadcast-built against this VIN the moment it is launched.
      this.production.buildSubAssembly('DRS', { forVin: unit.vin });
      this.counters.subAssembliesBuilt += 1;
    } catch (error) {
      log.debug('launch failed', { vin: unit.vin, error: error.message });
    }
  }

  /** An open order with capacity, creating one if the plant has run dry. */
  #openWorkOrder() {
    // Capacity is judged the way releaseWorkOrder judges it - by vehicles that
    // exist - not by quantityStarted. If the two ever drift, trusting the
    // counter picks an order the release then refuses, on every tick, and the
    // line stops launching vehicles.
    const open = this.repo.all('workOrders').find((w) =>
      ['RELEASED', 'IN_PROGRESS'].includes(w.status)
      && this.repo.count('units', (u) => u.workOrderId === w.id) < w.quantity);
    if (open) return open;

    // Keep the demo running indefinitely rather than stalling when the seeded
    // orders are exhausted.
    const model = this.random.weighted(MODELS.map((m) => [m, m.taktShareBps]));
    const created = this.production.createWorkOrder({
      modelCode: model.code,
      quantity: this.random.int(40, 90),
      colour: this.random.pick(model.colours),
      priority: this.random.weighted([['NORMAL', 7], ['HIGH', 2], ['EXPEDITE', 1]]),
      customerRef: `ORD-${this.random.int(100000, 999999)}`,
      dueDate: new Date(Date.now() + 86400000 * 2).toISOString()
    });
    log.info('simulator opened a new work order', { id: created.id, model: model.code });
    return created;
  }

  /** Break and repair stations according to their MTBF and MTTR. */
  #stepFaults(elapsed) {
    if (!this.faults.enabled) return;

    for (const station of ALL_STATIONS) {
      const state = this.repo.get('stationStates', station.id);
      if (!state) continue;

      // Locked stations belong to people, not to the fault model.
      if (controlCore.isLocked(state)) continue;

      // A preventive-maintenance window ends the same way a breakdown does.
      if (state.state === STATION_STATES.DOWN || state.state === STATION_STATES.MAINTENANCE) {
        if (this.faults.shouldRepair(station, elapsed)) {
          const open = this.repo
            .all('andons')
            .find((a) => a.stationId === station.id && andonCore.isOpen(a));
          if (open) {
            this.operations.resolveAndon(
              open.id, this.faults.correctiveAction(open.callType), this.random.pick(TECHNICIANS)
            );
          } else {
            this.#setState(station.id, STATION_STATES.RUNNING);
          }
        }
        continue;
      }

      if (state.state !== STATION_STATES.RUNNING) continue;

      // Overdue preventive maintenance raises the failure hazard, so skipping
      // PM shows up as more breakdowns rather than being free.
      if (this.faults.shouldFail(station, elapsed * controlCore.wearFactor(state))) {
        this.#raiseAndon(station.id, this.faults.callTypeFor(station), state.currentVin);
        this.counters.faultsInjected += 1;
      }
    }
  }

  /** A station can run its cycle: in AUTO and not stopped for any reason. */
  #canWork(state) {
    if (!state) return true;
    if (controlCore.isLocked(state)) return false;
    return !['DOWN', 'MAINTENANCE', 'CHANGEOVER', 'STOPPED'].includes(state.state);
  }

  /** A station can take a new vehicle. */
  #canAccept(stationId) {
    return this.#canWork(this.repo.get('stationStates', stationId));
  }

  /**
   * The plant's people.
   *
   * On a public demo anyone can press Stop and walk away, which would starve
   * the line for every later visitor. So, like a supervisor walking the floor,
   * this restarts an operator stop once it has run for the configured time,
   * and has technicians sign maintenance off when its planned time is up.
   * Set PC_SIM_AUTO_RELEASE_MINUTES=0 to drive the plant entirely by hand.
   */
  #stepOperators() {
    const limitMinutes = config.simulator.autoReleaseMinutes;
    if (!limitMinutes) return;

    for (const state of this.repo.all('stationStates')) {
      const control = controlCore.controlOf(state);
      if (control.mode === controlCore.CONTROL_MODES.AUTO) continue;

      // Wall-clock age scaled by speed, so auto-release follows plant time.
      const ageMinutes = ((Date.now() - Date.parse(control.since)) / 60000) * this.speed;

      try {
        if (control.mode === controlCore.CONTROL_MODES.STOPPED && ageMinutes >= limitMinutes) {
          this.operations.startStation(state.stationId, {
            operator: 'supervisor (auto-release)',
            note: `Released automatically after ${limitMinutes} min`,
            source: 'simulator'
          });
        } else if (control.mode === controlCore.CONTROL_MODES.MAINTENANCE) {
          const order = this.repo.get('maintenanceOrders', control.maintenanceOrderId);
          if (order && ageMinutes >= order.plannedMinutes) {
            this.operations.completeMaintenance(state.stationId, {
              technician: order.technician,
              findings: 'Completed to plan by the simulated maintenance crew',
              source: 'simulator'
            });
          }
        }
      } catch (error) {
        log.debug('operator sweep skipped a station', { stationId: state.stationId, error: error.message });
      }
    }
  }

  #raiseAndon(stationId, callType, vin) {
    try {
      const andon = this.operations.raiseAndon({
        stationId, callType, raisedBy: this.random.pick(OPERATORS), vin: vin || null,
        note: this.faults.symptomFor(callType)
      });
      this.counters.andonsRaised += 1;

      // Someone responds after a realistic delay, mostly inside SLA.
      const responseMs = (this.random.chance(0.8)
        ? this.random.int(15, andon.slaSeconds)
        : this.random.int(andon.slaSeconds, andon.slaSeconds * 3)) * 1000 / this.speed;

      const ack = setTimeout(() => {
        try { this.operations.acknowledgeAndon(andon.id, this.random.pick(TECHNICIANS)); }
        catch (_e) { /* already acknowledged or resolved */ }
      }, Math.max(50, responseMs));
      ack.unref?.();

      return andon;
    } catch (error) {
      log.debug('andon raise failed', { stationId, error: error.message });
      return null;
    }
  }

  #raiseDefect(vin, stationId) {
    const local = qualityCore.DEFECT_CODES.filter((d) => d.typicalStations?.includes(stationId));
    const code = local.length && this.random.chance(0.75)
      ? this.random.pick(local).code
      : this.random.weighted(DEFECT_WEIGHTS.slice());

    try {
      const defect = this.quality.raiseDefect({
        code, vin, stationId, detectedBy: this.random.pick(INSPECTORS)
      });
      this.counters.defectsRaised += 1;
      return defect;
    } catch (error) {
      log.debug('defect raise failed', { vin, stationId, error: error.message });
      return null;
    }
  }

  #setState(stationId, state, vin) {
    try {
      this.operations.setStationState(stationId, state, { vin, source: 'simulator' });
    } catch (_error) { /* concurrent state change - the later one wins */ }
  }

  /**
   * Publish sensor telemetry for a sample of stations each tick.
   *
   * Sampling rather than emitting all 43 keeps the event ring buffer useful:
   * telemetry would otherwise crowd out the production events an operator
   * actually wants to see in the feed.
   */
  #emitTelemetry() {
    const sample = Math.max(1, Math.round(ALL_STATIONS.length * 0.12));
    for (let index = 0; index < sample; index += 1) {
      const station = this.random.pick(ALL_STATIONS);
      const state = this.repo.get('stationStates', station.id);
      this.operations.recordTelemetry({
        stationId: station.id,
        metrics: this.faults.telemetryFor(station, state?.state || 'IDLE')
      });
    }
  }

  /**
   * Rebuild station occupancy from whatever is already on the floor, then
   * reconcile every station's reported state with that reality.
   *
   * Seeded demo data assigns plausible-looking states at random, which will not
   * agree with where the vehicles actually are. Without this reconciliation the
   * head of the line can start up already marked BLOCKED and the simulator
   * never launches anything - the plant looks alive but produces nothing.
   */
  #seedOccupancyFromWip() {
    this.occupancy.clear();
    for (const unit of this.repo.all('units')) {
      if (!['IN_PROCESS', 'HOLD', 'REWORK'].includes(unit.status)) continue;
      if (!unit.currentStation) continue;
      if (this.occupancy.has(unit.currentStation)) continue;
      this.occupancy.set(unit.currentStation, {
        vin: unit.vin,
        remainingSeconds: getStation(unit.currentStation)?.cycleSeconds ?? 60
      });
    }

    let reconciled = 0;
    for (const station of ALL_STATIONS) {
      const state = this.repo.get('stationStates', station.id);
      if (!state) continue;

      // Stations a person has locked are left exactly as they are.
      if (controlCore.isLocked(state)) continue;

      // Leave genuinely stopped stations stopped, but give them a repair
      // deadline so they do not stay down for the life of the process.
      if (state.state === STATION_STATES.DOWN || state.state === STATION_STATES.MAINTENANCE) {
        this.faults.scheduleRepair(station.id, this.random.int(60, (station.mttrMinutes || 10) * 60));
        continue;
      }

      const occupied = this.occupancy.has(station.id);
      const target = occupied ? STATION_STATES.RUNNING : STATION_STATES.IDLE;
      if (state.state !== target) {
        this.#setState(station.id, target, this.occupancy.get(station.id)?.vin);
        reconciled += 1;
      }
    }

    log.debug('occupancy seeded', { stations: this.occupancy.size, reconciled });
  }

  // ---- manual injection (exposed through the API) ------------------------

  /**
   * Break a station on demand.
   * @param {string} stationId
   * @param {string} [reasonCode]
   * @param {number} [durationSeconds]
   */
  injectFault(stationId, reasonCode = 'EQUIP_FAILURE', durationSeconds = 300) {
    const station = getStation(stationId);
    if (!station) {
      throw new NotFoundError('Station', stationId);
    }

    this.operations.setStationState(stationId, STATION_STATES.DOWN, {
      reasonCode, reason: 'Fault injected via API', operator: 'api', source: 'api'
    });
    this.faults.scheduleRepair(stationId, durationSeconds);
    this.counters.faultsInjected += 1;

    log.info('fault injected', { stationId, reasonCode, durationSeconds });
    return {
      stationId, reasonCode, durationSeconds,
      state: this.repo.get('stationStates', stationId)
    };
  }

  /** Raise a defect on demand, for demonstrating the quality gate. */
  injectDefect(vin, code = 'TORQUE_LOW', stationId) {
    const unit = this.production.getUnit(vin);
    const target = stationId || unit.currentStation || 'CHAS-10';
    const defect = this.quality.raiseDefect({
      code, vin, stationId: target, detectedBy: 'api'
    });
    this.counters.defectsRaised += 1;
    return defect;
  }

  /** Runtime state, surfaced through GET /api/v1/simulator and /health. */
  status() {
    return {
      enabled: true,
      running: this.running,
      speed: this.speed,
      tickMs: this.tickMs,
      faultsEnabled: this.faults.enabled,
      startedAt: this.startedAt,
      simulatedSeconds: Math.round(this.simSeconds),
      simulatedHours: Number((this.simSeconds / 3600).toFixed(2)),
      occupiedStations: this.occupancy.size,
      counters: { ...this.counters },
      occupancy: [...this.occupancy.entries()].map(([stationId, slot]) => ({
        stationId,
        vin: slot.vin,
        remainingSeconds: Number(slot.remainingSeconds.toFixed(1))
      }))
    };
  }
}

module.exports = { Simulator };
