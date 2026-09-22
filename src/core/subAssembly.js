'use strict';

/**
 * Serialised sub-assemblies.
 *
 * Feeder lines build modules - a dressed powertrain, a cockpit, a balanced
 * wheel set - and each one gets its own serial number and its own genealogy
 * before it is married into a vehicle. Two properties matter:
 *
 *  - A sub-assembly can be built BROADCAST (pre-assigned to a specific VIN, as
 *    a door line must be, because the doors came off that body) or to STOCK
 *    (pulled from a buffer at the point of use, as a wheel set can be).
 *  - Consumption is one-way and exclusive: once CONSUMED by a VIN, a serial can
 *    never be consumed again. That single constraint is what stops the same
 *    powertrain appearing in two vehicles' service records.
 */

const { ValidationError, StateTransitionError, ConflictError } = require('./errors');
const { getStation, SERIAL_COMPONENTS } = require('./plantModel');

const SUB_STATES = Object.freeze({
  BUILDING: 'BUILDING',
  AVAILABLE: 'AVAILABLE',   // built and tested, waiting in the buffer
  ALLOCATED: 'ALLOCATED',   // reserved for a specific VIN
  CONSUMED: 'CONSUMED',     // installed in a vehicle
  QUARANTINED: 'QUARANTINED',
  SCRAPPED: 'SCRAPPED'
});

const TRANSITIONS = Object.freeze({
  BUILDING: ['AVAILABLE', 'QUARANTINED', 'SCRAPPED'],
  AVAILABLE: ['ALLOCATED', 'CONSUMED', 'QUARANTINED', 'SCRAPPED'],
  ALLOCATED: ['CONSUMED', 'AVAILABLE', 'QUARANTINED', 'SCRAPPED'],
  QUARANTINED: ['AVAILABLE', 'SCRAPPED'],
  CONSUMED: [],
  SCRAPPED: []
});

/** BROADCAST modules are built against a VIN; STOCK modules are pulled freely. */
const BUILD_MODES = Object.freeze({
  BROADCAST: 'BROADCAST',
  STOCK: 'STOCK'
});

/** Which classes must be VIN-matched. Doors physically belong to their body. */
const BROADCAST_CLASSES = Object.freeze(['DRS']);

/**
 * Open a sub-assembly build record.
 *
 * @param {object} input
 * @param {string} input.serial     from ids.buildSerial()
 * @param {string} input.classCode  e.g. 'PWT'
 * @param {string} input.builtAt    station id
 * @param {string} [input.forVin]   required for BROADCAST classes
 */
function createSubAssembly(input, now = new Date()) {
  const errors = [];
  if (!input?.serial) errors.push({ field: 'serial', message: 'serial is required' });
  if (!input?.classCode) errors.push({ field: 'classCode', message: 'classCode is required' });
  else if (!SERIAL_COMPONENTS[input.classCode]) {
    errors.push({ field: 'classCode', message: `unknown component class '${input.classCode}'` });
  }

  const mode = BROADCAST_CLASSES.includes(input?.classCode)
    ? BUILD_MODES.BROADCAST
    : (input?.buildMode || BUILD_MODES.STOCK);

  if (mode === BUILD_MODES.BROADCAST && !input?.forVin) {
    errors.push({
      field: 'forVin',
      message: `class '${input?.classCode}' is broadcast-built and requires forVin`
    });
  }
  if (errors.length) throw new ValidationError('Sub-assembly payload failed validation', errors);

  const spec = SERIAL_COMPONENTS[input.classCode];
  const timestamp = now.toISOString();

  return {
    serial: input.serial,
    classCode: input.classCode,
    description: spec.description,
    buildMode: mode,
    status: SUB_STATES.BUILDING,
    builtOnLine: spec.builtOnLine,
    builtAt: input.builtAt || spec.builtAt,
    installsAt: spec.installedAt,
    forVin: input.forVin || null,
    consumedByVin: null,
    // Raw parts and their supplier lots - this is the child level of genealogy.
    components: [],
    testResults: [],
    quarantineReason: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    completedAt: null,
    consumedAt: null
  };
}

/**
 * Record a part consumption against the sub-assembly.
 * @param {object} sub
 * @param {{partNumber:string, lotCode?:string, quantity?:number, supplier?:string, description?:string, safetyCritical?:boolean}} component
 */
function addComponent(sub, component, now = new Date()) {
  if (sub.status !== SUB_STATES.BUILDING) {
    throw new StateTransitionError(
      'SubAssembly', sub.serial, sub.status, sub.status,
      `Components can only be added while a sub-assembly is BUILDING (is ${sub.status})`
    );
  }
  if (!component?.partNumber) {
    throw new ValidationError('partNumber is required on a component', { component });
  }
  return {
    ...sub,
    components: [
      ...sub.components,
      {
        type: 'PART',
        partNumber: component.partNumber,
        description: component.description || component.partNumber,
        lotCode: component.lotCode || null,
        quantity: component.quantity ?? 1,
        supplier: component.supplier || null,
        safetyCritical: Boolean(component.safetyCritical),
        installedAt: sub.builtAt,
        installedOn: now.toISOString()
      }
    ],
    updatedAt: now.toISOString()
  };
}

/** Attach a functional test result (hot test, runout, door function, ...). */
function addTestResult(sub, result, now = new Date()) {
  return {
    ...sub,
    testResults: [
      ...sub.testResults,
      {
        testId: result.testId,
        stationId: result.stationId || sub.builtAt,
        passed: Boolean(result.passed),
        measurements: result.measurements || {},
        recordedAt: now.toISOString()
      }
    ],
    updatedAt: now.toISOString()
  };
}

/** Finish the build: BUILDING -> AVAILABLE (or ALLOCATED if broadcast-built). */
function completeBuild(sub, now = new Date()) {
  assertTransition(sub, SUB_STATES.AVAILABLE);
  const at = now.toISOString();
  const failed = sub.testResults.filter((t) => !t.passed);
  if (failed.length) {
    return {
      ...sub,
      status: SUB_STATES.QUARANTINED,
      quarantineReason: `Failed ${failed.length} test(s): ${failed.map((t) => t.testId).join(', ')}`,
      completedAt: at,
      updatedAt: at
    };
  }
  return {
    ...sub,
    status: sub.forVin ? SUB_STATES.ALLOCATED : SUB_STATES.AVAILABLE,
    completedAt: at,
    updatedAt: at
  };
}

/** Reserve an available sub-assembly for a specific VIN. */
function allocate(sub, vin, now = new Date()) {
  assertTransition(sub, SUB_STATES.ALLOCATED);
  return { ...sub, status: SUB_STATES.ALLOCATED, forVin: vin, updatedAt: now.toISOString() };
}

/**
 * Install the sub-assembly into a vehicle. Terminal for the serial.
 * @throws {ConflictError} when a broadcast module is fitted to the wrong VIN.
 */
function consume(sub, vin, stationId, now = new Date()) {
  // Checked before the generic transition guard: "quarantined because the hot
  // test failed" tells an operator what to do, where "cannot move QUARANTINED
  // -> CONSUMED" does not. Behind assertTransition this branch is unreachable.
  if (sub.status === SUB_STATES.QUARANTINED) {
    throw new ConflictError(
      `Sub-assembly ${sub.serial} is quarantined and cannot be fitted: ${sub.quarantineReason}`,
      { serial: sub.serial, quarantineReason: sub.quarantineReason }
    );
  }
  if (sub.buildMode === BUILD_MODES.BROADCAST && sub.forVin && sub.forVin !== vin) {
    throw new ConflictError(
      `Sub-assembly ${sub.serial} was broadcast-built for ${sub.forVin} and cannot be fitted to ${vin}`,
      { serial: sub.serial, expectedVin: sub.forVin, attemptedVin: vin }
    );
  }

  assertTransition(sub, SUB_STATES.CONSUMED);

  const at = now.toISOString();
  return {
    ...sub,
    status: SUB_STATES.CONSUMED,
    consumedByVin: vin,
    consumedAtStation: stationId || sub.installsAt,
    consumedAt: at,
    updatedAt: at
  };
}

/** Hold a sub-assembly out of the buffer, e.g. after a supplier lot alert. */
function quarantine(sub, reason, now = new Date()) {
  assertTransition(sub, SUB_STATES.QUARANTINED);
  return {
    ...sub,
    status: SUB_STATES.QUARANTINED,
    quarantineReason: reason || 'Unspecified',
    updatedAt: now.toISOString()
  };
}

function scrapSubAssembly(sub, reason, now = new Date()) {
  assertTransition(sub, SUB_STATES.SCRAPPED);
  return {
    ...sub,
    status: SUB_STATES.SCRAPPED,
    scrapReason: reason || 'Unspecified',
    updatedAt: now.toISOString()
  };
}

function assertTransition(sub, nextState) {
  const allowed = TRANSITIONS[sub.status];
  if (!allowed) {
    throw new StateTransitionError('SubAssembly', sub.serial, sub.status, nextState, `Unknown state '${sub.status}'`);
  }
  if (!allowed.includes(nextState)) {
    throw new StateTransitionError(
      'SubAssembly', sub.serial, sub.status, nextState,
      allowed.length === 0
        ? `Sub-assembly ${sub.serial} is ${sub.status}; no further transitions are possible`
        : `Sub-assembly ${sub.serial} cannot move ${sub.status} -> ${nextState}; allowed: ${allowed.join(', ')}`
    );
  }
}

/** Is this serial available to be fitted right now? */
function isAvailableFor(sub, vin) {
  if (sub.status === SUB_STATES.AVAILABLE) return true;
  return sub.status === SUB_STATES.ALLOCATED && sub.forVin === vin;
}

/** Which station consumes this class, per the plant model. */
function installStationFor(classCode) {
  return SERIAL_COMPONENTS[classCode]?.installedAt || null;
}

/** Sub-assembly classes a given station expects to consume. */
function classesConsumedAt(stationId) {
  return getStation(stationId)?.consumesSerial ?? [];
}

module.exports = {
  SUB_STATES,
  BUILD_MODES,
  BROADCAST_CLASSES,
  TRANSITIONS,
  createSubAssembly,
  addComponent,
  addTestResult,
  completeBuild,
  allocate,
  consume,
  quarantine,
  scrapSubAssembly,
  isAvailableFor,
  installStationFor,
  classesConsumedAt
};
