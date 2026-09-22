'use strict';

/**
 * Station control and maintenance.
 *
 * A station has two independent dimensions, and keeping them separate is the
 * whole design:
 *
 *   state        what the station is physically doing right now
 *                RUNNING, IDLE, STARVED, BLOCKED, DOWN, STOPPED, MAINTENANCE...
 *   control mode who is in charge of it
 *                AUTO         the line drives it (the simulator, a PLC, a flow)
 *                STOPPED      an operator stopped it and it stays stopped
 *                MAINTENANCE  a technician has it, under a maintenance order
 *
 * Anything that is not AUTO is *locked*: automated state changes are refused,
 * so a line controller cannot restart a station that an operator stopped or
 * that has a technician's hands inside it. That is lockout in software - the
 * one rule on a plant floor that nobody gets to bypass by accident.
 *
 *   AUTO ──stop──────────▶ STOPPED ──start──▶ AUTO
 *     │                       │
 *     └──maintenance──┐   maintenance
 *                     ▼       ▼
 *                   MAINTENANCE ──complete──▶ AUTO
 */

const { ValidationError, StateTransitionError } = require('./errors');
const { getStation, CAPABILITIES } = require('./plantModel');

const CONTROL_MODES = Object.freeze({
  AUTO: 'AUTO',
  STOPPED: 'STOPPED',
  MAINTENANCE: 'MAINTENANCE'
});

/** Operator actions, in the order a control panel shows them. */
const ACTIONS = Object.freeze({
  START: 'start',
  STOP: 'stop',
  START_MAINTENANCE: 'maintenance',
  COMPLETE_MAINTENANCE: 'completeMaintenance'
});

const MAINTENANCE_TYPES = Object.freeze({
  PREVENTIVE: {
    code: 'PREVENTIVE',
    label: 'Preventive maintenance',
    // Scheduled in advance, so it comes out of planned busy time rather than
    // counting against availability (ISO 22400).
    reasonCode: 'PREVENTIVE_MAINT',
    planned: true,
    defaultMinutes: 20
  },
  PREDICTIVE: {
    code: 'PREDICTIVE',
    label: 'Predictive maintenance (condition-based)',
    reasonCode: 'PREVENTIVE_MAINT',
    planned: true,
    defaultMinutes: 15
  },
  CORRECTIVE: {
    code: 'CORRECTIVE',
    label: 'Corrective maintenance (repair)',
    // A repair is the tail end of a failure. It counts against availability,
    // and it is a reliability event for MTBF and MTTR.
    reasonCode: 'EQUIP_FAILURE',
    planned: false,
    defaultMinutes: 30
  }
});

/**
 * Control-mode transitions, labelled with the operator action that causes
 * them. availableActions() applies the finer rules (an open andon, a station
 * already down); this table is the shape, and a test holds the two together.
 */
const CONTROL_TRANSITIONS = Object.freeze([
  { from: 'AUTO', to: 'STOPPED', action: 'stop' },
  { from: 'STOPPED', to: 'AUTO', action: 'start' },
  { from: 'AUTO', to: 'MAINTENANCE', action: 'maintenance' },
  { from: 'STOPPED', to: 'MAINTENANCE', action: 'maintenance' },
  { from: 'MAINTENANCE', to: 'AUTO', action: 'completeMaintenance' }
]);

const ORDER_STATES = Object.freeze({
  IN_PROGRESS: 'IN_PROGRESS',
  COMPLETED: 'COMPLETED',
  CANCELLED: 'CANCELLED'
});

/**
 * Preventive-maintenance checklists by what the station physically does.
 * These are the tasks that actually appear on a PM sheet for that kind of
 * equipment, so the checklist a technician ticks off in the HMI is plausible.
 */
const CHECKLISTS = Object.freeze({
  [CAPABILITIES.WELD]: [
    'Dress or replace weld tips',
    'Inspect secondary cables and shunts for wear',
    'Verify cooling-water flow to the gun',
    'Check robot TCP against the calibration fixture',
    'Clean spatter from fixtures and locators'
  ],
  [CAPABILITIES.PAINT]: [
    'Clean and inspect the bell cup',
    'Replace booth intake filters',
    'Verify atomiser speed and shaping air',
    'Purge and flush colour-change valves',
    'Check booth humidity and temperature sensors'
  ],
  [CAPABILITIES.TORQUE]: [
    'Calibrate nutrunner against the torque transducer',
    'Inspect sockets and extensions for wear',
    'Verify the angle encoder reading',
    'Check tool cable and controller connections'
  ],
  [CAPABILITIES.TEST]: [
    'Run the master-part verification cycle',
    'Calibrate sensors against reference standards',
    'Inspect rollers, clamps and fixtures',
    'Back up the test program and results database'
  ],
  [CAPABILITIES.INSPECT]: [
    'Clean camera lenses and light sources',
    'Run the calibration artefact',
    'Verify gauge repeatability (GR&R spot check)',
    'Check lighting intensity against standard'
  ],
  [CAPABILITIES.ASSEMBLE]: [
    'Lubricate the conveyor and carrier guides',
    'Inspect fixtures, locating pins and clamps',
    'Check pneumatic lines for leaks',
    'Verify error-proofing sensors trigger correctly'
  ],
  [CAPABILITIES.KIT]: [
    'Inspect racks and pick-to-light modules',
    'Verify scanner reads against the test label'
  ]
});

// ---------------------------------------------------------------------------
// Control mode
// ---------------------------------------------------------------------------

/** The control block a station state carries. Missing means AUTO. */
function controlOf(stationState) {
  return stationState?.control || { mode: CONTROL_MODES.AUTO };
}

/** True when automated changes to this station must be refused. */
const isLocked = (stationState) => controlOf(stationState).mode !== CONTROL_MODES.AUTO;

/**
 * Which operator actions are legal right now, and why the others are not.
 *
 * The HMI renders its buttons from this, so the control panel and the API can
 * never disagree about what an operator is allowed to do.
 *
 * @param {object} stationState
 * @returns {{allowed: string[], blocked: Object<string,string>}}
 */
function availableActions(stationState) {
  const { mode } = controlOf(stationState);
  const state = stationState?.state;
  const blocked = {};
  const allowed = [];

  const consider = (action, reason) => {
    if (reason) blocked[action] = reason;
    else allowed.push(action);
  };

  // start
  if (mode === CONTROL_MODES.MAINTENANCE) {
    consider(ACTIONS.START, 'Complete the maintenance order first');
  } else if (mode === CONTROL_MODES.STOPPED) {
    consider(ACTIONS.START, null);
  } else if (state === 'DOWN') {
    consider(ACTIONS.START, stationState.openAndonId
      ? `Resolve andon ${stationState.openAndonId} first`
      : null);
  } else {
    consider(ACTIONS.START, `Already in service (${state})`);
  }

  // stop
  if (mode === CONTROL_MODES.MAINTENANCE) {
    consider(ACTIONS.STOP, 'Station is under maintenance');
  } else if (mode === CONTROL_MODES.STOPPED) {
    consider(ACTIONS.STOP, 'Already stopped');
  } else if (state === 'DOWN') {
    consider(ACTIONS.STOP, 'Station is already down on a fault');
  } else {
    consider(ACTIONS.STOP, null);
  }

  // maintenance - legal from AUTO (including DOWN, the usual corrective case)
  // and from an operator stop.
  consider(ACTIONS.START_MAINTENANCE,
    mode === CONTROL_MODES.MAINTENANCE ? 'Maintenance already in progress' : null);

  consider(ACTIONS.COMPLETE_MAINTENANCE,
    mode === CONTROL_MODES.MAINTENANCE ? null : 'No maintenance in progress');

  return { allowed, blocked };
}

/**
 * Throw a 409 explaining why an action is not allowed.
 * @param {object} stationState
 * @param {string} action one of ACTIONS
 */
function assertAction(stationState, action) {
  const { allowed, blocked } = availableActions(stationState);
  if (allowed.includes(action)) return;
  throw new StateTransitionError(
    'Station',
    stationState.stationId,
    `${controlOf(stationState).mode}/${stationState.state}`,
    action,
    `Cannot ${action === ACTIONS.COMPLETE_MAINTENANCE ? 'complete maintenance on' : action} ` +
      `${stationState.stationId}: ${blocked[action]}`
  );
}

/** A control block for a newly entered mode. */
function controlBlock(mode, context = {}, now = new Date()) {
  return {
    mode,
    since: now.toISOString(),
    by: context.operator || 'SYSTEM',
    reason: context.reason || null,
    reasonCode: context.reasonCode || null,
    maintenanceOrderId: context.maintenanceOrderId || null
  };
}

// ---------------------------------------------------------------------------
// Maintenance orders
// ---------------------------------------------------------------------------

/**
 * Open a maintenance order.
 *
 * @param {object} input
 * @param {string} input.id
 * @param {string} input.stationId
 * @param {string} [input.type]           PREVENTIVE | PREDICTIVE | CORRECTIVE
 * @param {string} [input.technician]
 * @param {number} [input.plannedMinutes]
 * @param {string} [input.note]
 * @param {string} [input.downtimeId]     downtime record this order is booked against
 * @param {string} [input.andonId]        andon call it responds to, if any
 */
function createMaintenanceOrder(input, now = new Date()) {
  const errors = [];
  const station = getStation(input?.stationId);
  if (!input?.id) errors.push({ field: 'id', message: 'id is required' });
  if (!input?.stationId) errors.push({ field: 'stationId', message: 'stationId is required' });
  else if (!station) errors.push({ field: 'stationId', message: `unknown station '${input.stationId}'` });

  const typeCode = input?.type || 'PREVENTIVE';
  const type = MAINTENANCE_TYPES[typeCode];
  if (!type) {
    errors.push({
      field: 'type',
      message: `type must be one of ${Object.keys(MAINTENANCE_TYPES).join(', ')}`
    });
  }

  const plannedMinutes = input?.plannedMinutes === undefined
    ? type?.defaultMinutes
    : Number(input.plannedMinutes);
  if (plannedMinutes !== undefined
      && (!Number.isFinite(plannedMinutes) || plannedMinutes < 1 || plannedMinutes > 480)) {
    errors.push({ field: 'plannedMinutes', message: 'plannedMinutes must be between 1 and 480' });
  }

  if (errors.length) throw new ValidationError('Maintenance order failed validation', errors);

  const at = now.toISOString();
  return {
    id: input.id,
    stationId: station.id,
    stationName: station.name,
    lineId: station.lineId,
    type: type.code,
    typeLabel: type.label,
    planned: type.planned,
    status: ORDER_STATES.IN_PROGRESS,
    technician: input.technician || 'UNASSIGNED',
    plannedMinutes,
    note: input.note || null,
    checklist: checklistFor(station).map((task) => ({ task, done: false })),
    downtimeId: input.downtimeId || null,
    andonId: input.andonId || null,
    // Cycles run since the previous service - the evidence for whether this
    // PM was early, on time or overdue.
    cyclesAtStart: input.cyclesSinceMaintenance ?? null,
    startedAt: at,
    completedAt: null,
    actualMinutes: null,
    overrunMinutes: null,
    findings: null,
    partsReplaced: [],
    completedBy: null,
    updatedAt: at
  };
}

/**
 * Sign a maintenance order off.
 *
 * @param {object} order
 * @param {object} [context] {technician, findings, partsReplaced, checklist}
 *   `checklist` is an array of completed task names; anything not listed is
 *   recorded as not done, which is how an audit spots a skipped step.
 */
function completeMaintenanceOrder(order, context = {}, now = new Date()) {
  if (order.status !== ORDER_STATES.IN_PROGRESS) {
    throw new StateTransitionError(
      'MaintenanceOrder', order.id, order.status, ORDER_STATES.COMPLETED,
      `Maintenance order ${order.id} is ${order.status} and cannot be completed`
    );
  }

  const actualMinutes = Number(
    ((now.getTime() - Date.parse(order.startedAt)) / 60000).toFixed(1)
  );

  const done = Array.isArray(context.checklist) ? new Set(context.checklist) : null;
  const checklist = order.checklist.map((item) => ({
    ...item,
    // No list supplied means the technician signed off everything.
    done: done ? done.has(item.task) : true
  }));

  const at = now.toISOString();
  return {
    ...order,
    status: ORDER_STATES.COMPLETED,
    completedAt: at,
    completedBy: context.technician || order.technician,
    actualMinutes,
    overrunMinutes: Number(Math.max(0, actualMinutes - order.plannedMinutes).toFixed(1)),
    findings: context.findings || null,
    partsReplaced: Array.isArray(context.partsReplaced) ? context.partsReplaced : [],
    checklist,
    checklistComplete: checklist.every((item) => item.done),
    updatedAt: at
  };
}

/** The PM checklist for a station, by capability. */
function checklistFor(station) {
  return (CHECKLISTS[station?.capability] || CHECKLISTS[CAPABILITIES.ASSEMBLE]).slice();
}

// ---------------------------------------------------------------------------
// Preventive-maintenance scheduling
// ---------------------------------------------------------------------------

/**
 * Cycles between preventive services.
 *
 * Derived from the station's MTBF: the interval is set at 1.5x the expected
 * cycles between failures. A station that fails every 300 minutes at a
 * 58-second cycle is serviced every ~465 cycles - roughly once a shift - while
 * a sturdy inspection station with a 1400-minute MTBF goes about five shifts.
 */
function pmIntervalCycles(station) {
  const mtbfSeconds = (station.mtbfMinutes || 600) * 60;
  return Math.max(50, Math.round((mtbfSeconds / station.cycleSeconds) * 1.5));
}

/**
 * Where a station stands against its PM interval.
 * @returns {{intervalCycles, cyclesSinceMaintenance, usedPct, remainingCycles, status}}
 *   status is OK, DUE_SOON (>= 80%), DUE (>= 100%) or OVERDUE (>= 120%).
 */
function pmStatus(stationState) {
  const station = getStation(stationState.stationId);
  const intervalCycles = pmIntervalCycles(station);
  const cycles = stationState.cyclesSinceMaintenance ?? 0;
  const usedPct = Number(((cycles / intervalCycles) * 100).toFixed(1));

  let status = 'OK';
  if (usedPct >= 120) status = 'OVERDUE';
  else if (usedPct >= 100) status = 'DUE';
  else if (usedPct >= 80) status = 'DUE_SOON';

  return {
    stationId: station.id,
    stationName: station.name,
    lineId: station.lineId,
    intervalCycles,
    cyclesSinceMaintenance: cycles,
    usedPct,
    remainingCycles: Math.max(0, intervalCycles - cycles),
    status,
    lastMaintenanceAt: stationState.lastMaintenanceAt || null
  };
}

/**
 * How much more likely this station is to fail because its PM is overdue.
 *
 * 1.0 up to the interval, then rising linearly to 3x at double the interval.
 * The simulator applies this to the station's failure hazard, which is what
 * makes skipping maintenance visibly expensive rather than free.
 */
function wearFactor(stationState) {
  const { usedPct } = pmStatus(stationState);
  if (usedPct <= 100) return 1;
  return Math.min(3, 1 + ((usedPct - 100) / 100) * 2);
}

module.exports = {
  CONTROL_MODES,
  ACTIONS,
  MAINTENANCE_TYPES,
  ORDER_STATES,
  CONTROL_TRANSITIONS,
  CHECKLISTS,
  controlOf,
  isLocked,
  availableActions,
  assertAction,
  controlBlock,
  createMaintenanceOrder,
  completeMaintenanceOrder,
  checklistFor,
  pmIntervalCycles,
  pmStatus,
  wearFactor
};
