'use strict';

/**
 * Floor operations: station state, andon calls and downtime.
 *
 * The coupling worth noting is andon -> downtime. When an operator pulls a
 * line-stopping cord, a downtime record opens automatically and closes when
 * the call is resolved. Plants that make those two things separate manual
 * steps end up with andon logs and downtime logs that disagree, and then
 * nobody trusts either.
 */

const andonCore = require('../core/andon');
const downtimeCore = require('../core/downtime');
const { getStation, ALL_STATIONS, STATION_STATES, STOP_STATES } = require('../core/plantModel');
const controlCore = require('../core/stationControl');
const unitCore = require('../core/unit');
const ids = require('../core/ids');
const { EVENT_TYPES } = require('./eventBus');
const { NotFoundError, ValidationError, StateTransitionError } = require('../core/errors');
const config = require('../config');
const { createLogger } = require('../logger');

const log = createLogger('operations');

/** Which downtime reason an andon call type implies. */
const ANDON_TO_REASON = Object.freeze({
  MAINTENANCE: 'EQUIP_FAILURE',
  QUALITY: 'QUALITY_HOLD',
  MATERIAL: 'MATERIAL_SHORTAGE',
  SAFETY: 'ANDON_STOP',
  PROCESS: 'ANDON_STOP',
  TOOLING: 'TOOL_BREAKAGE'
});

class OperationsService {
  constructor(repository, eventBus) {
    this.repo = repository;
    this.bus = eventBus;
    /** Micro-stops are counted but not stored as downtime records. */
    this.microStops = { total: 0, seconds: 0, byStation: {} };
    this.ensureStationStates();
  }

  // ---- station state -----------------------------------------------------

  /** Seed a state record for every station in the plant model. */
  ensureStationStates(now = new Date()) {
    for (const station of ALL_STATIONS) {
      if (this.repo.has('stationStates', station.id)) continue;
      this.repo.put('stationStates', {
        stationId: station.id,
        stationName: station.name,
        lineId: station.lineId,
        state: STATION_STATES.IDLE,
        previousState: null,
        since: now.toISOString(),
        currentVin: null,
        cycleCount: 0,
        goodCount: 0,
        scrapCount: 0,
        lastCycleSeconds: null,
        idealCycleSeconds: station.cycleSeconds,
        openDowntimeId: null,
        openAndonId: null,
        control: controlCore.controlBlock(controlCore.CONTROL_MODES.AUTO, {}, now),
        cyclesSinceMaintenance: 0,
        lastMaintenanceAt: null,
        updatedAt: now.toISOString()
      });
    }
  }

  getStationState(stationId) {
    const state = this.repo.get('stationStates', stationId);
    if (!state) throw new NotFoundError('Station', stationId);
    return state;
  }

  listStationStates(lineId) {
    return this.repo
      .all('stationStates')
      .filter((s) => !lineId || s.lineId === lineId)
      .sort((a, b) => (getStation(a.stationId)?.sequence ?? 0) - (getStation(b.stationId)?.sequence ?? 0));
  }

  /**
   * Change a station's state.
   *
   * Entering an unplanned stop state opens a downtime record; leaving one
   * closes it. That is the whole reason downtime data ever matches reality.
   *
   * @param {string} stationId
   * @param {string} state one of STATION_STATES
   * @param {object} [context] {reason, vin, operator, source}
   */
  setStationState(stationId, state, context = {}, now = new Date()) {
    if (!STATION_STATES[state]) {
      throw new ValidationError(
        `state must be one of ${Object.keys(STATION_STATES).join(', ')}`,
        { state }
      );
    }
    const current = this.getStationState(stationId);

    // Lockout. A station an operator stopped, or that a technician is working
    // on, does not change state because a controller - the simulator, a flow,
    // a PLC over MQTT - decided it should. Only the explicit control actions
    // below pass `override`.
    if (controlCore.isLocked(current) && !context.override) {
      const { mode, by } = controlCore.controlOf(current);
      throw new StateTransitionError(
        'Station', stationId, current.state, state,
        `Station ${stationId} is locked in ${mode} by ${by}; ` +
        (mode === 'MAINTENANCE' ? 'complete the maintenance order' : 'start it') +
        ' before changing its state'
      );
    }

    if (current.state === state) return current;

    const wasStopped = STOP_STATES.includes(current.state);
    const isStopped = STOP_STATES.includes(state);

    let openDowntimeId = current.openDowntimeId;

    if (context.skipDowntime) {
      // The caller manages downtime itself (maintenance does).
    } else if (isStopped && !wasStopped) {
      const record = this.startDowntime({
        stationId,
        reasonCode: context.reasonCode || this.#reasonForState(state),
        note: context.reason || null,
        reportedBy: context.operator || 'SYSTEM',
        andonId: context.andonId || null
      }, now);
      openDowntimeId = record.id;
    } else if (!isStopped && wasStopped && openDowntimeId) {
      this.#closeOrDiscardDowntime(openDowntimeId, context, now);
      openDowntimeId = null;
    }

    const next = {
      ...current,
      state,
      previousState: current.state,
      since: now.toISOString(),
      currentVin: context.vin ?? current.currentVin,
      openDowntimeId: context.skipDowntime ? (context.openDowntimeId ?? openDowntimeId) : openDowntimeId,
      ...(context.control ? { control: context.control } : {}),
      updatedAt: now.toISOString()
    };
    this.repo.put('stationStates', next);

    this.bus.publish(EVENT_TYPES.STATION_STATE_CHANGED, {
      stationId,
      stationName: current.stationName,
      lineId: current.lineId,
      state,
      previousState: current.state,
      reason: context.reason || null,
      vin: next.currentVin
    }, { stationId, lineId: current.lineId, source: context.source || 'api' });

    return next;
  }

  /** Record one completed cycle at a station. Drives performance and counts. */
  recordCycle(stationId, { vin, cycleSeconds, good = true }, now = new Date()) {
    const current = this.getStationState(stationId);
    const next = {
      ...current,
      cycleCount: current.cycleCount + 1,
      cyclesSinceMaintenance: (current.cyclesSinceMaintenance ?? 0) + 1,
      goodCount: current.goodCount + (good ? 1 : 0),
      scrapCount: current.scrapCount + (good ? 0 : 1),
      lastCycleSeconds: cycleSeconds ?? current.lastCycleSeconds,
      currentVin: vin ?? current.currentVin,
      updatedAt: now.toISOString()
    };
    this.repo.put('stationStates', next);

    this.bus.publish(EVENT_TYPES.STATION_CYCLE_COMPLETE, {
      stationId,
      lineId: current.lineId,
      vin,
      cycleSeconds,
      idealCycleSeconds: current.idealCycleSeconds,
      good,
      cycleCount: next.cycleCount
    }, { stationId, lineId: current.lineId, vin, source: 'simulator' });

    return next;
  }

  /** Append a telemetry sample to the capped series. */
  recordTelemetry(sample, now = new Date()) {
    const record = {
      timestamp: (sample.timestamp ? new Date(sample.timestamp) : now).toISOString(),
      stationId: sample.stationId,
      lineId: getStation(sample.stationId)?.lineId || null,
      metrics: sample.metrics || {}
    };
    this.repo.append('telemetry', record);
    this.bus.publish(EVENT_TYPES.TELEMETRY, record, {
      stationId: record.stationId, lineId: record.lineId, source: 'simulator'
    });
    return record;
  }

  listTelemetry(query = {}) {
    return this.repo.series_('telemetry', {
      where: (t) =>
        (!query.stationId || t.stationId === query.stationId)
        && (!query.lineId || t.lineId === query.lineId),
      since: query.since,
      limit: query.limit ?? 100
    });
  }

  /**
   * Close a downtime record, or discard it if it was only a micro-stop.
   *
   * A station blocked for a few seconds while the one downstream finishes is
   * not a breakdown. Logging every one of those would bury the genuine
   * failures, so short stops are removed rather than closed - they still show
   * up as performance loss in the OEE calculation, which is where ISO 22400
   * says idling and minor stops belong.
   */
  #closeOrDiscardDowntime(downtimeId, context, now) {
    const record = this.repo.get('downtimes', downtimeId);
    if (!record || record.endedAt) return;

    const elapsed = Math.round((now.getTime() - Date.parse(record.startedAt)) / 1000);
    const threshold = config.operations.minDowntimeSeconds;

    // Planned stops are always recorded, however brief - a two-minute
    // changeover is still a changeover.
    if (record.category === 'UNPLANNED' && elapsed < threshold) {
      this.repo.delete('downtimes', downtimeId);
      this.microStops.total += 1;
      this.microStops.seconds += elapsed;
      this.microStops.byStation[record.stationId] =
        (this.microStops.byStation[record.stationId] || 0) + 1;
      return;
    }

    this.endDowntime(downtimeId, { repairedBy: context.operator }, now);
  }

  #reasonForState(state) {
    switch (state) {
      case STATION_STATES.DOWN: return 'EQUIP_FAILURE';
      case STATION_STATES.STOPPED: return 'OPERATOR_STOP';
      case STATION_STATES.STARVED: return 'DOWNSTREAM_STARVED';
      case STATION_STATES.BLOCKED: return 'UPSTREAM_BLOCKED';
      case STATION_STATES.MAINTENANCE: return 'PREVENTIVE_MAINT';
      case STATION_STATES.CHANGEOVER: return 'CHANGEOVER';
      default: return 'EQUIP_FAILURE';
    }
  }

  // ---- operator control ---------------------------------------------------

  /**
   * Everything a control panel needs for one station: live state, who is in
   * charge of it, which buttons are legal, PM status and any open order.
   */
  stationControl(stationId) {
    const state = this.getStationState(stationId);
    const { allowed, blocked } = controlCore.availableActions(state);
    const active = state.control?.maintenanceOrderId
      ? this.repo.get('maintenanceOrders', state.control.maintenanceOrderId)
      : null;

    return {
      stationId,
      stationName: state.stationName,
      lineId: state.lineId,
      state: state.state,
      since: state.since,
      control: controlCore.controlOf(state),
      locked: controlCore.isLocked(state),
      allowedActions: allowed,
      blockedActions: blocked,
      pm: controlCore.pmStatus(state),
      activeMaintenance: active,
      openDowntimeId: state.openDowntimeId,
      openAndonId: state.openAndonId
    };
  }

  /**
   * Operator stop. The station holds whatever vehicle it has and stays
   * stopped - nothing automated will restart it - until someone starts it.
   *
   * @param {string} stationId
   * @param {object} [context] {operator, reasonCode, reason}
   *   reasonCode decides whether the stop is planned (a break, a meeting) or
   *   an availability loss; it defaults to OPERATOR_STOP.
   */
  stopStation(stationId, context = {}, now = new Date()) {
    const current = this.getStationState(stationId);
    controlCore.assertAction(current, controlCore.ACTIONS.STOP);

    const reasonCode = context.reasonCode || 'OPERATOR_STOP';
    if (!downtimeCore.getReasonCode(reasonCode)) {
      throw new ValidationError(`Unknown reason code '${reasonCode}'`, { field: 'reasonCode' });
    }

    const control = controlCore.controlBlock(controlCore.CONTROL_MODES.STOPPED, {
      operator: context.operator, reason: context.reason, reasonCode
    }, now);

    const next = this.setStationState(stationId, STATION_STATES.STOPPED, {
      override: true,
      reasonCode,
      reason: context.reason || `Stopped by ${context.operator || 'operator'}`,
      operator: context.operator,
      control,
      source: context.source || 'api'
    }, now);

    this.bus.publish(EVENT_TYPES.STATION_STOPPED, {
      stationId,
      stationName: next.stationName,
      lineId: next.lineId,
      reasonCode,
      reason: context.reason || null,
      by: control.by,
      downtimeId: next.openDowntimeId
    }, { stationId, lineId: next.lineId, source: context.source || 'api' });

    log.info('station stopped', { stationId, by: control.by, reasonCode });
    return this.stationControl(stationId);
  }

  /**
   * Put a station back in service. From an operator stop, or from a fault once
   * nothing is holding it down - an open line-stopping andon still has to be
   * resolved, because that is where the response time is recorded.
   */
  startStation(stationId, context = {}, now = new Date()) {
    const current = this.getStationState(stationId);
    controlCore.assertAction(current, controlCore.ACTIONS.START);

    const occupied = this.#occupant(stationId);
    const target = occupied ? STATION_STATES.RUNNING : STATION_STATES.IDLE;
    const next = this.setStationState(stationId, target, {
      override: true,
      operator: context.operator,
      vin: occupied?.vin ?? current.currentVin,
      control: controlCore.controlBlock(controlCore.CONTROL_MODES.AUTO, { operator: context.operator }, now),
      source: context.source || 'api'
    }, now);

    this.bus.publish(EVENT_TYPES.STATION_STARTED, {
      stationId,
      stationName: next.stationName,
      lineId: next.lineId,
      previousState: current.state,
      by: context.operator || 'SYSTEM',
      note: context.note || null
    }, { stationId, lineId: next.lineId, source: context.source || 'api' });

    log.info('station started', { stationId, by: context.operator || 'SYSTEM' });
    return this.stationControl(stationId);
  }

  /**
   * Hand a station to maintenance under a maintenance order.
   *
   * Downtime is booked by type. Preventive work closes whatever stop was open
   * and books PREVENTIVE_MAINT, which is planned and comes out of planned
   * busy time. Corrective work on a station that is already down keeps the
   * failure's downtime running - it is one outage, not two - and links the
   * order to it.
   *
   * @param {object} [context] {type, technician, plannedMinutes, note}
   */
  startMaintenance(stationId, context = {}, now = new Date()) {
    const current = this.getStationState(stationId);
    controlCore.assertAction(current, controlCore.ACTIONS.START_MAINTENANCE);

    const typeCode = context.type || (current.state === STATION_STATES.DOWN ? 'CORRECTIVE' : 'PREVENTIVE');
    const type = controlCore.MAINTENANCE_TYPES[typeCode];
    if (!type) {
      throw new ValidationError(
        `type must be one of ${Object.keys(controlCore.MAINTENANCE_TYPES).join(', ')}`,
        { field: 'type' }
      );
    }

    let downtimeId = current.openDowntimeId;
    const keepFailure = !type.planned && downtimeId;

    if (!keepFailure) {
      if (downtimeId) this.endDowntime(downtimeId, { repairedBy: context.technician }, now);
      downtimeId = this.startDowntime({
        stationId,
        reasonCode: type.reasonCode,
        note: `${type.label}${context.note ? `: ${context.note}` : ''}`,
        reportedBy: context.technician || 'MAINTENANCE'
      }, now).id;
    }

    const order = controlCore.createMaintenanceOrder({
      id: ids.sequentialId('MWO', this.repo.nextSequence('maintenance')),
      stationId,
      type: typeCode,
      technician: context.technician,
      plannedMinutes: context.plannedMinutes,
      note: context.note,
      downtimeId,
      andonId: current.openAndonId || null,
      cyclesSinceMaintenance: current.cyclesSinceMaintenance ?? 0
    }, now);
    this.repo.put('maintenanceOrders', order);

    const next = this.setStationState(stationId, STATION_STATES.MAINTENANCE, {
      override: true,
      skipDowntime: true,
      openDowntimeId: downtimeId,
      operator: context.technician,
      reason: order.typeLabel,
      control: controlCore.controlBlock(controlCore.CONTROL_MODES.MAINTENANCE, {
        operator: order.technician,
        reason: order.typeLabel,
        reasonCode: type.reasonCode,
        maintenanceOrderId: order.id
      }, now),
      source: context.source || 'api'
    }, now);

    this.bus.publish(EVENT_TYPES.MAINTENANCE_STARTED, {
      id: order.id,
      stationId,
      stationName: next.stationName,
      lineId: next.lineId,
      type: order.type,
      technician: order.technician,
      plannedMinutes: order.plannedMinutes,
      downtimeId
    }, { stationId, lineId: next.lineId, source: context.source || 'api' });

    log.info('maintenance started', { id: order.id, stationId, type: order.type });
    return this.stationControl(stationId);
  }

  /**
   * Sign maintenance off and return the station to service.
   *
   * Closes the downtime, resets the PM counter, and - if the work was the
   * response to an andon call - resolves that call too, so the andon log, the
   * downtime log and the maintenance log all tell the same story.
   *
   * @param {object} [context] {technician, findings, partsReplaced, checklist}
   */
  completeMaintenance(stationId, context = {}, now = new Date()) {
    const current = this.getStationState(stationId);
    controlCore.assertAction(current, controlCore.ACTIONS.COMPLETE_MAINTENANCE);

    const orderId = current.control.maintenanceOrderId;
    const order = this.repo.get('maintenanceOrders', orderId);
    if (!order) throw new NotFoundError('MaintenanceOrder', orderId);

    const completed = controlCore.completeMaintenanceOrder(order, context, now);
    this.repo.put('maintenanceOrders', completed);

    if (current.openDowntimeId) {
      this.endDowntime(current.openDowntimeId, {
        repairedBy: completed.completedBy,
        rootCause: order.type === 'CORRECTIVE' ? (context.findings || null) : null,
        correctiveAction: `${completed.typeLabel} ${completed.id}`
      }, now);
    }

    const occupied = this.#occupant(stationId);
    const target = occupied ? STATION_STATES.RUNNING : STATION_STATES.IDLE;
    const next = this.setStationState(stationId, target, {
      override: true,
      skipDowntime: true,
      openDowntimeId: null,
      operator: completed.completedBy,
      vin: occupied?.vin ?? current.currentVin,
      control: controlCore.controlBlock(
        controlCore.CONTROL_MODES.AUTO, { operator: completed.completedBy }, now
      ),
      source: context.source || 'api'
    }, now);

    this.repo.put('stationStates', {
      ...next,
      cyclesSinceMaintenance: 0,
      lastMaintenanceAt: now.toISOString()
    });

    const andonId = current.openAndonId || order.andonId;
    const andon = andonId ? this.repo.get('andons', andonId) : null;
    if (andon && andonCore.isOpen(andon)) {
      this.resolveAndon(andonId, `${completed.typeLabel} ${completed.id}`, completed.completedBy, now);
    }

    this.bus.publish(EVENT_TYPES.MAINTENANCE_COMPLETED, {
      id: completed.id,
      stationId,
      stationName: next.stationName,
      lineId: next.lineId,
      type: completed.type,
      technician: completed.completedBy,
      actualMinutes: completed.actualMinutes,
      plannedMinutes: completed.plannedMinutes,
      overrunMinutes: completed.overrunMinutes,
      checklistComplete: completed.checklistComplete
    }, { stationId, lineId: next.lineId, source: context.source || 'api' });

    log.info('maintenance completed', {
      id: completed.id, stationId, minutes: completed.actualMinutes
    });
    return { ...this.stationControl(stationId), completedOrder: completed };
  }

  getMaintenanceOrder(id) {
    const order = this.repo.get('maintenanceOrders', id);
    if (!order) throw new NotFoundError('MaintenanceOrder', id);
    return order;
  }

  listMaintenance(query = {}) {
    return this.repo.find('maintenanceOrders', {
      where: (o) =>
        (!query.stationId || o.stationId === query.stationId)
        && (!query.lineId || o.lineId === query.lineId)
        && (!query.status || o.status === query.status)
        && (!query.type || o.type === query.type),
      sort: 'startedAt',
      order: 'desc',
      limit: query.limit ?? 50,
      offset: query.offset
    });
  }

  /** PM status for every station, most overdue first. */
  maintenanceDue(query = {}) {
    const rank = { OVERDUE: 0, DUE: 1, DUE_SOON: 2, OK: 3 };
    return this.listStationStates(query.lineId)
      .map((state) => ({
        ...controlCore.pmStatus(state),
        controlMode: controlCore.controlOf(state).mode
      }))
      .filter((pm) => !query.dueOnly || pm.status !== 'OK')
      .sort((a, b) => rank[a.status] - rank[b.status] || b.usedPct - a.usedPct);
  }

  /** The non-terminal vehicle currently at a station, if any. */
  #occupant(stationId) {
    return this.repo
      .all('units')
      .find((u) => u.currentStation === stationId && !unitCore.isTerminal(u.status)) || null;
  }

  // ---- andon -------------------------------------------------------------

  /**
   * Raise an andon call. If the call type stops the line, the station is put
   * DOWN and a downtime record opens in the same operation.
   */
  raiseAndon(input, now = new Date()) {
    const id = input.id || ids.sequentialId('AND', this.repo.nextSequence('andon'));
    const andon = andonCore.createAndon({ ...input, id }, now);
    this.repo.put('andons', andon);

    const stationState = this.repo.get('stationStates', andon.stationId);
    if (stationState) {
      this.repo.put('stationStates', { ...stationState, openAndonId: andon.id });
    }

    this.bus.publish(EVENT_TYPES.ANDON_RAISED, {
      id: andon.id,
      stationId: andon.stationId,
      stationName: andon.stationName,
      lineId: andon.lineId,
      callType: andon.callType,
      label: andon.label,
      colour: andon.colour,
      stopsLine: andon.stopsLine,
      slaSeconds: andon.slaSeconds,
      vin: andon.vin,
      raisedBy: andon.raisedBy
    }, { stationId: andon.stationId, lineId: andon.lineId, vin: andon.vin });

    // A locked station is already stopped by a person; the call is still
    // raised and still timed, but it does not fight the lockout.
    const target = this.repo.get('stationStates', andon.stationId);
    if (andon.stopsLine && !controlCore.isLocked(target)) {
      this.setStationState(andon.stationId, STATION_STATES.DOWN, {
        reasonCode: ANDON_TO_REASON[andon.callType] || 'ANDON_STOP',
        reason: `Andon ${andon.id}: ${andon.label}`,
        andonId: andon.id,
        operator: andon.raisedBy,
        source: 'andon'
      }, now);

      const linked = this.repo.get('andons', andon.id);
      const openDowntime = this.repo.get('stationStates', andon.stationId)?.openDowntimeId;
      if (openDowntime) this.repo.put('andons', { ...linked, downtimeId: openDowntime });
    }

    log.info('andon raised', {
      id: andon.id, type: andon.callType, station: andon.stationId, stopsLine: andon.stopsLine
    });
    return this.repo.get('andons', andon.id);
  }

  getAndon(id) {
    const andon = this.repo.get('andons', id);
    if (!andon) throw new NotFoundError('Andon', id);
    return andon;
  }

  listAndons(query = {}) {
    return this.repo.find('andons', {
      where: (a) =>
        (!query.status || a.status === query.status)
        && (!query.stationId || a.stationId === query.stationId)
        && (!query.lineId || a.lineId === query.lineId)
        && (!query.callType || a.callType === query.callType)
        && (query.open === undefined || andonCore.isOpen(a) === query.open),
      sort: 'raisedAt',
      order: 'desc',
      limit: query.limit ?? 50,
      offset: query.offset
    });
  }

  acknowledgeAndon(id, responder, now = new Date()) {
    const next = andonCore.acknowledge(this.getAndon(id), responder, now);
    this.repo.put('andons', next);
    this.bus.publish(EVENT_TYPES.ANDON_ACKNOWLEDGED, {
      id, responder, responseSeconds: next.responseSeconds, slaMet: next.slaMet,
      stationId: next.stationId
    }, { stationId: next.stationId, lineId: next.lineId });
    return next;
  }

  escalateAndon(id, now = new Date()) {
    const next = andonCore.escalate(this.getAndon(id), now);
    this.repo.put('andons', next);
    this.bus.publish(EVENT_TYPES.ANDON_ESCALATED, {
      id, tier: next.escalationTier, escalatedTo: next.escalatedTo,
      stationId: next.stationId, ageSeconds: andonCore.ageSeconds(next, now)
    }, { stationId: next.stationId, lineId: next.lineId });
    log.warn('andon escalated', { id, tier: next.escalationTier, to: next.escalatedTo });
    return next;
  }

  /** Resolve a call and bring the station back up. */
  resolveAndon(id, resolution, resolver, now = new Date()) {
    const andon = this.getAndon(id);
    const next = andonCore.resolve(andon, resolution, resolver, now);
    this.repo.put('andons', next);

    const stationState = this.repo.get('stationStates', next.stationId);
    if (stationState) {
      this.repo.put('stationStates', { ...stationState, openAndonId: null });
    }

    const after = this.repo.get('stationStates', next.stationId);
    if (next.stopsLine && !controlCore.isLocked(after) && after?.state === STATION_STATES.DOWN) {
      this.setStationState(next.stationId, STATION_STATES.RUNNING, {
        operator: resolver, source: 'andon'
      }, now);
    }

    this.bus.publish(EVENT_TYPES.ANDON_RESOLVED, {
      id,
      stationId: next.stationId,
      lineId: next.lineId,
      resolution,
      resolvedBy: resolver,
      responseSeconds: next.responseSeconds,
      resolutionSeconds: next.resolutionSeconds,
      slaMet: next.slaMet
    }, { stationId: next.stationId, lineId: next.lineId });

    return next;
  }

  /**
   * Escalate every open call that has blown its SLA.
   * Flows and the simulator both run this on a timer.
   */
  sweepEscalations(now = new Date()) {
    const escalated = [];
    for (const andon of this.repo.all('andons')) {
      if (andonCore.shouldEscalate(andon, now)) {
        escalated.push(this.escalateAndon(andon.id, now));
      }
    }
    return escalated;
  }

  // ---- downtime ----------------------------------------------------------

  startDowntime(input, now = new Date()) {
    const id = input.id || ids.sequentialId('DT', this.repo.nextSequence('downtime'));
    const record = downtimeCore.createDowntime({ ...input, id }, now);
    this.repo.put('downtimes', record);

    this.bus.publish(EVENT_TYPES.DOWNTIME_STARTED, {
      id: record.id,
      stationId: record.stationId,
      lineId: record.lineId,
      reasonCode: record.reasonCode,
      reasonLabel: record.reasonLabel,
      category: record.category,
      bigLoss: record.bigLoss,
      andonId: record.andonId
    }, { stationId: record.stationId, lineId: record.lineId });

    return record;
  }

  endDowntime(id, context = {}, now = new Date()) {
    const record = this.repo.get('downtimes', id);
    if (!record) throw new NotFoundError('Downtime', id);
    if (record.endedAt) return record;

    const closed = downtimeCore.endDowntime(record, context, now);
    this.repo.put('downtimes', closed);

    this.bus.publish(EVENT_TYPES.DOWNTIME_ENDED, {
      id,
      stationId: closed.stationId,
      lineId: closed.lineId,
      reasonCode: closed.reasonCode,
      durationSeconds: closed.durationSeconds,
      rootCause: closed.rootCause
    }, { stationId: closed.stationId, lineId: closed.lineId });

    return closed;
  }

  listDowntimes(query = {}) {
    return this.repo.find('downtimes', {
      where: (d) =>
        (!query.stationId || d.stationId === query.stationId)
        && (!query.lineId || d.lineId === query.lineId)
        && (!query.reasonCode || d.reasonCode === query.reasonCode)
        && (!query.category || d.category === query.category)
        && (query.open === undefined || downtimeCore.isOpen(d) === query.open)
        && (!query.since || Date.parse(d.startedAt) >= Date.parse(query.since)),
      sort: 'startedAt',
      order: 'desc',
      limit: query.limit ?? 50,
      offset: query.offset
    });
  }

  /** Stations that are stopped right now. The first thing a supervisor checks. */
  currentStops() {
    return this.repo
      .all('downtimes')
      .filter(downtimeCore.isOpen)
      .map((d) => ({
        id: d.id,
        stationId: d.stationId,
        stationName: d.stationName,
        lineId: d.lineId,
        reasonCode: d.reasonCode,
        reasonLabel: d.reasonLabel,
        category: d.category,
        startedAt: d.startedAt,
        elapsedSeconds: downtimeCore.elapsedSeconds(d),
        andonId: d.andonId
      }))
      .sort((a, b) => b.elapsedSeconds - a.elapsedSeconds);
  }

  /** Andon and downtime performance over a window. */
  summary(options = {}) {
    const since = options.since ? Date.parse(options.since) : 0;
    const andons = this.repo.all('andons').filter(
      (a) => Date.parse(a.raisedAt) >= since && (!options.lineId || a.lineId === options.lineId)
    );
    const downtimes = this.repo.all('downtimes').filter(
      (d) => Date.parse(d.startedAt) >= since && (!options.lineId || d.lineId === options.lineId)
    );
    const operatingSeconds = options.operatingSeconds ?? 8 * 3600;

    return {
      windowStart: options.since || null,
      lineId: options.lineId || 'ALL',
      andon: andonCore.summarise(andons),
      downtime: {
        ...downtimeCore.split(downtimes),
        openCount: downtimes.filter(downtimeCore.isOpen).length,
        pareto: downtimeCore.pareto(downtimes, { limit: 8 })
      },
      reliability: downtimeCore.reliability(downtimes, operatingSeconds),
      microStops: {
        ...this.microStops,
        minutes: Number((this.microStops.seconds / 60).toFixed(1)),
        thresholdSeconds: config.operations.minDowntimeSeconds,
        note: 'Stops below the threshold are counted as performance loss, not availability loss (ISO 22400).'
      },
      currentStops: this.currentStops()
    };
  }
}

module.exports = { OperationsService, ANDON_TO_REASON };
