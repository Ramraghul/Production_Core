'use strict';

/**
 * Vehicle unit lifecycle.
 *
 * A "unit" is one physical vehicle moving through the plant. It is created
 * when a work order is released, gets a VIN at body-in-white, accumulates a
 * station-by-station history, and is either released to the yard or scrapped.
 *
 *   PLANNED -> IN_PROCESS -> COMPLETED
 *                  |  ^
 *                  |  |
 *                  v  |
 *              HOLD ---+--> REWORK --+
 *                  |                 |
 *                  +-----------------+--> SCRAPPED
 *
 * Every station visit is recorded as an immutable history entry. That history
 * is what makes "where was VIN X at 03:14 and who touched it" answerable,
 * which is the whole reason a plant runs an MES rather than a spreadsheet.
 */

const { ValidationError, StateTransitionError, NotFoundError } = require('./errors');
const {
  getStation,
  getModel,
  nextMainStation,
  MAIN_STATION_ROUTE
} = require('./plantModel');
const { isValidVin } = require('./ids');

const UNIT_STATES = Object.freeze({
  PLANNED: 'PLANNED',
  IN_PROCESS: 'IN_PROCESS',
  HOLD: 'HOLD',
  REWORK: 'REWORK',
  COMPLETED: 'COMPLETED',
  SCRAPPED: 'SCRAPPED'
});

const TRANSITIONS = Object.freeze({
  PLANNED: ['IN_PROCESS', 'SCRAPPED'],
  IN_PROCESS: ['HOLD', 'REWORK', 'COMPLETED', 'SCRAPPED'],
  HOLD: ['IN_PROCESS', 'REWORK', 'SCRAPPED'],
  REWORK: ['IN_PROCESS', 'SCRAPPED'],
  COMPLETED: [],
  SCRAPPED: []
});

/** What happened during one station visit. */
const VISIT_RESULTS = Object.freeze({
  PASS: 'PASS',
  FAIL: 'FAIL',
  REWORKED: 'REWORKED',
  SKIPPED: 'SKIPPED'
});

const isTerminal = (state) => TRANSITIONS[state]?.length === 0;

/**
 * Create a unit in PLANNED state. The VIN is assigned up front (a real plant
 * assigns it at body-in-white, and we record that moment in the history) so
 * that feeder lines can be sequenced against it.
 *
 * @param {object} input
 * @param {string} input.vin
 * @param {string} input.workOrderId
 * @param {string} input.modelCode
 * @param {string} input.colour
 * @param {number} input.buildNumber  sequence within the work order
 */
function createUnit(input, now = new Date()) {
  const errors = [];

  if (!input?.vin) errors.push({ field: 'vin', message: 'vin is required' });
  else if (!isValidVin(input.vin)) {
    errors.push({ field: 'vin', message: 'vin failed ISO 3779 check-digit validation' });
  }
  if (!input?.workOrderId) errors.push({ field: 'workOrderId', message: 'workOrderId is required' });
  if (!input?.modelCode) errors.push({ field: 'modelCode', message: 'modelCode is required' });
  else if (!getModel(input.modelCode)) {
    errors.push({ field: 'modelCode', message: `unknown model '${input.modelCode}'` });
  }
  if (errors.length) throw new ValidationError('Unit payload failed validation', errors);

  const model = getModel(input.modelCode);
  const timestamp = now.toISOString();

  return {
    vin: input.vin,
    workOrderId: input.workOrderId,
    modelCode: input.modelCode,
    modelName: model.name,
    variant: model.variant,
    bodyStyle: model.bodyStyle,
    powertrain: model.powertrain,
    colour: input.colour || model.colours[0],
    buildNumber: input.buildNumber ?? null,
    status: UNIT_STATES.PLANNED,
    currentStation: null,
    currentLine: null,
    enteredStationAt: null,
    // Stations whose quality gate this unit has cleared.
    gatesPassed: [],
    history: [],
    openDefectIds: [],
    holdReason: null,
    reworkCount: 0,
    scrapReason: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    startedAt: null,
    completedAt: null,
    // Populated at EOL-60 when the vehicle is released.
    releasedAt: null,
    totalCycleSeconds: 0
  };
}

/**
 * Move a unit onto a station.
 *
 * Closes the previous station visit (recording dwell time and result) and opens
 * a new one. Enforces routing: you cannot teleport a body from BODY-10 to
 * FINAL-40 without passing through everything in between, unless `force` is
 * set, which is what a manual MES override looks like.
 *
 * @param {object} unit
 * @param {string} stationId
 * @param {object} [options]
 * @param {Date}   [options.at]
 * @param {string} [options.result]    result of the visit being closed
 * @param {string} [options.operator]
 * @param {boolean}[options.force]     bypass the routing check (audited)
 * @param {number} [options.cycleSeconds] override measured cycle time
 * @returns {object} new unit
 */
function moveToStation(unit, stationId, options = {}) {
  const station = getStation(stationId);
  if (!station) throw new NotFoundError('Station', stationId);

  if (isTerminal(unit.status)) {
    throw new StateTransitionError(
      'Unit', unit.vin, unit.status, 'IN_PROCESS',
      `Unit ${unit.vin} is ${unit.status} and cannot be moved`
    );
  }

  const at = options.at || new Date();
  const atIso = at.toISOString();

  // --- Routing check -------------------------------------------------------
  const isMainRouteTarget = MAIN_STATION_ROUTE.includes(stationId);
  if (isMainRouteTarget && !options.force) {
    const expected = unit.currentStation
      ? nextMainStation(unit.currentStation)
      : MAIN_STATION_ROUTE[0];

    // Re-entering the same station is allowed: that is a rework loop.
    const isRework = stationId === unit.currentStation;
    if (!isRework && expected && stationId !== expected) {
      throw new StateTransitionError(
        'Unit', unit.vin, unit.currentStation || 'NONE', stationId,
        `Routing violation: ${unit.vin} must go to ${expected} next, not ${stationId}`
      );
    }
  }

  const history = unit.history.slice();
  let totalCycleSeconds = unit.totalCycleSeconds;

  // Close the open visit, if any.
  if (unit.currentStation && unit.enteredStationAt) {
    const dwellSeconds = Math.max(
      0,
      Math.round((at.getTime() - Date.parse(unit.enteredStationAt)) / 1000)
    );
    const previous = getStation(unit.currentStation);
    const cycleSeconds = options.cycleSeconds ?? dwellSeconds;
    totalCycleSeconds += cycleSeconds;

    history.push({
      stationId: unit.currentStation,
      stationName: previous?.name || unit.currentStation,
      lineId: previous?.lineId || null,
      enteredAt: unit.enteredStationAt,
      exitedAt: atIso,
      dwellSeconds,
      cycleSeconds,
      idealCycleSeconds: previous?.cycleSeconds ?? null,
      // Positive = slower than the ideal cycle, i.e. a performance loss.
      cycleVarianceSeconds: previous
        ? Number((cycleSeconds - previous.cycleSeconds).toFixed(1))
        : null,
      result: options.result || VISIT_RESULTS.PASS,
      operator: options.operator || 'SYSTEM'
    });
  }

  const gatesPassed = unit.gatesPassed.slice();
  const closed = getStation(unit.currentStation);
  if (closed?.qualityGate
      && (options.result || VISIT_RESULTS.PASS) === VISIT_RESULTS.PASS
      && !gatesPassed.includes(closed.id)) {
    gatesPassed.push(closed.id);
  }

  return {
    ...unit,
    status: unit.status === UNIT_STATES.PLANNED ? UNIT_STATES.IN_PROCESS : unit.status,
    currentStation: stationId,
    currentLine: station.lineId,
    enteredStationAt: atIso,
    history,
    gatesPassed,
    totalCycleSeconds,
    startedAt: unit.startedAt || atIso,
    updatedAt: atIso,
    ...(options.force ? { lastOverrideAt: atIso, lastOverrideBy: options.operator || 'SYSTEM' } : {})
  };
}

/**
 * Put a unit on hold, typically because a quality gate rejected it.
 * @returns {object} new unit
 */
function hold(unit, reason, options = {}) {
  assertTransition(unit, UNIT_STATES.HOLD);
  const at = (options.at || new Date()).toISOString();
  return {
    ...unit,
    status: UNIT_STATES.HOLD,
    holdReason: reason || 'Unspecified',
    heldAt: at,
    heldBy: options.operator || 'SYSTEM',
    updatedAt: at
  };
}

/** Send a held unit into the rework loop. */
function sendToRework(unit, reason, options = {}) {
  assertTransition(unit, UNIT_STATES.REWORK);
  const at = (options.at || new Date()).toISOString();
  return {
    ...unit,
    status: UNIT_STATES.REWORK,
    reworkCount: unit.reworkCount + 1,
    holdReason: reason || unit.holdReason,
    updatedAt: at
  };
}

/** Return a held or reworked unit to the line. */
function release(unit, options = {}) {
  assertTransition(unit, UNIT_STATES.IN_PROCESS);
  const at = (options.at || new Date()).toISOString();
  return {
    ...unit,
    status: UNIT_STATES.IN_PROCESS,
    holdReason: null,
    updatedAt: at,
    // The clock restarts: time spent on hold is downtime, not cycle time.
    enteredStationAt: at
  };
}

/**
 * Complete a unit. Only legal from the terminal station, and only when every
 * quality gate on the route has been cleared and no defects remain open.
 */
function complete(unit, options = {}) {
  assertTransition(unit, UNIT_STATES.COMPLETED);

  const station = getStation(unit.currentStation);
  if (!options.force) {
    if (!station?.terminal) {
      throw new StateTransitionError(
        'Unit', unit.vin, unit.status, UNIT_STATES.COMPLETED,
        `Unit ${unit.vin} is at ${unit.currentStation || 'no station'}, not the end-of-line release station`
      );
    }
    if (unit.openDefectIds.length) {
      throw new StateTransitionError(
        'Unit', unit.vin, unit.status, UNIT_STATES.COMPLETED,
        `Unit ${unit.vin} has ${unit.openDefectIds.length} open defect(s) and cannot be released`
      );
    }
  }

  const at = options.at || new Date();
  const atIso = at.toISOString();
  const history = unit.history.slice();

  if (unit.currentStation && unit.enteredStationAt) {
    const dwellSeconds = Math.max(
      0, Math.round((at.getTime() - Date.parse(unit.enteredStationAt)) / 1000)
    );
    history.push({
      stationId: unit.currentStation,
      stationName: station?.name || unit.currentStation,
      lineId: station?.lineId || null,
      enteredAt: unit.enteredStationAt,
      exitedAt: atIso,
      dwellSeconds,
      cycleSeconds: dwellSeconds,
      idealCycleSeconds: station?.cycleSeconds ?? null,
      cycleVarianceSeconds: station ? Number((dwellSeconds - station.cycleSeconds).toFixed(1)) : null,
      result: VISIT_RESULTS.PASS,
      operator: options.operator || 'SYSTEM'
    });
  }

  const gatesPassed = unit.gatesPassed.slice();
  if (station?.qualityGate && !gatesPassed.includes(station.id)) gatesPassed.push(station.id);

  return {
    ...unit,
    status: UNIT_STATES.COMPLETED,
    history,
    gatesPassed,
    currentStation: null,
    currentLine: null,
    enteredStationAt: null,
    completedAt: atIso,
    releasedAt: atIso,
    updatedAt: atIso,
    // Build time from first station entry to release, in minutes.
    buildMinutes: unit.startedAt
      ? Number(((at.getTime() - Date.parse(unit.startedAt)) / 60000).toFixed(1))
      : null
  };
}

/** Scrap a unit. Terminal and irreversible, as in a real plant. */
function scrap(unit, reason, options = {}) {
  assertTransition(unit, UNIT_STATES.SCRAPPED);
  const at = (options.at || new Date()).toISOString();
  return {
    ...unit,
    status: UNIT_STATES.SCRAPPED,
    scrapReason: reason || 'Unspecified',
    scrappedAt: at,
    scrappedBy: options.operator || 'SYSTEM',
    scrappedAtStation: unit.currentStation,
    currentStation: null,
    currentLine: null,
    enteredStationAt: null,
    updatedAt: at
  };
}

function assertTransition(unit, nextState) {
  const allowed = TRANSITIONS[unit.status];
  if (!allowed) {
    throw new StateTransitionError('Unit', unit.vin, unit.status, nextState, `Unknown state '${unit.status}'`);
  }
  if (!allowed.includes(nextState)) {
    throw new StateTransitionError(
      'Unit', unit.vin, unit.status, nextState,
      isTerminal(unit.status)
        ? `Unit ${unit.vin} is ${unit.status}; no further transitions are possible`
        : `Unit ${unit.vin} cannot move ${unit.status} -> ${nextState}; allowed: ${allowed.join(', ')}`
    );
  }
}

/** Attach a defect id so downstream gates know the unit is not clean. */
function addDefect(unit, defectId) {
  if (unit.openDefectIds.includes(defectId)) return unit;
  return {
    ...unit,
    openDefectIds: [...unit.openDefectIds, defectId],
    updatedAt: new Date().toISOString()
  };
}

/** Clear a defect once it has been dispositioned. */
function clearDefect(unit, defectId) {
  if (!unit.openDefectIds.includes(defectId)) return unit;
  return {
    ...unit,
    openDefectIds: unit.openDefectIds.filter((id) => id !== defectId),
    updatedAt: new Date().toISOString()
  };
}

/**
 * How far through the plant this unit is, 0..100.
 * Based on position in the main route, so it is comparable across models.
 */
function routeProgress(unit) {
  if (unit.status === UNIT_STATES.COMPLETED) return 100;
  if (!unit.currentStation) {
    return unit.history.length
      ? Number(((unit.history.length / MAIN_STATION_ROUTE.length) * 100).toFixed(1))
      : 0;
  }
  const index = MAIN_STATION_ROUTE.indexOf(unit.currentStation);
  if (index === -1) return 0;
  return Number(((index / (MAIN_STATION_ROUTE.length - 1)) * 100).toFixed(1));
}

/**
 * First pass yield for a single unit: did it get through without any FAIL or
 * REWORKED visit? Aggregated across units this becomes the plant FPY.
 */
function isFirstPass(unit) {
  return unit.reworkCount === 0
    && unit.history.every((visit) => visit.result === VISIT_RESULTS.PASS);
}

/** Compact projection for list endpoints and the HMI - omits the history. */
function summarise(unit) {
  return {
    vin: unit.vin,
    workOrderId: unit.workOrderId,
    modelCode: unit.modelCode,
    modelName: unit.modelName,
    colour: unit.colour,
    buildNumber: unit.buildNumber,
    status: unit.status,
    currentStation: unit.currentStation,
    currentLine: unit.currentLine,
    enteredStationAt: unit.enteredStationAt,
    progressPct: routeProgress(unit),
    openDefects: unit.openDefectIds.length,
    reworkCount: unit.reworkCount,
    firstPass: isFirstPass(unit),
    stationsVisited: unit.history.length,
    startedAt: unit.startedAt,
    completedAt: unit.completedAt
  };
}

module.exports = {
  UNIT_STATES,
  VISIT_RESULTS,
  TRANSITIONS,
  createUnit,
  moveToStation,
  hold,
  sendToRework,
  release,
  complete,
  scrap,
  addDefect,
  clearDefect,
  routeProgress,
  isFirstPass,
  isTerminal,
  summarise
};
