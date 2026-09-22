'use strict';

/**
 * Downtime capture with ISO 22400-aligned reason codes.
 *
 * The distinction that matters for OEE is planned vs unplanned. Planned stops
 * (a scheduled changeover, a maintenance window, a break) come out of the
 * numerator AND the denominator of availability; unplanned stops only come out
 * of the numerator, which is why they hurt.
 *
 * Six Big Losses mapping is carried on every reason code, because that is the
 * language continuous-improvement teams actually use.
 */

const { ValidationError, StateTransitionError } = require('./errors');
const { getStation } = require('./plantModel');

const DOWNTIME_CATEGORIES = Object.freeze({
  PLANNED: 'PLANNED',
  UNPLANNED: 'UNPLANNED'
});

/** The Six Big Losses, in the order they are usually presented. */
const BIG_LOSSES = Object.freeze({
  BREAKDOWN: 'BREAKDOWN',                 // availability
  SETUP_ADJUSTMENT: 'SETUP_ADJUSTMENT',   // availability
  IDLING_MINOR_STOP: 'IDLING_MINOR_STOP', // performance
  REDUCED_SPEED: 'REDUCED_SPEED',         // performance
  PROCESS_DEFECT: 'PROCESS_DEFECT',       // quality
  REDUCED_YIELD: 'REDUCED_YIELD'          // quality
});

/**
 * Reason code catalogue.
 * `countsAgainstOee` is false for stops that happen outside planned busy time.
 */
const REASON_CODES = Object.freeze([
  // --- Unplanned ----------------------------------------------------------
  { code: 'EQUIP_FAILURE', label: 'Equipment failure', category: 'UNPLANNED', bigLoss: 'BREAKDOWN', countsAgainstOee: true, requiresMaintenance: true },
  { code: 'ROBOT_FAULT', label: 'Robot fault or E-stop', category: 'UNPLANNED', bigLoss: 'BREAKDOWN', countsAgainstOee: true, requiresMaintenance: true },
  { code: 'TOOL_BREAKAGE', label: 'Tool or fixture breakage', category: 'UNPLANNED', bigLoss: 'BREAKDOWN', countsAgainstOee: true, requiresMaintenance: true },
  { code: 'CONVEYOR_JAM', label: 'Conveyor or carrier jam', category: 'UNPLANNED', bigLoss: 'IDLING_MINOR_STOP', countsAgainstOee: true },
  { code: 'MATERIAL_SHORTAGE', label: 'Material shortage at line side', category: 'UNPLANNED', bigLoss: 'IDLING_MINOR_STOP', countsAgainstOee: true },
  { code: 'QUALITY_HOLD', label: 'Line held for quality investigation', category: 'UNPLANNED', bigLoss: 'PROCESS_DEFECT', countsAgainstOee: true },
  { code: 'ANDON_STOP', label: 'Andon line stop', category: 'UNPLANNED', bigLoss: 'IDLING_MINOR_STOP', countsAgainstOee: true },
  { code: 'UPSTREAM_BLOCKED', label: 'Blocked by downstream buffer full', category: 'UNPLANNED', bigLoss: 'IDLING_MINOR_STOP', countsAgainstOee: true },
  { code: 'DOWNSTREAM_STARVED', label: 'Starved by upstream stoppage', category: 'UNPLANNED', bigLoss: 'IDLING_MINOR_STOP', countsAgainstOee: true },
  { code: 'OPERATOR_ABSENT', label: 'Operator not at station', category: 'UNPLANNED', bigLoss: 'IDLING_MINOR_STOP', countsAgainstOee: true },
  { code: 'POWER_LOSS', label: 'Utility or power interruption', category: 'UNPLANNED', bigLoss: 'BREAKDOWN', countsAgainstOee: true },
  { code: 'SLOW_CYCLE', label: 'Running below rated speed', category: 'UNPLANNED', bigLoss: 'REDUCED_SPEED', countsAgainstOee: true },
  // An operator stop with no better reason. Deliberately not BREAKDOWN: it is
  // an availability loss, but counting it as an equipment failure would make
  // MTBF describe how often people press a button rather than how often
  // machines fail.
  { code: 'OPERATOR_STOP', label: 'Stopped by operator', category: 'UNPLANNED', bigLoss: null, countsAgainstOee: true },

  // --- Planned ------------------------------------------------------------
  { code: 'CHANGEOVER', label: 'Model changeover', category: 'PLANNED', bigLoss: 'SETUP_ADJUSTMENT', countsAgainstOee: true },
  { code: 'PREVENTIVE_MAINT', label: 'Preventive maintenance', category: 'PLANNED', bigLoss: null, countsAgainstOee: false, requiresMaintenance: true },
  { code: 'SCHEDULED_BREAK', label: 'Scheduled break', category: 'PLANNED', bigLoss: null, countsAgainstOee: false },
  { code: 'SHIFT_MEETING', label: 'Shift start meeting', category: 'PLANNED', bigLoss: null, countsAgainstOee: false },
  { code: 'NO_SCHEDULE', label: 'Not scheduled to run', category: 'PLANNED', bigLoss: null, countsAgainstOee: false },
  { code: 'TRIAL_BUILD', label: 'Engineering trial build', category: 'PLANNED', bigLoss: null, countsAgainstOee: false }
]);

const REASON_BY_CODE = new Map(REASON_CODES.map((r) => [r.code, r]));

const getReasonCode = (code) => REASON_BY_CODE.get(code) || null;
const listReasonCodes = (category) =>
  (category ? REASON_CODES.filter((r) => r.category === category) : REASON_CODES).slice();

/**
 * Open a downtime record. `endedAt` stays null until the stop is closed, which
 * is how the "currently down" query works.
 *
 * @param {object} input
 * @param {string} input.id
 * @param {string} input.stationId
 * @param {string} input.reasonCode
 * @param {string} [input.andonId]  link to the call that triggered the stop
 */
function createDowntime(input, now = new Date()) {
  const errors = [];
  if (!input?.id) errors.push({ field: 'id', message: 'id is required' });
  if (!input?.stationId) errors.push({ field: 'stationId', message: 'stationId is required' });
  else if (!getStation(input.stationId)) {
    errors.push({ field: 'stationId', message: `unknown station '${input.stationId}'` });
  }
  if (!input?.reasonCode) errors.push({ field: 'reasonCode', message: 'reasonCode is required' });
  else if (!REASON_BY_CODE.has(input.reasonCode)) {
    errors.push({ field: 'reasonCode', message: `unknown reason code '${input.reasonCode}'` });
  }
  if (errors.length) throw new ValidationError('Downtime payload failed validation', errors);

  const reason = REASON_BY_CODE.get(input.reasonCode);
  const station = getStation(input.stationId);
  const at = (input.startedAt ? new Date(input.startedAt) : now).toISOString();

  return {
    id: input.id,
    stationId: input.stationId,
    stationName: station.name,
    lineId: station.lineId,
    reasonCode: input.reasonCode,
    reasonLabel: reason.label,
    category: reason.category,
    bigLoss: reason.bigLoss,
    countsAgainstOee: reason.countsAgainstOee,
    andonId: input.andonId || null,
    note: input.note || null,
    reportedBy: input.reportedBy || 'SYSTEM',
    startedAt: at,
    endedAt: null,
    durationSeconds: null,
    // Filled in when maintenance closes the record.
    repairedBy: null,
    rootCause: null,
    correctiveAction: null,
    updatedAt: at
  };
}

/** Close an open downtime record and freeze its duration. */
function endDowntime(record, context = {}, now = new Date()) {
  if (record.endedAt) {
    throw new StateTransitionError(
      'Downtime', record.id, 'CLOSED', 'CLOSED',
      `Downtime ${record.id} was already closed at ${record.endedAt}`
    );
  }
  const endedAt = context.endedAt ? new Date(context.endedAt) : now;
  const durationSeconds = Math.max(
    0, Math.round((endedAt.getTime() - Date.parse(record.startedAt)) / 1000)
  );

  return {
    ...record,
    endedAt: endedAt.toISOString(),
    durationSeconds,
    repairedBy: context.repairedBy || null,
    rootCause: context.rootCause || null,
    correctiveAction: context.correctiveAction || null,
    updatedAt: endedAt.toISOString()
  };
}

const isOpen = (record) => record.endedAt === null;

/** Elapsed seconds, using the frozen duration once the record is closed. */
function elapsedSeconds(record, now = new Date()) {
  if (record.durationSeconds !== null) return record.durationSeconds;
  return Math.max(0, Math.round((now.getTime() - Date.parse(record.startedAt)) / 1000));
}

/**
 * Reliability metrics over a set of downtime records.
 *
 *   MTBF = operating time / number of failures
 *   MTTR = total repair time / number of failures
 *
 * Only BREAKDOWN-class stops count as failures; a material shortage is not an
 * equipment reliability event and folding it in makes MTBF meaningless.
 */
function reliability(records, operatingSeconds) {
  const failures = records.filter((r) => r.bigLoss === BIG_LOSSES.BREAKDOWN);
  const repairSeconds = failures.reduce((sum, r) => sum + elapsedSeconds(r), 0);

  return {
    failureCount: failures.length,
    operatingHours: Number((operatingSeconds / 3600).toFixed(2)),
    repairHours: Number((repairSeconds / 3600).toFixed(2)),
    mtbfHours: failures.length
      ? Number((operatingSeconds / failures.length / 3600).toFixed(2))
      : null,
    mttrMinutes: failures.length
      ? Number((repairSeconds / failures.length / 60).toFixed(1))
      : null,
    availabilityPct: operatingSeconds + repairSeconds > 0
      ? Number(((operatingSeconds / (operatingSeconds + repairSeconds)) * 100).toFixed(2))
      : null
  };
}

/**
 * Downtime Pareto by reason code, with total minutes lost.
 * Ranked by duration, not by count - a single 90-minute breakdown outranks
 * thirty 30-second jams, and the ranking should say so.
 */
function pareto(records, { limit = 10 } = {}) {
  const totals = new Map();
  for (const record of records) {
    const seconds = elapsedSeconds(record);
    const existing = totals.get(record.reasonCode) || { seconds: 0, count: 0 };
    totals.set(record.reasonCode, { seconds: existing.seconds + seconds, count: existing.count + 1 });
  }

  const grandTotal = [...totals.values()].reduce((s, v) => s + v.seconds, 0) || 1;
  let cumulative = 0;

  return [...totals.entries()]
    .sort((a, b) => b[1].seconds - a[1].seconds)
    .slice(0, limit)
    .map(([code, value]) => {
      cumulative += value.seconds;
      const reason = REASON_BY_CODE.get(code);
      return {
        reasonCode: code,
        label: reason?.label || code,
        category: reason?.category || 'UNKNOWN',
        bigLoss: reason?.bigLoss || null,
        occurrences: value.count,
        minutes: Number((value.seconds / 60).toFixed(1)),
        sharePct: Number(((value.seconds / grandTotal) * 100).toFixed(1)),
        cumulativePct: Number(((cumulative / grandTotal) * 100).toFixed(1))
      };
    });
}

/** Minutes lost, split planned vs unplanned. Feeds the OEE calculation. */
function split(records) {
  const planned = records.filter((r) => r.category === DOWNTIME_CATEGORIES.PLANNED);
  const unplanned = records.filter((r) => r.category === DOWNTIME_CATEGORIES.UNPLANNED);
  const sum = (set) => set.reduce((total, r) => total + elapsedSeconds(r), 0);

  return {
    plannedSeconds: sum(planned),
    unplannedSeconds: sum(unplanned),
    plannedMinutes: Number((sum(planned) / 60).toFixed(1)),
    unplannedMinutes: Number((sum(unplanned) / 60).toFixed(1)),
    plannedCount: planned.length,
    unplannedCount: unplanned.length
  };
}

module.exports = {
  DOWNTIME_CATEGORIES,
  BIG_LOSSES,
  REASON_CODES,
  getReasonCode,
  listReasonCodes,
  createDowntime,
  endDowntime,
  isOpen,
  elapsedSeconds,
  reliability,
  pareto,
  split
};
