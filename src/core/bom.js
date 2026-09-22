'use strict';

/**
 * Part master and multi-level bill of materials.
 *
 * Two things matter here beyond "a list of parts":
 *
 *  1. `lotControlled` parts carry a supplier lot code on every consumption.
 *     That is the hinge the recall query in traceService.js swings on - without
 *     lot capture at the point of use, a recall degrades into "scrap the month".
 *
 *  2. The BOM is multi-level: a vehicle consumes serialised sub-assemblies,
 *     which in turn consume raw parts. Genealogy therefore forms a tree, not a
 *     flat list, and `explode()` walks it.
 */

const { getStation, ALL_STATIONS, MODELS } = require('./plantModel');
const { NotFoundError } = require('./errors');

/**
 * Part master.
 * `unitCostCad` is in Canadian dollars - this is a Windsor, Ontario plant.
 */
const PARTS = Object.freeze([
  // --- Body shop -----------------------------------------------------------
  { partNumber: 'PN-UB-FLOOR', description: 'Underbody floor pan stamping', uom: 'EA', supplier: 'MAGNA', unitCostCad: 214.5, lotControlled: true, leadTimeDays: 4, safetyCritical: true },
  { partNumber: 'PN-UB-RAIL-L', description: 'Underbody rail, left', uom: 'EA', supplier: 'MAGNA', unitCostCad: 96.2, lotControlled: true, leadTimeDays: 4, safetyCritical: true },
  { partNumber: 'PN-UB-RAIL-R', description: 'Underbody rail, right', uom: 'EA', supplier: 'MAGNA', unitCostCad: 96.2, lotControlled: true, leadTimeDays: 4, safetyCritical: true },
  { partNumber: 'PN-BS-LEFT', description: 'Body side outer, left', uom: 'EA', supplier: 'MARTINREA', unitCostCad: 188.0, lotControlled: true, leadTimeDays: 5 },
  { partNumber: 'PN-BS-RIGHT', description: 'Body side outer, right', uom: 'EA', supplier: 'MARTINREA', unitCostCad: 188.0, lotControlled: true, leadTimeDays: 5 },
  { partNumber: 'PN-ROOF-PANEL', description: 'Roof panel stamping', uom: 'EA', supplier: 'MARTINREA', unitCostCad: 142.75, lotControlled: true, leadTimeDays: 5 },
  { partNumber: 'PN-HOOD', description: 'Hood assembly', uom: 'EA', supplier: 'MAGNA', unitCostCad: 165.4, lotControlled: false, leadTimeDays: 6 },
  { partNumber: 'PN-TAILGATE', description: 'Tailgate / liftgate assembly', uom: 'EA', supplier: 'MAGNA', unitCostCad: 203.9, lotControlled: false, leadTimeDays: 6 },

  // --- Paint shop ----------------------------------------------------------
  { partNumber: 'PN-ECOAT-RESIN', description: 'Cathodic e-coat resin', uom: 'L', supplier: 'AXALTA', unitCostCad: 11.2, lotControlled: true, leadTimeDays: 10 },
  { partNumber: 'PN-SEALER-PVC', description: 'PVC seam sealer', uom: 'KG', supplier: 'HENKEL', unitCostCad: 8.65, lotControlled: true, leadTimeDays: 8 },
  { partNumber: 'PN-PRIMER', description: 'Waterborne primer', uom: 'L', supplier: 'AXALTA', unitCostCad: 17.4, lotControlled: true, leadTimeDays: 10 },
  { partNumber: 'PN-BASECOAT', description: 'Waterborne base coat', uom: 'L', supplier: 'AXALTA', unitCostCad: 34.8, lotControlled: true, leadTimeDays: 12 },
  { partNumber: 'PN-CLEARCOAT', description: '2K clear coat', uom: 'L', supplier: 'PPG', unitCostCad: 29.6, lotControlled: true, leadTimeDays: 12 },

  // --- Door line -----------------------------------------------------------
  { partNumber: 'PN-DR-SHIELD', description: 'Door water shield', uom: 'EA', supplier: 'HENKEL', unitCostCad: 4.15, lotControlled: false, leadTimeDays: 3 },
  { partNumber: 'PN-DR-HARNESS', description: 'Door wiring harness', uom: 'EA', supplier: 'APTIV', unitCostCad: 38.9, lotControlled: true, leadTimeDays: 7, safetyCritical: true },
  { partNumber: 'PN-DR-REGULATOR', description: 'Window regulator with motor', uom: 'EA', supplier: 'BROSE', unitCostCad: 52.3, lotControlled: true, leadTimeDays: 9 },
  { partNumber: 'PN-DR-GLASS', description: 'Door glass, tempered', uom: 'EA', supplier: 'AGC', unitCostCad: 31.75, lotControlled: true, leadTimeDays: 8 },
  { partNumber: 'PN-DR-TRIM', description: 'Door trim panel', uom: 'EA', supplier: 'ADIENT', unitCostCad: 67.4, lotControlled: false, leadTimeDays: 6 },
  { partNumber: 'PN-DR-SPEAKER', description: 'Door speaker, 6.5in', uom: 'EA', supplier: 'HARMAN', unitCostCad: 22.1, lotControlled: false, leadTimeDays: 7 },

  // --- Wheel & tire --------------------------------------------------------
  { partNumber: 'PN-TIRE-235', description: 'Tire 235/55R19 all-season', uom: 'EA', supplier: 'BRIDGESTONE', unitCostCad: 148.0, lotControlled: true, leadTimeDays: 14, safetyCritical: true },
  { partNumber: 'PN-WHEEL-ALLOY', description: 'Alloy wheel 19in', uom: 'EA', supplier: 'SUPERIOR', unitCostCad: 176.5, lotControlled: true, leadTimeDays: 12, safetyCritical: true },
  { partNumber: 'PN-VALVE-STEM', description: 'Valve stem, rubber snap-in', uom: 'EA', supplier: 'SCHRADER', unitCostCad: 1.85, lotControlled: false, leadTimeDays: 5 },
  { partNumber: 'PN-BALANCE-WEIGHT', description: 'Adhesive balance weight', uom: 'G', supplier: 'PERFECT', unitCostCad: 0.09, lotControlled: false, leadTimeDays: 4 },
  { partNumber: 'PN-TPMS-SENSOR', description: 'TPMS sensor 433MHz', uom: 'EA', supplier: 'SCHRADER', unitCostCad: 41.2, lotControlled: true, leadTimeDays: 10, safetyCritical: true },

  // --- Sub-assembly --------------------------------------------------------
  { partNumber: 'PN-ENGINE-BLOCK', description: 'Powertrain core (BEV drive unit / ICE long block)', uom: 'EA', supplier: 'NORTHSTAR-PT', unitCostCad: 4820.0, lotControlled: true, leadTimeDays: 21, safetyCritical: true },
  { partNumber: 'PN-ALTERNATOR', description: 'Alternator / DC-DC converter', uom: 'EA', supplier: 'DENSO', unitCostCad: 228.0, lotControlled: true, leadTimeDays: 15 },
  { partNumber: 'PN-STARTER', description: 'Starter motor / contactor pack', uom: 'EA', supplier: 'DENSO', unitCostCad: 164.0, lotControlled: true, leadTimeDays: 15 },
  { partNumber: 'PN-IP-CARRIER', description: 'Instrument panel carrier', uom: 'EA', supplier: 'FAURECIA', unitCostCad: 312.0, lotControlled: false, leadTimeDays: 9 },
  { partNumber: 'PN-HVAC-MODULE', description: 'HVAC module with blower', uom: 'EA', supplier: 'VALEO', unitCostCad: 398.5, lotControlled: true, leadTimeDays: 13 },
  { partNumber: 'PN-CLUSTER', description: 'Digital instrument cluster 12.3in', uom: 'EA', supplier: 'BOSCH', unitCostCad: 512.0, lotControlled: true, leadTimeDays: 18, safetyCritical: true },
  { partNumber: 'PN-SEAT-FRONT', description: 'Front seat, powered', uom: 'EA', supplier: 'ADIENT', unitCostCad: 640.0, lotControlled: true, leadTimeDays: 8, safetyCritical: true },
  { partNumber: 'PN-SEAT-REAR', description: 'Rear bench seat', uom: 'EA', supplier: 'ADIENT', unitCostCad: 415.0, lotControlled: true, leadTimeDays: 8, safetyCritical: true },
  { partNumber: 'PN-STRUT-FRONT', description: 'Front strut assembly', uom: 'EA', supplier: 'TENNECO', unitCostCad: 158.0, lotControlled: true, leadTimeDays: 11, safetyCritical: true },
  { partNumber: 'PN-HUB-FRONT', description: 'Front wheel hub bearing', uom: 'EA', supplier: 'SKF', unitCostCad: 92.0, lotControlled: true, leadTimeDays: 12, safetyCritical: true },
  { partNumber: 'PN-BRAKE-FRONT', description: 'Front brake caliper and rotor', uom: 'EA', supplier: 'BREMBO', unitCostCad: 287.0, lotControlled: true, leadTimeDays: 14, safetyCritical: true },
  { partNumber: 'PN-STRUT-REAR', description: 'Rear shock absorber', uom: 'EA', supplier: 'TENNECO', unitCostCad: 121.0, lotControlled: true, leadTimeDays: 11, safetyCritical: true },
  { partNumber: 'PN-HUB-REAR', description: 'Rear wheel hub bearing', uom: 'EA', supplier: 'SKF', unitCostCad: 84.0, lotControlled: true, leadTimeDays: 12, safetyCritical: true },
  { partNumber: 'PN-BRAKE-REAR', description: 'Rear brake caliper and rotor', uom: 'EA', supplier: 'BREMBO', unitCostCad: 231.0, lotControlled: true, leadTimeDays: 14, safetyCritical: true },

  // --- Main assembly -------------------------------------------------------
  { partNumber: 'PN-HEADLINER', description: 'Headliner with sunroof cutout', uom: 'EA', supplier: 'MOTUS', unitCostCad: 178.0, lotControlled: false, leadTimeDays: 7 },
  { partNumber: 'PN-BODY-HARNESS', description: 'Main body wiring harness', uom: 'EA', supplier: 'APTIV', unitCostCad: 742.0, lotControlled: true, leadTimeDays: 16, safetyCritical: true },
  { partNumber: 'PN-WINDSHIELD', description: 'Windshield, acoustic laminated', uom: 'EA', supplier: 'AGC', unitCostCad: 396.0, lotControlled: true, leadTimeDays: 10, safetyCritical: true },
  { partNumber: 'PN-BACKLIGHT', description: 'Rear backlight glass', uom: 'EA', supplier: 'AGC', unitCostCad: 214.0, lotControlled: true, leadTimeDays: 10 },
  { partNumber: 'PN-WEATHERSTRIP', description: 'Body weatherstrip set', uom: 'SET', supplier: 'COOPER', unitCostCad: 88.0, lotControlled: false, leadTimeDays: 6 },
  { partNumber: 'PN-EXHAUST', description: 'Exhaust system / underbody shield', uom: 'EA', supplier: 'TENNECO', unitCostCad: 466.0, lotControlled: true, leadTimeDays: 13 },
  { partNumber: 'PN-BRAKE-LINE', description: 'Brake line set', uom: 'SET', supplier: 'SANOH', unitCostCad: 124.0, lotControlled: true, leadTimeDays: 12, safetyCritical: true },
  { partNumber: 'PN-FUEL-LINE', description: 'Fuel / coolant line set', uom: 'SET', supplier: 'SANOH', unitCostCad: 98.0, lotControlled: true, leadTimeDays: 12, safetyCritical: true },
  { partNumber: 'PN-COOLANT', description: 'Extended-life coolant', uom: 'L', supplier: 'SHELL', unitCostCad: 6.4, lotControlled: true, leadTimeDays: 5 },
  { partNumber: 'PN-BRAKE-FLUID', description: 'DOT 4 brake fluid', uom: 'L', supplier: 'SHELL', unitCostCad: 9.8, lotControlled: true, leadTimeDays: 5, safetyCritical: true },
  { partNumber: 'PN-BATTERY-12V', description: '12V AGM auxiliary battery', uom: 'EA', supplier: 'CLARIOS', unitCostCad: 186.0, lotControlled: true, leadTimeDays: 9 }
]);

const PART_BY_NUMBER = new Map(PARTS.map((p) => [p.partNumber, p]));

/**
 * Per-vehicle quantities that differ from the default of 1.
 * Everything not listed here is consumed one-per-vehicle.
 */
const QUANTITY_OVERRIDES = Object.freeze({
  'PN-DR-SHIELD': 4,
  'PN-DR-HARNESS': 4,
  'PN-DR-REGULATOR': 4,
  'PN-DR-GLASS': 4,
  'PN-DR-TRIM': 4,
  'PN-DR-SPEAKER': 4,
  'PN-TIRE-235': 5,          // four fitted plus a spare
  'PN-WHEEL-ALLOY': 5,
  'PN-VALVE-STEM': 5,
  'PN-TPMS-SENSOR': 4,
  'PN-BALANCE-WEIGHT': 120,  // grams
  'PN-SEAT-FRONT': 2,
  'PN-STRUT-FRONT': 2,
  'PN-HUB-FRONT': 2,
  'PN-BRAKE-FRONT': 2,
  'PN-STRUT-REAR': 2,
  'PN-HUB-REAR': 2,
  'PN-BRAKE-REAR': 2,
  'PN-ECOAT-RESIN': 18,      // litres
  'PN-PRIMER': 4,
  'PN-BASECOAT': 5,
  'PN-CLEARCOAT': 4,
  'PN-SEALER-PVC': 3,
  'PN-COOLANT': 9,
  'PN-BRAKE-FLUID': 1.2
});

/** Quantity of `partNumber` consumed per vehicle. */
const quantityPer = (partNumber) => QUANTITY_OVERRIDES[partNumber] ?? 1;

/** Look up a part, throwing a 404-shaped domain error when absent. */
function getPart(partNumber) {
  const part = PART_BY_NUMBER.get(partNumber);
  if (!part) throw new NotFoundError('Part', partNumber);
  return part;
}

const listParts = () => PARTS.slice();
const isLotControlled = (partNumber) => Boolean(PART_BY_NUMBER.get(partNumber)?.lotControlled);
const isSafetyCritical = (partNumber) => Boolean(PART_BY_NUMBER.get(partNumber)?.safetyCritical);

/**
 * Build the BOM for a model by walking the plant model: every station that
 * consumes something contributes a line, tagged with where it is consumed.
 * Deriving the BOM from the routing rather than maintaining it separately is
 * what keeps "what the line does" and "what the system thinks the line does"
 * from drifting apart.
 *
 * @param {string} modelCode
 * @returns {{modelCode:string, revision:string, lines:Array, subAssemblies:Array}}
 */
function bomForModel(modelCode) {
  const model = MODELS.find((m) => m.code === modelCode);
  if (!model) throw new NotFoundError('Model', modelCode);

  const lines = [];
  const subAssemblies = [];

  for (const station of ALL_STATIONS) {
    for (const partNumber of station.consumes) {
      const part = PART_BY_NUMBER.get(partNumber);
      if (!part) continue;
      lines.push({
        partNumber,
        description: part.description,
        uom: part.uom,
        quantityPer: quantityPer(partNumber),
        supplier: part.supplier,
        unitCostCad: part.unitCostCad,
        extendedCostCad: Number((part.unitCostCad * quantityPer(partNumber)).toFixed(2)),
        lotControlled: part.lotControlled,
        safetyCritical: Boolean(part.safetyCritical),
        consumedAt: station.id,
        consumedOnLine: station.lineId,
        level: station.lineId === 'MAINASM' || station.lineId === 'BODY' || station.lineId === 'PAINT' ? 1 : 2
      });
    }
    if (station.producesSerial) {
      subAssemblies.push({
        classCode: station.producesSerial,
        description: station.producesDescription,
        builtAt: station.id,
        builtOnLine: station.lineId,
        installedAt: station.feedsStation || null,
        quantityPer: 1,
        // The raw parts rolled up into this serialised assembly.
        componentParts: ALL_STATIONS
          .filter((s) => s.lineId === station.lineId && (!station.cell || s.cell === station.cell))
          .flatMap((s) => s.consumes)
      });
    }
  }

  const materialCostCad = Number(
    lines.reduce((sum, l) => sum + l.extendedCostCad, 0).toFixed(2)
  );

  return {
    modelCode: model.code,
    modelName: model.name,
    variant: model.variant,
    revision: 'REV-A',
    effectiveFrom: '2026-01-05',
    lineCount: lines.length,
    materialCostCad,
    lines,
    subAssemblies
  };
}

/**
 * Explode a genealogy record into a flat list of every part and sub-assembly
 * that went into one vehicle. Used by the recall query and the /genealogy API.
 *
 * @param {object} genealogy  a genealogy document (see core/genealogy.js)
 * @returns {Array<{level:number, type:string, id:string, ...}>}
 */
function explode(genealogy) {
  const rows = [];
  const walk = (node, level) => {
    rows.push({
      level,
      type: node.type,
      id: node.serial || node.partNumber,
      description: node.description,
      lotCode: node.lotCode || null,
      installedAt: node.installedAt || null,
      installedOn: node.installedOn || null,
      supplier: node.supplier || null,
      safetyCritical: Boolean(node.safetyCritical)
    });
    (node.children || []).forEach((child) => walk(child, level + 1));
  };
  (genealogy.components || []).forEach((component) => walk(component, 1));
  return rows;
}

/** Total material cost of one built vehicle from its genealogy. */
function genealogyCost(genealogy) {
  return Number(
    explode(genealogy)
      .filter((row) => row.type === 'PART')
      .reduce((sum, row) => sum + (PART_BY_NUMBER.get(row.id)?.unitCostCad || 0), 0)
      .toFixed(2)
  );
}

/** Parts consumed at a given station, with per-vehicle quantities resolved. */
function partsConsumedAt(stationId) {
  const station = getStation(stationId);
  if (!station) throw new NotFoundError('Station', stationId);
  return station.consumes.map((partNumber) => {
    const part = PART_BY_NUMBER.get(partNumber);
    return {
      partNumber,
      description: part?.description || partNumber,
      quantity: quantityPer(partNumber),
      uom: part?.uom || 'EA',
      lotControlled: Boolean(part?.lotControlled),
      safetyCritical: Boolean(part?.safetyCritical),
      supplier: part?.supplier || 'UNKNOWN'
    };
  });
}

module.exports = {
  PARTS,
  QUANTITY_OVERRIDES,
  getPart,
  listParts,
  quantityPer,
  isLotControlled,
  isSafetyCritical,
  bomForModel,
  explode,
  genealogyCost,
  partsConsumedAt
};
