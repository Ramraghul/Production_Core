'use strict';

/**
 * Quality: inspection plans, defect taxonomy, and disposition.
 *
 * The defect codes below are the ones that actually get written on a paint
 * shop repair tag or an end-of-line audit sheet. Grouping them by family is
 * what makes a Pareto chart useful - "17 defects today" tells a plant manager
 * nothing; "11 of 17 are DIRT_INCLUSION on PAINT-40" sends someone to check
 * the booth filters.
 */

const { ValidationError, StateTransitionError } = require('./errors');
const { getStation } = require('./plantModel');

const SEVERITIES = Object.freeze({
  CRITICAL: 'CRITICAL', // safety or regulatory - vehicle cannot ship
  MAJOR: 'MAJOR',       // function or appearance - must be repaired
  MINOR: 'MINOR'        // cosmetic - may ship with concession
});

/** Severity ranked for sorting and escalation. Higher blocks harder. */
const SEVERITY_RANK = Object.freeze({ MINOR: 1, MAJOR: 2, CRITICAL: 3 });

const DEFECT_STATES = Object.freeze({
  OPEN: 'OPEN',
  IN_REPAIR: 'IN_REPAIR',
  VERIFIED: 'VERIFIED',
  CLOSED: 'CLOSED'
});

const DEFECT_TRANSITIONS = Object.freeze({
  OPEN: ['IN_REPAIR', 'CLOSED'],
  IN_REPAIR: ['VERIFIED', 'OPEN'],
  VERIFIED: ['CLOSED', 'OPEN'],
  CLOSED: []
});

const DISPOSITIONS = Object.freeze({
  REWORK: 'REWORK',           // fix on-line, unit stays in sequence
  REPAIR: 'REPAIR',           // pull off-line to a repair bay
  SCRAP: 'SCRAP',             // unrecoverable
  USE_AS_IS: 'USE_AS_IS',     // engineering concession
  RETURN_TO_SUPPLIER: 'RETURN_TO_SUPPLIER'
});

/**
 * Defect catalogue, grouped by family.
 * `defaultSeverity` seeds the record; an inspector can escalate but the gate
 * logic always uses the recorded severity, not the default.
 */
const DEFECT_CODES = Object.freeze([
  // Body / weld
  { code: 'WELD_MISSING', family: 'BODY', description: 'Missing spot weld', defaultSeverity: 'CRITICAL', typicalStations: ['BODY-20', 'BODY-30'] },
  { code: 'WELD_BURN_THROUGH', family: 'BODY', description: 'Weld burn-through', defaultSeverity: 'MAJOR', typicalStations: ['BODY-20', 'BODY-30'] },
  { code: 'GAP_FLUSH_OOS', family: 'BODY', description: 'Gap and flush out of specification', defaultSeverity: 'MAJOR', typicalStations: ['BODY-50', 'FINAL-30'] },
  { code: 'PANEL_DENT', family: 'BODY', description: 'Dent or deformation in panel', defaultSeverity: 'MAJOR', typicalStations: ['BODY-40', 'BODY-50'] },
  { code: 'DIM_OUT_OF_TOL', family: 'BODY', description: 'Dimensional check out of tolerance', defaultSeverity: 'CRITICAL', typicalStations: ['BODY-50'] },

  // Paint
  { code: 'ORANGE_PEEL', family: 'PAINT', description: 'Orange peel texture in finish', defaultSeverity: 'MINOR', typicalStations: ['PAINT-50', 'PAINT-60'] },
  { code: 'RUN_SAG', family: 'PAINT', description: 'Paint run or sag', defaultSeverity: 'MAJOR', typicalStations: ['PAINT-40', 'PAINT-50'] },
  { code: 'DIRT_INCLUSION', family: 'PAINT', description: 'Dirt or fibre inclusion in paint film', defaultSeverity: 'MINOR', typicalStations: ['PAINT-40', 'PAINT-50', 'PAINT-60'] },
  { code: 'FISH_EYE', family: 'PAINT', description: 'Fish-eye crater from silicone contamination', defaultSeverity: 'MAJOR', typicalStations: ['PAINT-40'] },
  { code: 'COLOUR_MISMATCH', family: 'PAINT', description: 'Colour outside delta-E tolerance', defaultSeverity: 'MAJOR', typicalStations: ['PAINT-60'] },
  { code: 'THIN_FILM', family: 'PAINT', description: 'Film build below minimum thickness', defaultSeverity: 'MAJOR', typicalStations: ['PAINT-30', 'PAINT-60'] },

  // Assembly / torque
  { code: 'TORQUE_LOW', family: 'ASSEMBLY', description: 'Fastener torque below specification', defaultSeverity: 'CRITICAL', typicalStations: ['CHAS-10', 'CHAS-20', 'FINAL-10', 'FINAL-20'] },
  { code: 'TORQUE_HIGH', family: 'ASSEMBLY', description: 'Fastener torque above specification', defaultSeverity: 'MAJOR', typicalStations: ['CHAS-10', 'CHAS-20', 'FINAL-10', 'FINAL-20'] },
  { code: 'MISSING_FASTENER', family: 'ASSEMBLY', description: 'Fastener not installed', defaultSeverity: 'CRITICAL', typicalStations: ['CHAS-10', 'CHAS-20', 'CHAS-30', 'FINAL-20'] },
  { code: 'HARNESS_UNSEATED', family: 'ASSEMBLY', description: 'Connector not fully seated', defaultSeverity: 'MAJOR', typicalStations: ['TRIM-10', 'TRIM-20', 'DOOR-20'] },
  { code: 'CLIP_BROKEN', family: 'ASSEMBLY', description: 'Retaining clip broken during install', defaultSeverity: 'MINOR', typicalStations: ['TRIM-30', 'DOOR-40'] },
  { code: 'WRONG_PART', family: 'ASSEMBLY', description: 'Incorrect part fitted for this build', defaultSeverity: 'CRITICAL', typicalStations: ['TRIM-20', 'FINAL-10', 'FINAL-30'] },

  // Electrical
  { code: 'DTC_PRESENT', family: 'ELECTRICAL', description: 'Diagnostic trouble code present at EOL scan', defaultSeverity: 'CRITICAL', typicalStations: ['EOL-50'] },
  { code: 'TPMS_NO_SIGNAL', family: 'ELECTRICAL', description: 'TPMS sensor not responding', defaultSeverity: 'MAJOR', typicalStations: ['TIRE-40', 'EOL-50'] },
  { code: 'LAMP_INOP', family: 'ELECTRICAL', description: 'Lamp inoperative', defaultSeverity: 'MAJOR', typicalStations: ['EOL-20', 'EOL-50'] },
  { code: 'MODULE_NO_COMM', family: 'ELECTRICAL', description: 'Control module not communicating on bus', defaultSeverity: 'CRITICAL', typicalStations: ['EOL-50'] },

  // Trim and finish
  { code: 'SCRATCH', family: 'TRIM', description: 'Scratch in trim or paint surface', defaultSeverity: 'MINOR', typicalStations: ['FINAL-30', 'EOL-60'] },
  { code: 'RATTLE_BSR', family: 'TRIM', description: 'Buzz, squeak or rattle detected', defaultSeverity: 'MAJOR', typicalStations: ['EOL-30', 'EOL-60'] },
  { code: 'WATER_LEAK', family: 'TRIM', description: 'Water ingress found in leak test', defaultSeverity: 'CRITICAL', typicalStations: ['EOL-40'] },
  { code: 'TRIM_GAP', family: 'TRIM', description: 'Interior trim gap out of specification', defaultSeverity: 'MINOR', typicalStations: ['TRIM-20', 'EOL-60'] },

  // Functional test
  { code: 'ALIGNMENT_OOS', family: 'FUNCTIONAL', description: 'Wheel alignment out of specification', defaultSeverity: 'MAJOR', typicalStations: ['EOL-10'] },
  { code: 'BRAKE_IMBALANCE', family: 'FUNCTIONAL', description: 'Brake force imbalance beyond limit', defaultSeverity: 'CRITICAL', typicalStations: ['EOL-30'] },
  { code: 'HOT_TEST_FAIL', family: 'FUNCTIONAL', description: 'Powertrain hot test outside limits', defaultSeverity: 'CRITICAL', typicalStations: ['SUB-ENG-20'] },
  { code: 'BALANCE_OOS', family: 'FUNCTIONAL', description: 'Wheel imbalance above limit', defaultSeverity: 'MAJOR', typicalStations: ['TIRE-30', 'TIRE-50'] },
  { code: 'DOOR_EFFORT_HIGH', family: 'FUNCTIONAL', description: 'Door close effort above specification', defaultSeverity: 'MAJOR', typicalStations: ['DOOR-50', 'FINAL-30'] }
]);

const DEFECT_BY_CODE = new Map(DEFECT_CODES.map((d) => [d.code, d]));

/**
 * Inspection plans - the characteristics checked at each gate station.
 * `spec` is a numeric window; a null spec means it is a pass/fail attribute.
 */
const INSPECTION_PLANS = Object.freeze({
  'IP-BIW-CMM': {
    id: 'IP-BIW-CMM', name: 'Body-in-white dimensional check', stationId: 'BODY-50', sampleRate: 1.0,
    characteristics: [
      { id: 'CMM-A-PILLAR', name: 'A-pillar datum deviation', uom: 'mm', nominal: 0, lowerLimit: -0.8, upperLimit: 0.8, defectCode: 'DIM_OUT_OF_TOL' },
      { id: 'CMM-ROCKER', name: 'Rocker panel datum deviation', uom: 'mm', nominal: 0, lowerLimit: -1.0, upperLimit: 1.0, defectCode: 'DIM_OUT_OF_TOL' },
      { id: 'WELD-COUNT', name: 'Spot weld count', uom: 'ea', nominal: 412, lowerLimit: 412, upperLimit: 420, defectCode: 'WELD_MISSING' }
    ]
  },
  'IP-PAINT-VISUAL': {
    id: 'IP-PAINT-VISUAL', name: 'Paint appearance inspection', stationId: 'PAINT-60', sampleRate: 1.0,
    characteristics: [
      { id: 'FILM-BUILD', name: 'Total film build', uom: 'um', nominal: 110, lowerLimit: 95, upperLimit: 135, defectCode: 'THIN_FILM' },
      { id: 'DELTA-E', name: 'Colour delta-E vs master', uom: 'dE', nominal: 0, lowerLimit: 0, upperLimit: 0.8, defectCode: 'COLOUR_MISMATCH' },
      { id: 'ORANGE-PEEL', name: 'Orange peel (wave scan LW)', uom: 'LW', nominal: 8, lowerLimit: 0, upperLimit: 14, defectCode: 'ORANGE_PEEL' }
    ]
  },
  'IP-DOOR-FUNC': {
    id: 'IP-DOOR-FUNC', name: 'Door function test', stationId: 'DOOR-50', sampleRate: 1.0,
    characteristics: [
      { id: 'CLOSE-EFFORT', name: 'Door close effort', uom: 'N', nominal: 32, lowerLimit: 22, upperLimit: 42, defectCode: 'DOOR_EFFORT_HIGH' },
      { id: 'WINDOW-TRAVEL', name: 'Window full travel time', uom: 's', nominal: 3.4, lowerLimit: 2.8, upperLimit: 4.2, defectCode: 'HARNESS_UNSEATED' }
    ]
  },
  'IP-WHEEL-RUNOUT': {
    id: 'IP-WHEEL-RUNOUT', name: 'Wheel runout and balance', stationId: 'TIRE-50', sampleRate: 1.0,
    characteristics: [
      { id: 'RADIAL-RUNOUT', name: 'Radial runout', uom: 'mm', nominal: 0, lowerLimit: 0, upperLimit: 0.7, defectCode: 'BALANCE_OOS' },
      { id: 'RESIDUAL-IMBALANCE', name: 'Residual imbalance', uom: 'g', nominal: 0, lowerLimit: 0, upperLimit: 10, defectCode: 'BALANCE_OOS' }
    ]
  },
  'IP-PT-HOTTEST': {
    id: 'IP-PT-HOTTEST', name: 'Powertrain hot test', stationId: 'SUB-ENG-20', sampleRate: 1.0,
    characteristics: [
      { id: 'PEAK-TORQUE', name: 'Peak torque', uom: 'Nm', nominal: 420, lowerLimit: 395, upperLimit: 445, defectCode: 'HOT_TEST_FAIL' },
      { id: 'OIL-PRESSURE', name: 'Oil / coolant pressure', uom: 'kPa', nominal: 410, lowerLimit: 360, upperLimit: 470, defectCode: 'HOT_TEST_FAIL' },
      { id: 'NVH-LEVEL', name: 'NVH sound level', uom: 'dBA', nominal: 68, lowerLimit: 0, upperLimit: 76, defectCode: 'HOT_TEST_FAIL' }
    ]
  },
  'IP-EOL-ALIGN': {
    id: 'IP-EOL-ALIGN', name: 'Wheel alignment', stationId: 'EOL-10', sampleRate: 1.0,
    characteristics: [
      { id: 'TOE-FRONT', name: 'Front total toe', uom: 'deg', nominal: 0.15, lowerLimit: 0.0, upperLimit: 0.3, defectCode: 'ALIGNMENT_OOS' },
      { id: 'CAMBER-FRONT', name: 'Front camber', uom: 'deg', nominal: -0.5, lowerLimit: -1.1, upperLimit: 0.1, defectCode: 'ALIGNMENT_OOS' },
      { id: 'THRUST-ANGLE', name: 'Thrust angle', uom: 'deg', nominal: 0, lowerLimit: -0.15, upperLimit: 0.15, defectCode: 'ALIGNMENT_OOS' }
    ]
  },
  'IP-EOL-LAMP': {
    id: 'IP-EOL-LAMP', name: 'Headlamp aim', stationId: 'EOL-20', sampleRate: 1.0,
    characteristics: [
      { id: 'AIM-VERTICAL', name: 'Vertical aim', uom: 'pct', nominal: -1.0, lowerLimit: -1.6, upperLimit: -0.4, defectCode: 'LAMP_INOP' }
    ]
  },
  'IP-EOL-ROLL': {
    id: 'IP-EOL-ROLL', name: 'Roll and brake test', stationId: 'EOL-30', sampleRate: 1.0,
    characteristics: [
      { id: 'BRAKE-BALANCE-F', name: 'Front brake force imbalance', uom: 'pct', nominal: 0, lowerLimit: 0, upperLimit: 20, defectCode: 'BRAKE_IMBALANCE' },
      { id: 'SPEEDO-ERROR', name: 'Speedometer error at 50 km/h', uom: 'pct', nominal: 0, lowerLimit: -2, upperLimit: 4, defectCode: 'DTC_PRESENT' }
    ]
  },
  'IP-EOL-WATER': {
    id: 'IP-EOL-WATER', name: 'Water leak test', stationId: 'EOL-40', sampleRate: 1.0,
    characteristics: [
      { id: 'LEAK-DETECTED', name: 'Water ingress detected', uom: 'bool', nominal: 0, lowerLimit: 0, upperLimit: 0, defectCode: 'WATER_LEAK' }
    ]
  },
  'IP-EOL-DTC': {
    id: 'IP-EOL-DTC', name: 'Electrical and DTC scan', stationId: 'EOL-50', sampleRate: 1.0,
    characteristics: [
      { id: 'DTC-COUNT', name: 'Active diagnostic trouble codes', uom: 'ea', nominal: 0, lowerLimit: 0, upperLimit: 0, defectCode: 'DTC_PRESENT' },
      { id: 'MODULE-COUNT', name: 'Modules responding on bus', uom: 'ea', nominal: 34, lowerLimit: 34, upperLimit: 34, defectCode: 'MODULE_NO_COMM' }
    ]
  },
  'IP-EOL-AUDIT': {
    id: 'IP-EOL-AUDIT', name: 'Final vehicle audit', stationId: 'EOL-60', sampleRate: 1.0,
    characteristics: [
      { id: 'AUDIT-DEMERITS', name: 'Audit demerit points', uom: 'pts', nominal: 0, lowerLimit: 0, upperLimit: 25, defectCode: 'SCRATCH' }
    ]
  }
});

const getDefectCode = (code) => DEFECT_BY_CODE.get(code) || null;
const listDefectCodes = (family) =>
  (family ? DEFECT_CODES.filter((d) => d.family === family) : DEFECT_CODES).slice();
const getInspectionPlan = (id) => INSPECTION_PLANS[id] || null;
const planForStation = (stationId) => {
  const planId = getStation(stationId)?.inspectionPlan;
  return planId ? INSPECTION_PLANS[planId] || null : null;
};

/**
 * Evaluate one measured characteristic against its spec window.
 * @returns {{characteristicId, value, inSpec, deviation, defectCode}}
 */
function evaluateCharacteristic(characteristic, value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    throw new ValidationError(
      `Measurement for '${characteristic.id}' must be numeric`,
      { characteristicId: characteristic.id, value }
    );
  }
  const inSpec = numeric >= characteristic.lowerLimit && numeric <= characteristic.upperLimit;
  const deviation = numeric < characteristic.lowerLimit
    ? Number((numeric - characteristic.lowerLimit).toFixed(4))
    : numeric > characteristic.upperLimit
      ? Number((numeric - characteristic.upperLimit).toFixed(4))
      : 0;

  return {
    characteristicId: characteristic.id,
    name: characteristic.name,
    uom: characteristic.uom,
    value: numeric,
    nominal: characteristic.nominal,
    lowerLimit: characteristic.lowerLimit,
    upperLimit: characteristic.upperLimit,
    inSpec,
    deviation,
    defectCode: inSpec ? null : characteristic.defectCode
  };
}

/**
 * Run a full inspection: measure every characteristic in the plan, decide
 * pass/fail, and emit the defect codes that should be raised.
 *
 * @param {string} planId
 * @param {object} measurements  {characteristicId: value}
 * @param {object} context {vin|serial, stationId, inspector}
 */
function runInspection(planId, measurements, context = {}, now = new Date()) {
  const plan = INSPECTION_PLANS[planId];
  if (!plan) throw new ValidationError(`Unknown inspection plan '${planId}'`, { planId });

  const results = plan.characteristics.map((characteristic) => {
    const raw = measurements?.[characteristic.id];
    if (raw === undefined || raw === null) {
      throw new ValidationError(
        `Missing measurement for characteristic '${characteristic.id}' in plan '${planId}'`,
        { planId, characteristicId: characteristic.id }
      );
    }
    return evaluateCharacteristic(characteristic, raw);
  });

  const failures = results.filter((r) => !r.inSpec);

  return {
    planId,
    planName: plan.name,
    stationId: context.stationId || plan.stationId,
    subject: context.vin || context.serial || null,
    subjectType: context.vin ? 'UNIT' : 'SUBASSEMBLY',
    inspector: context.inspector || 'AUTO',
    passed: failures.length === 0,
    results,
    failedCharacteristics: failures.map((f) => f.characteristicId),
    defectCodes: [...new Set(failures.map((f) => f.defectCode).filter(Boolean))],
    inspectedAt: now.toISOString()
  };
}

/**
 * Raise a defect record.
 *
 * @param {object} input
 * @param {string} input.id
 * @param {string} input.code      must exist in DEFECT_CODES
 * @param {string} input.vin
 * @param {string} input.stationId
 * @param {string} [input.severity]  defaults to the code's default severity
 */
function createDefect(input, now = new Date()) {
  const errors = [];
  if (!input?.id) errors.push({ field: 'id', message: 'id is required' });
  if (!input?.code) errors.push({ field: 'code', message: 'code is required' });
  else if (!DEFECT_BY_CODE.has(input.code)) {
    errors.push({ field: 'code', message: `unknown defect code '${input.code}'` });
  }
  if (!input?.vin && !input?.serial) {
    errors.push({ field: 'vin', message: 'either vin or serial is required' });
  }
  if (!input?.stationId) errors.push({ field: 'stationId', message: 'stationId is required' });

  const catalogue = DEFECT_BY_CODE.get(input?.code);
  const severity = input?.severity || catalogue?.defaultSeverity;
  if (severity && !SEVERITIES[severity]) {
    errors.push({ field: 'severity', message: `severity must be one of ${Object.keys(SEVERITIES).join(', ')}` });
  }
  if (errors.length) throw new ValidationError('Defect payload failed validation', errors);

  const timestamp = now.toISOString();
  return {
    id: input.id,
    code: input.code,
    family: catalogue.family,
    description: input.description || catalogue.description,
    severity,
    status: DEFECT_STATES.OPEN,
    vin: input.vin || null,
    serial: input.serial || null,
    stationId: input.stationId,
    lineId: getStation(input.stationId)?.lineId || null,
    detectedBy: input.detectedBy || 'AUTO',
    inspectionId: input.inspectionId || null,
    measurement: input.measurement ?? null,
    disposition: null,
    dispositionedBy: null,
    dispositionNote: null,
    repairMinutes: null,
    // Set when a defect is traced back to a supplier lot.
    suspectLotCode: input.suspectLotCode || null,
    createdAt: timestamp,
    updatedAt: timestamp,
    closedAt: null
  };
}

/** Advance a defect through its repair workflow. */
function transitionDefect(defect, nextState, context = {}, now = new Date()) {
  const allowed = DEFECT_TRANSITIONS[defect.status];
  if (!allowed?.includes(nextState)) {
    throw new StateTransitionError(
      'Defect', defect.id, defect.status, nextState,
      allowed?.length === 0
        ? `Defect ${defect.id} is CLOSED and cannot be reopened`
        : `Defect ${defect.id} cannot move ${defect.status} -> ${nextState}; allowed: ${(allowed || []).join(', ')}`
    );
  }
  const at = now.toISOString();
  return {
    ...defect,
    status: nextState,
    updatedAt: at,
    ...(nextState === DEFECT_STATES.IN_REPAIR
      ? { repairStartedAt: at, repairBay: context.repairBay || null }
      : {}),
    ...(nextState === DEFECT_STATES.CLOSED ? { closedAt: at, closedBy: context.operator || 'SYSTEM' } : {})
  };
}

/**
 * Apply a disposition. This is the decision that costs money, so it is
 * recorded with who made it.
 */
function disposition(defect, decision, context = {}, now = new Date()) {
  if (!DISPOSITIONS[decision]) {
    throw new ValidationError(
      `Disposition must be one of ${Object.keys(DISPOSITIONS).join(', ')}`,
      { decision }
    );
  }
  if (defect.status === DEFECT_STATES.CLOSED) {
    throw new StateTransitionError(
      'Defect', defect.id, defect.status, defect.status,
      `Defect ${defect.id} is already closed`
    );
  }
  if (decision === DISPOSITIONS.USE_AS_IS && defect.severity === SEVERITIES.CRITICAL) {
    throw new ValidationError(
      'A CRITICAL defect cannot be dispositioned USE_AS_IS without an engineering deviation',
      { defectId: defect.id, severity: defect.severity }
    );
  }

  const at = now.toISOString();
  return {
    ...defect,
    disposition: decision,
    dispositionedBy: context.operator || 'SYSTEM',
    dispositionNote: context.note || null,
    repairMinutes: context.repairMinutes ?? defect.repairMinutes,
    status: decision === DISPOSITIONS.USE_AS_IS || decision === DISPOSITIONS.SCRAP
      ? DEFECT_STATES.CLOSED
      : DEFECT_STATES.IN_REPAIR,
    ...(decision === DISPOSITIONS.USE_AS_IS || decision === DISPOSITIONS.SCRAP
      ? { closedAt: at, closedBy: context.operator || 'SYSTEM' }
      : {}),
    updatedAt: at
  };
}

/**
 * Would this set of open defects block a unit at a quality gate?
 * A gate stops CRITICAL always, and MAJOR unless it has been dispositioned.
 */
function blocksGate(openDefects) {
  return openDefects.some((d) =>
    d.severity === SEVERITIES.CRITICAL
    || (d.severity === SEVERITIES.MAJOR && !d.disposition));
}

/** Highest severity in a set, or null when the set is clean. */
function worstSeverity(defects) {
  if (!defects.length) return null;
  return defects.reduce(
    (worst, d) => (SEVERITY_RANK[d.severity] > SEVERITY_RANK[worst] ? d.severity : worst),
    'MINOR'
  );
}

/**
 * Pareto of defect codes, most frequent first. The 80/20 view that actually
 * drives a morning quality meeting.
 */
function pareto(defects, { groupBy = 'code', limit = 10 } = {}) {
  const counts = new Map();
  for (const defect of defects) {
    const key = defect[groupBy] ?? 'UNKNOWN';
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const total = defects.length || 1;
  let cumulative = 0;

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([key, count]) => {
      cumulative += count;
      return {
        key,
        description: groupBy === 'code' ? (DEFECT_BY_CODE.get(key)?.description || key) : key,
        count,
        sharePct: Number(((count / total) * 100).toFixed(1)),
        cumulativePct: Number(((cumulative / total) * 100).toFixed(1))
      };
    });
}

module.exports = {
  SEVERITIES,
  SEVERITY_RANK,
  DEFECT_STATES,
  DEFECT_TRANSITIONS,
  DISPOSITIONS,
  DEFECT_CODES,
  INSPECTION_PLANS,
  getDefectCode,
  listDefectCodes,
  getInspectionPlan,
  planForStation,
  evaluateCharacteristic,
  runInspection,
  createDefect,
  transitionDefect,
  disposition,
  blocksGate,
  worstSeverity,
  pareto
};
