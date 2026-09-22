'use strict';

/**
 * As-built genealogy.
 *
 * For every vehicle we keep the tree of what physically went into it: raw
 * parts with their supplier lot codes, serialised sub-assemblies, and the
 * parts inside those. The tree is append-only - a genealogy record is evidence,
 * and evidence that can be edited is not evidence.
 *
 *   VIN
 *    |- PART  PN-WINDSHIELD      lot AGC-PN-WINDSHIELD-2637A   @ TRIM-30
 *    |- SUB   PWT-26259-000412                                 @ CHAS-10
 *    |   |- PART PN-ENGINE-BLOCK lot NORTHSTAR-PT-...-2636B
 *    |   \- PART PN-ALTERNATOR   lot DENSO-...-2637A
 *    \- SUB   WHS-26259-000410                                 @ FINAL-10
 *        \- PART PN-TIRE-235     lot BRIDGESTONE-...-2635C
 *
 * The query that matters runs the other way: given a suspect lot, which VINs
 * contain it? That is `matchesLot()` plus an index, and it is implemented in
 * services/traceService.js.
 */

const { ValidationError } = require('./errors');

/**
 * Start an empty genealogy record for a VIN.
 * @param {string} vin
 * @param {object} meta {workOrderId, modelCode, builtAtSite}
 */
function createGenealogy(vin, meta = {}, now = new Date()) {
  if (!vin) throw new ValidationError('vin is required to open a genealogy record');
  return {
    vin,
    workOrderId: meta.workOrderId || null,
    modelCode: meta.modelCode || null,
    site: meta.site || null,
    components: [],
    // Denormalised lot index so recall lookups do not walk the tree every time.
    lotIndex: [],
    serialIndex: [],
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    sealedAt: null
  };
}

/**
 * Record a raw part installed directly on the vehicle.
 *
 * @param {object} genealogy
 * @param {object} part {partNumber, description, lotCode, supplier, quantity, safetyCritical}
 * @param {string} stationId where it was fitted
 */
function recordPart(genealogy, part, stationId, now = new Date()) {
  assertNotSealed(genealogy);
  if (!part?.partNumber) throw new ValidationError('partNumber is required', { part });

  const node = {
    type: 'PART',
    partNumber: part.partNumber,
    description: part.description || part.partNumber,
    lotCode: part.lotCode || null,
    supplier: part.supplier || null,
    quantity: part.quantity ?? 1,
    safetyCritical: Boolean(part.safetyCritical),
    installedAt: stationId,
    installedOn: now.toISOString(),
    children: []
  };

  return {
    ...genealogy,
    components: [...genealogy.components, node],
    lotIndex: part.lotCode && !genealogy.lotIndex.includes(part.lotCode)
      ? [...genealogy.lotIndex, part.lotCode]
      : genealogy.lotIndex,
    updatedAt: now.toISOString()
  };
}

/**
 * Record a serialised sub-assembly, folding in its own component list so the
 * vehicle's tree is self-contained. A service technician holding only the VIN
 * can then see the lot code of a part two levels down.
 *
 * @param {object} genealogy
 * @param {object} sub  a sub-assembly document
 * @param {string} stationId
 */
function recordSubAssembly(genealogy, sub, stationId, now = new Date()) {
  assertNotSealed(genealogy);
  if (!sub?.serial) throw new ValidationError('serial is required', { sub });

  const children = (sub.components || []).map((child) => ({
    type: 'PART',
    partNumber: child.partNumber,
    description: child.description || child.partNumber,
    lotCode: child.lotCode || null,
    supplier: child.supplier || null,
    quantity: child.quantity ?? 1,
    safetyCritical: Boolean(child.safetyCritical),
    installedAt: child.installedAt || sub.builtAt,
    installedOn: child.installedOn || now.toISOString(),
    children: []
  }));

  const node = {
    type: 'SUBASSEMBLY',
    serial: sub.serial,
    classCode: sub.classCode,
    description: sub.description,
    builtAt: sub.builtAt,
    builtOnLine: sub.builtOnLine,
    builtOn: sub.completedAt || null,
    testResults: sub.testResults || [],
    installedAt: stationId,
    installedOn: now.toISOString(),
    children
  };

  const newLots = children
    .map((c) => c.lotCode)
    .filter((lot) => lot && !genealogy.lotIndex.includes(lot));

  return {
    ...genealogy,
    components: [...genealogy.components, node],
    lotIndex: newLots.length ? [...genealogy.lotIndex, ...new Set(newLots)] : genealogy.lotIndex,
    serialIndex: genealogy.serialIndex.includes(sub.serial)
      ? genealogy.serialIndex
      : [...genealogy.serialIndex, sub.serial],
    updatedAt: now.toISOString()
  };
}

/**
 * Seal the record at vehicle release. After sealing, nothing can be added -
 * later findings go into a service record, not the as-built genealogy.
 */
function seal(genealogy, now = new Date()) {
  assertNotSealed(genealogy);
  return { ...genealogy, sealedAt: now.toISOString(), updatedAt: now.toISOString() };
}

function assertNotSealed(genealogy) {
  if (genealogy.sealedAt) {
    throw new ValidationError(
      `Genealogy for ${genealogy.vin} was sealed at ${genealogy.sealedAt} and is immutable`,
      { vin: genealogy.vin, sealedAt: genealogy.sealedAt }
    );
  }
}

/** Depth-first flatten of the tree, each row tagged with its depth. */
function flatten(genealogy) {
  const rows = [];
  const walk = (node, level, parent) => {
    rows.push({
      level,
      type: node.type,
      id: node.serial || node.partNumber,
      description: node.description,
      lotCode: node.lotCode || null,
      supplier: node.supplier || null,
      quantity: node.quantity ?? 1,
      safetyCritical: Boolean(node.safetyCritical),
      installedAt: node.installedAt,
      installedOn: node.installedOn,
      parentId: parent || null
    });
    (node.children || []).forEach((child) => walk(child, level + 1, node.serial || node.partNumber));
  };
  (genealogy.components || []).forEach((node) => walk(node, 1, null));
  return rows;
}

/** Does this vehicle contain the given supplier lot? O(1) via the lot index. */
function matchesLot(genealogy, lotCode) {
  return genealogy.lotIndex.includes(lotCode);
}

/** Does this vehicle contain the given sub-assembly serial? */
function containsSerial(genealogy, serial) {
  return genealogy.serialIndex.includes(serial);
}

/** Every distinct part number in the vehicle, across all levels. */
function partNumbers(genealogy) {
  return [...new Set(flatten(genealogy).filter((r) => r.type === 'PART').map((r) => r.id))];
}

/**
 * Where a given part or lot sits in the tree - the answer a recall engineer
 * needs before they can quote a repair time.
 */
function locate(genealogy, { partNumber, lotCode, serial }) {
  return flatten(genealogy).filter((row) => {
    if (partNumber && row.id !== partNumber) return false;
    if (lotCode && row.lotCode !== lotCode) return false;
    if (serial && row.id !== serial) return false;
    return Boolean(partNumber || lotCode || serial);
  });
}

/** Counts for the genealogy summary card in the HMI. */
function stats(genealogy) {
  const rows = flatten(genealogy);
  return {
    vin: genealogy.vin,
    totalNodes: rows.length,
    parts: rows.filter((r) => r.type === 'PART').length,
    subAssemblies: rows.filter((r) => r.type === 'SUBASSEMBLY').length,
    safetyCriticalParts: rows.filter((r) => r.type === 'PART' && r.safetyCritical).length,
    distinctLots: genealogy.lotIndex.length,
    maxDepth: rows.reduce((max, r) => Math.max(max, r.level), 0),
    sealed: Boolean(genealogy.sealedAt)
  };
}

module.exports = {
  createGenealogy,
  recordPart,
  recordSubAssembly,
  seal,
  flatten,
  matchesLot,
  containsSerial,
  partNumbers,
  locate,
  stats
};
