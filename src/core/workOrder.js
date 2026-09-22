'use strict';

/**
 * Work order lifecycle.
 *
 * A work order is the plant's commitment to build N units of one model by a
 * due date. It is the parent of every vehicle unit, and it is what the
 * scheduling side of an MES actually manipulates.
 *
 *   DRAFT -> RELEASED -> IN_PROGRESS -> COMPLETED
 *      |         |            |
 *      +---------+------------+--> CANCELLED
 *                             |
 *                             +--> ON_HOLD -> IN_PROGRESS
 */

const { ValidationError, StateTransitionError } = require('./errors');
const { getModel } = require('./plantModel');

const WORK_ORDER_STATES = Object.freeze({
  DRAFT: 'DRAFT',
  RELEASED: 'RELEASED',
  IN_PROGRESS: 'IN_PROGRESS',
  ON_HOLD: 'ON_HOLD',
  COMPLETED: 'COMPLETED',
  CANCELLED: 'CANCELLED'
});

const PRIORITIES = Object.freeze(['LOW', 'NORMAL', 'HIGH', 'EXPEDITE']);

/** Legal transitions. Anything not listed is rejected with a 409. */
const TRANSITIONS = Object.freeze({
  DRAFT: ['RELEASED', 'CANCELLED'],
  RELEASED: ['IN_PROGRESS', 'ON_HOLD', 'CANCELLED'],
  IN_PROGRESS: ['ON_HOLD', 'COMPLETED', 'CANCELLED'],
  ON_HOLD: ['IN_PROGRESS', 'CANCELLED'],
  COMPLETED: [],
  CANCELLED: []
});

const isTerminal = (state) => TRANSITIONS[state]?.length === 0;

/**
 * Create a work order in DRAFT.
 *
 * @param {object} input
 * @param {string} input.id            e.g. 'WO-2026-0042'
 * @param {string} input.modelCode     must exist in the plant model
 * @param {number} input.quantity      units to build, 1..2000
 * @param {string} [input.colour]
 * @param {string} [input.priority]    one of PRIORITIES
 * @param {string} [input.dueDate]     ISO date
 * @param {string} [input.customerRef]
 * @param {Date}   [now]
 */
function createWorkOrder(input, now = new Date()) {
  const errors = [];

  if (!input || typeof input !== 'object') {
    throw new ValidationError('A work order payload is required');
  }
  if (!input.id) errors.push({ field: 'id', message: 'id is required' });
  if (!input.modelCode) {
    errors.push({ field: 'modelCode', message: 'modelCode is required' });
  } else if (!getModel(input.modelCode)) {
    errors.push({ field: 'modelCode', message: `unknown model '${input.modelCode}'` });
  }

  const quantity = Number(input.quantity);
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 2000) {
    errors.push({ field: 'quantity', message: 'quantity must be an integer in 1..2000' });
  }

  const priority = input.priority || 'NORMAL';
  if (!PRIORITIES.includes(priority)) {
    errors.push({ field: 'priority', message: `priority must be one of ${PRIORITIES.join(', ')}` });
  }

  if (input.dueDate && Number.isNaN(Date.parse(input.dueDate))) {
    errors.push({ field: 'dueDate', message: 'dueDate must be an ISO-8601 date' });
  }

  const model = getModel(input.modelCode);
  if (model && input.colour && !model.colours.includes(input.colour)) {
    errors.push({
      field: 'colour',
      message: `colour must be one of ${model.colours.join(', ')} for ${model.code}`
    });
  }

  if (errors.length) {
    throw new ValidationError('Work order payload failed validation', errors);
  }

  const timestamp = now.toISOString();
  return {
    id: input.id,
    modelCode: input.modelCode,
    modelName: model.name,
    variant: model.variant,
    colour: input.colour || model.colours[0],
    quantity,
    quantityStarted: 0,
    quantityCompleted: 0,
    quantityScrapped: 0,
    priority,
    status: WORK_ORDER_STATES.DRAFT,
    customerRef: input.customerRef || null,
    dueDate: input.dueDate || null,
    notes: input.notes || null,
    createdAt: timestamp,
    updatedAt: timestamp,
    releasedAt: null,
    startedAt: null,
    completedAt: null,
    holdReason: null
  };
}

/**
 * Apply a state transition, returning a NEW work order object.
 * The caller persists the result; nothing here mutates its input.
 *
 * @param {object} workOrder
 * @param {string} nextState
 * @param {object} [context] {reason, at}
 */
function transition(workOrder, nextState, context = {}) {
  const from = workOrder.status;
  const allowed = TRANSITIONS[from];

  if (!allowed) {
    throw new StateTransitionError('WorkOrder', workOrder.id, from, nextState, `Unknown state '${from}'`);
  }
  if (!allowed.includes(nextState)) {
    throw new StateTransitionError(
      'WorkOrder',
      workOrder.id,
      from,
      nextState,
      isTerminal(from)
        ? `Work order ${workOrder.id} is ${from} and can no longer change state`
        : `Work order ${workOrder.id} cannot move ${from} -> ${nextState}; allowed: ${allowed.join(', ')}`
    );
  }

  const at = (context.at || new Date()).toISOString();
  const next = { ...workOrder, status: nextState, updatedAt: at };

  if (nextState === WORK_ORDER_STATES.RELEASED) next.releasedAt = at;
  if (nextState === WORK_ORDER_STATES.IN_PROGRESS && !next.startedAt) next.startedAt = at;
  if (nextState === WORK_ORDER_STATES.COMPLETED) next.completedAt = at;
  if (nextState === WORK_ORDER_STATES.ON_HOLD) {
    next.holdReason = context.reason || 'Unspecified';
  } else {
    next.holdReason = null;
  }
  if (nextState === WORK_ORDER_STATES.CANCELLED) {
    next.notes = context.reason ? `Cancelled: ${context.reason}` : next.notes;
  }

  return next;
}

/** True when every planned unit has been accounted for (built or scrapped). */
function isFulfilled(workOrder) {
  return workOrder.quantityCompleted >= workOrder.quantity;
}

/** Remaining units still to be started. */
function remainingToStart(workOrder) {
  return Math.max(0, workOrder.quantity - workOrder.quantityStarted);
}

/**
 * Progress summary used by the API and the HMI.
 * `yieldPct` is completed / (completed + scrapped), i.e. how much of what the
 * line actually finished was good.
 */
function progress(workOrder) {
  const attempted = workOrder.quantityCompleted + workOrder.quantityScrapped;
  return {
    quantity: workOrder.quantity,
    started: workOrder.quantityStarted,
    completed: workOrder.quantityCompleted,
    scrapped: workOrder.quantityScrapped,
    wip: Math.max(0, workOrder.quantityStarted - attempted),
    remaining: Math.max(0, workOrder.quantity - workOrder.quantityCompleted),
    completionPct: workOrder.quantity
      ? Number(((workOrder.quantityCompleted / workOrder.quantity) * 100).toFixed(1))
      : 0,
    yieldPct: attempted ? Number(((workOrder.quantityCompleted / attempted) * 100).toFixed(2)) : 100
  };
}

/**
 * Schedule risk: is this order going to miss its due date at the current rate?
 * Simple but genuinely useful - it is the question a plant manager asks first.
 */
function scheduleRisk(workOrder, jphActual, now = new Date()) {
  if (!workOrder.dueDate || isTerminal(workOrder.status)) {
    return { atRisk: false, reason: 'No due date or order is closed' };
  }
  const remaining = workOrder.quantity - workOrder.quantityCompleted;
  if (remaining <= 0) return { atRisk: false, reason: 'Quantity already met' };
  if (!jphActual || jphActual <= 0) {
    return { atRisk: true, reason: 'Line is not producing', hoursRequired: null };
  }

  const hoursRequired = remaining / jphActual;
  const hoursAvailable = (Date.parse(workOrder.dueDate) - now.getTime()) / 3600000;

  return {
    atRisk: hoursRequired > hoursAvailable,
    hoursRequired: Number(hoursRequired.toFixed(1)),
    hoursAvailable: Number(hoursAvailable.toFixed(1)),
    shortfallHours: Number(Math.max(0, hoursRequired - hoursAvailable).toFixed(1)),
    reason: hoursRequired > hoursAvailable
      ? `Needs ${hoursRequired.toFixed(1)}h at ${jphActual} JPH but only ${hoursAvailable.toFixed(1)}h remain`
      : 'On track'
  };
}

module.exports = {
  WORK_ORDER_STATES,
  PRIORITIES,
  TRANSITIONS,
  createWorkOrder,
  transition,
  isTerminal,
  isFulfilled,
  remainingToStart,
  progress,
  scheduleRisk
};
