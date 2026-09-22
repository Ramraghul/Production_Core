'use strict';

/**
 * Andon - the cord an operator pulls when something is wrong.
 *
 * The andon system is the most visible part of a Toyota-style plant, and the
 * metric that matters is not "how many calls" but "how fast did someone come".
 * Response time against an SLA, and escalation when the SLA is blown, are
 * therefore the two things modelled here.
 *
 *   RAISED -> ACKNOWLEDGED -> RESOLVED
 *      |            |
 *      +------------+--> ESCALATED -> ACKNOWLEDGED -> RESOLVED
 *      |
 *      +--> CANCELLED   (pulled by mistake)
 */

const { ValidationError, StateTransitionError } = require('./errors');
const { getStation } = require('./plantModel');

const ANDON_STATES = Object.freeze({
  RAISED: 'RAISED',
  ACKNOWLEDGED: 'ACKNOWLEDGED',
  ESCALATED: 'ESCALATED',
  RESOLVED: 'RESOLVED',
  CANCELLED: 'CANCELLED'
});

const TRANSITIONS = Object.freeze({
  // RAISED -> RESOLVED is legal: someone fixes the problem and clears the cord
  // without ever pressing acknowledge, which happens constantly on a real
  // floor. `resolve()` derives the response time from the resolution in that
  // case, so the call still counts against its SLA rather than vanishing.
  RAISED: ['ACKNOWLEDGED', 'ESCALATED', 'RESOLVED', 'CANCELLED'],
  ACKNOWLEDGED: ['RESOLVED', 'ESCALATED'],
  ESCALATED: ['ACKNOWLEDGED', 'RESOLVED'],
  RESOLVED: [],
  CANCELLED: []
});

/**
 * Call types with their response SLA and whether they stop the line.
 * `stopsLine` distinguishes a yellow pull (call for help, line keeps moving to
 * the end of the station) from a red pull (line stops now).
 */
const CALL_TYPES = Object.freeze({
  MATERIAL: { code: 'MATERIAL', label: 'Material shortage', slaSeconds: 180, stopsLine: false, escalateTo: 'MATERIAL_LEAD', colour: 'amber' },
  QUALITY: { code: 'QUALITY', label: 'Quality concern', slaSeconds: 120, stopsLine: true, escalateTo: 'QUALITY_ENGINEER', colour: 'amber' },
  MAINTENANCE: { code: 'MAINTENANCE', label: 'Equipment fault', slaSeconds: 150, stopsLine: true, escalateTo: 'MAINTENANCE_LEAD', colour: 'red' },
  SAFETY: { code: 'SAFETY', label: 'Safety incident', slaSeconds: 30, stopsLine: true, escalateTo: 'PLANT_MANAGER', colour: 'red' },
  PROCESS: { code: 'PROCESS', label: 'Process deviation', slaSeconds: 240, stopsLine: false, escalateTo: 'PROCESS_ENGINEER', colour: 'blue' },
  TOOLING: { code: 'TOOLING', label: 'Tooling change required', slaSeconds: 300, stopsLine: false, escalateTo: 'TOOLING_TECH', colour: 'blue' }
});

/** Escalation ladder. Tier 1 is the team leader on the floor. */
const ESCALATION_TIERS = Object.freeze([
  { tier: 1, role: 'TEAM_LEADER', afterSeconds: 0 },
  { tier: 2, role: 'AREA_SUPERVISOR', afterSeconds: 300 },
  { tier: 3, role: 'PLANT_MANAGER', afterSeconds: 900 }
]);

/**
 * Raise an andon call.
 *
 * @param {object} input
 * @param {string} input.id
 * @param {string} input.stationId
 * @param {string} input.callType   key of CALL_TYPES
 * @param {string} [input.raisedBy]
 * @param {string} [input.vin]      unit at the station when the cord was pulled
 * @param {string} [input.note]
 */
function createAndon(input, now = new Date()) {
  const errors = [];
  if (!input?.id) errors.push({ field: 'id', message: 'id is required' });
  if (!input?.stationId) errors.push({ field: 'stationId', message: 'stationId is required' });
  else if (!getStation(input.stationId)) {
    errors.push({ field: 'stationId', message: `unknown station '${input.stationId}'` });
  }
  if (!input?.callType) errors.push({ field: 'callType', message: 'callType is required' });
  else if (!CALL_TYPES[input.callType]) {
    errors.push({
      field: 'callType',
      message: `callType must be one of ${Object.keys(CALL_TYPES).join(', ')}`
    });
  }
  if (errors.length) throw new ValidationError('Andon payload failed validation', errors);

  const spec = CALL_TYPES[input.callType];
  const station = getStation(input.stationId);
  const at = now.toISOString();

  return {
    id: input.id,
    stationId: input.stationId,
    stationName: station.name,
    lineId: station.lineId,
    callType: input.callType,
    label: spec.label,
    colour: spec.colour,
    stopsLine: spec.stopsLine,
    slaSeconds: spec.slaSeconds,
    status: ANDON_STATES.RAISED,
    escalationTier: 1,
    vin: input.vin || null,
    raisedBy: input.raisedBy || 'OPERATOR',
    note: input.note || null,
    raisedAt: at,
    acknowledgedAt: null,
    acknowledgedBy: null,
    escalatedAt: null,
    resolvedAt: null,
    resolvedBy: null,
    resolution: null,
    responseSeconds: null,
    resolutionSeconds: null,
    slaMet: null,
    // Set when the call is linked to a downtime record.
    downtimeId: null,
    updatedAt: at
  };
}

/** Someone responded. This is the moment the response-time clock stops. */
function acknowledge(andon, responder, now = new Date()) {
  assertTransition(andon, ANDON_STATES.ACKNOWLEDGED);
  const at = now.toISOString();
  const responseSeconds = Math.round((now.getTime() - Date.parse(andon.raisedAt)) / 1000);
  return {
    ...andon,
    status: ANDON_STATES.ACKNOWLEDGED,
    acknowledgedAt: at,
    acknowledgedBy: responder || 'UNKNOWN',
    responseSeconds,
    slaMet: responseSeconds <= andon.slaSeconds,
    updatedAt: at
  };
}

/** Nobody came in time - push it up the ladder. */
function escalate(andon, now = new Date()) {
  assertTransition(andon, ANDON_STATES.ESCALATED);
  const elapsed = Math.round((now.getTime() - Date.parse(andon.raisedAt)) / 1000);
  const tier = ESCALATION_TIERS
    .filter((t) => elapsed >= t.afterSeconds)
    .reduce((highest, t) => (t.tier > highest.tier ? t : highest), ESCALATION_TIERS[0]);

  const at = now.toISOString();
  return {
    ...andon,
    status: ANDON_STATES.ESCALATED,
    escalationTier: Math.max(andon.escalationTier, tier.tier),
    escalatedTo: tier.role,
    escalatedAt: at,
    slaMet: false,
    updatedAt: at
  };
}

/** Problem fixed, line moves. */
function resolve(andon, resolution, resolver, now = new Date()) {
  assertTransition(andon, ANDON_STATES.RESOLVED);
  const at = now.toISOString();
  const resolutionSeconds = Math.round((now.getTime() - Date.parse(andon.raisedAt)) / 1000);
  return {
    ...andon,
    status: ANDON_STATES.RESOLVED,
    resolvedAt: at,
    resolvedBy: resolver || 'UNKNOWN',
    resolution: resolution || null,
    resolutionSeconds,
    // A call resolved without ever being acknowledged still has a response time.
    responseSeconds: andon.responseSeconds ?? resolutionSeconds,
    slaMet: andon.slaMet ?? (resolutionSeconds <= andon.slaSeconds),
    updatedAt: at
  };
}

function cancel(andon, reason, now = new Date()) {
  assertTransition(andon, ANDON_STATES.CANCELLED);
  const at = now.toISOString();
  return {
    ...andon,
    status: ANDON_STATES.CANCELLED,
    resolution: reason || 'Cancelled',
    cancelledAt: at,
    updatedAt: at
  };
}

function assertTransition(andon, nextState) {
  const allowed = TRANSITIONS[andon.status];
  if (!allowed?.includes(nextState)) {
    throw new StateTransitionError(
      'Andon', andon.id, andon.status, nextState,
      allowed?.length === 0
        ? `Andon ${andon.id} is ${andon.status} and is closed`
        : `Andon ${andon.id} cannot move ${andon.status} -> ${nextState}; allowed: ${(allowed || []).join(', ')}`
    );
  }
}

const isOpen = (andon) =>
  andon.status === ANDON_STATES.RAISED
  || andon.status === ANDON_STATES.ACKNOWLEDGED
  || andon.status === ANDON_STATES.ESCALATED;

/** Seconds a call has been outstanding. Drives the escalation sweep. */
function ageSeconds(andon, now = new Date()) {
  if (!isOpen(andon)) return 0;
  return Math.round((now.getTime() - Date.parse(andon.raisedAt)) / 1000);
}

/** Should this call be escalated right now? */
function shouldEscalate(andon, now = new Date()) {
  if (andon.status !== ANDON_STATES.RAISED) return false;
  return ageSeconds(andon, now) > andon.slaSeconds;
}

/**
 * Andon performance summary: call volume, response time, SLA attainment and
 * total line-stop minutes. This is the andon board a supervisor watches.
 */
function summarise(andons) {
  const closed = andons.filter((a) => a.status === ANDON_STATES.RESOLVED);
  const responded = closed.filter((a) => a.responseSeconds !== null);
  const met = responded.filter((a) => a.slaMet);
  const lineStopSeconds = closed
    .filter((a) => a.stopsLine)
    .reduce((sum, a) => sum + (a.resolutionSeconds || 0), 0);

  const byType = Object.keys(CALL_TYPES).reduce((acc, type) => {
    const subset = andons.filter((a) => a.callType === type);
    if (subset.length) acc[type] = subset.length;
    return acc;
  }, {});

  return {
    total: andons.length,
    open: andons.filter(isOpen).length,
    escalated: andons.filter((a) => a.status === ANDON_STATES.ESCALATED).length,
    resolved: closed.length,
    avgResponseSeconds: responded.length
      ? Math.round(responded.reduce((s, a) => s + a.responseSeconds, 0) / responded.length)
      : null,
    maxResponseSeconds: responded.length
      ? Math.max(...responded.map((a) => a.responseSeconds))
      : null,
    avgResolutionSeconds: closed.length
      ? Math.round(closed.reduce((s, a) => s + (a.resolutionSeconds || 0), 0) / closed.length)
      : null,
    slaAttainmentPct: responded.length
      ? Number(((met.length / responded.length) * 100).toFixed(1))
      : null,
    lineStopMinutes: Number((lineStopSeconds / 60).toFixed(1)),
    byType
  };
}

module.exports = {
  ANDON_STATES,
  CALL_TYPES,
  ESCALATION_TIERS,
  TRANSITIONS,
  createAndon,
  acknowledge,
  escalate,
  resolve,
  cancel,
  isOpen,
  ageSeconds,
  shouldEscalate,
  summarise
};
