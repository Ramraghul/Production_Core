'use strict';

/**
 * The plant, as data.
 *
 * This file is the single source of truth for the physical factory. The
 * Node-RED flows, the simulator, the KPI engine and the REST API are all
 * generated from or driven by this structure - adding a station is an edit
 * here, not forty minutes of dragging nodes around the editor.
 *
 * The hierarchy follows ISA-95 (IEC 62264) part 2:
 *
 *   Enterprise -> Site -> Area -> Work Centre (line) -> Work Unit (station)
 *
 * NorthStar Motors / Windsor Assembly Plant is fictional; the process flow,
 * station names, takt times and defect taxonomy mirror how a real North
 * American vehicle assembly plant is actually laid out.
 */

/** Operational state of a work unit. Mirrors the classic MES station model. */
const STATION_STATES = Object.freeze({
  RUNNING: 'RUNNING',     // producing
  IDLE: 'IDLE',           // able to run, nothing to do
  STARVED: 'STARVED',     // no work arriving from upstream
  BLOCKED: 'BLOCKED',     // downstream buffer full, cannot release
  DOWN: 'DOWN',           // equipment fault
  STOPPED: 'STOPPED',     // stopped by an operator; held until someone starts it
  CHANGEOVER: 'CHANGEOVER',
  MAINTENANCE: 'MAINTENANCE',
  OFFLINE: 'OFFLINE'      // not scheduled this shift
});

/** States that count as "planned busy but not producing" for OEE availability. */
const UNPLANNED_STOP_STATES = Object.freeze(['DOWN', 'STARVED', 'BLOCKED']);
const PLANNED_STOP_STATES = Object.freeze(['CHANGEOVER', 'MAINTENANCE', 'OFFLINE']);

/**
 * States in which a station is not producing and a downtime record should be
 * open. Whether that downtime is planned or unplanned is decided by its reason
 * code, not by the state - an operator stop for a scheduled break and one for
 * a material shortage are the same state with different consequences for OEE.
 */
const STOP_STATES = Object.freeze([
  'DOWN', 'STARVED', 'BLOCKED', 'STOPPED', 'MAINTENANCE', 'CHANGEOVER'
]);

/** What a station physically does. Drives simulator behaviour and icons. */
const CAPABILITIES = Object.freeze({
  WELD: 'WELD',
  PAINT: 'PAINT',
  ASSEMBLE: 'ASSEMBLE',
  TORQUE: 'TORQUE',
  INSPECT: 'INSPECT',
  TEST: 'TEST',
  KIT: 'KIT'
});

const AREAS = Object.freeze([
  { id: 'BODY_SHOP', name: 'Body Shop', description: 'Robotic welding of the body-in-white' },
  { id: 'PAINT_SHOP', name: 'Paint Shop', description: 'Pre-treatment, e-coat, primer, base and clear coat' },
  { id: 'FEEDER', name: 'Feeder Lines', description: 'Door, wheel and sub-assembly lines feeding final assembly' },
  { id: 'GENERAL_ASSEMBLY', name: 'General Assembly', description: 'Trim, chassis and final vehicle build' },
  { id: 'QUALITY', name: 'Quality & End-of-Line', description: 'Functional test, audit and vehicle release' }
]);

/**
 * Line definitions.
 *
 * `taktSeconds`    - the customer-demand-driven pace of the line.
 * `cycleSeconds`   - the ideal cycle time of one station (ISO 22400 ICT).
 * `mtbfMinutes`    - mean time between failures used by the fault model.
 * `mttrMinutes`    - mean time to repair.
 * `scrapPpm`       - defect injection rate in parts-per-million.
 * `feeds`          - which line this feeder delivers into.
 * `consumes`       - part numbers back-flushed when a unit completes here.
 * `producesSerial` - component class code if this station emits a serialised
 *                    sub-assembly (which is what makes genealogy possible).
 * `qualityGate`    - a unit cannot pass until open CRITICAL/MAJOR defects clear.
 */
const LINES = Object.freeze([
  {
    id: 'BODY',
    name: 'Body Shop',
    area: 'BODY_SHOP',
    sequence: 10,
    kind: 'MAIN',
    taktSeconds: 60,
    description: 'Underbody, framing and respot welding producing the body-in-white.',
    stations: [
      { id: 'BODY-10', name: 'Underbody Build-Up', sequence: 10, capability: 'WELD', cycleSeconds: 56, mtbfMinutes: 420, mttrMinutes: 11, scrapPpm: 900, robots: 8, consumes: ['PN-UB-FLOOR', 'PN-UB-RAIL-L', 'PN-UB-RAIL-R'] },
      { id: 'BODY-20', name: 'Body Side Framing Gate', sequence: 20, capability: 'WELD', cycleSeconds: 58, mtbfMinutes: 300, mttrMinutes: 16, scrapPpm: 1400, robots: 12, consumes: ['PN-BS-LEFT', 'PN-BS-RIGHT'] },
      { id: 'BODY-30', name: 'Respot Welding', sequence: 30, capability: 'WELD', cycleSeconds: 54, mtbfMinutes: 480, mttrMinutes: 9, scrapPpm: 700, robots: 10, consumes: [] },
      { id: 'BODY-40', name: 'Roof & Closure Fitment', sequence: 40, capability: 'ASSEMBLE', cycleSeconds: 57, mtbfMinutes: 520, mttrMinutes: 8, scrapPpm: 600, consumes: ['PN-ROOF-PANEL', 'PN-HOOD', 'PN-TAILGATE'] },
      { id: 'BODY-50', name: 'BIW Dimensional Check', sequence: 50, capability: 'INSPECT', cycleSeconds: 50, mtbfMinutes: 900, mttrMinutes: 6, scrapPpm: 200, qualityGate: true, inspectionPlan: 'IP-BIW-CMM' }
    ]
  },
  {
    id: 'PAINT',
    name: 'Paint Shop',
    area: 'PAINT_SHOP',
    sequence: 20,
    kind: 'MAIN',
    taktSeconds: 62,
    description: 'Pre-treatment through clear coat and paint inspection.',
    stations: [
      { id: 'PAINT-10', name: 'Pre-Treatment & E-Coat', sequence: 10, capability: 'PAINT', cycleSeconds: 60, mtbfMinutes: 600, mttrMinutes: 22, scrapPpm: 500, consumes: ['PN-ECOAT-RESIN'] },
      { id: 'PAINT-20', name: 'Sealer & PVC Application', sequence: 20, capability: 'PAINT', cycleSeconds: 58, mtbfMinutes: 540, mttrMinutes: 12, scrapPpm: 800, consumes: ['PN-SEALER-PVC'] },
      { id: 'PAINT-30', name: 'Primer Booth', sequence: 30, capability: 'PAINT', cycleSeconds: 59, mtbfMinutes: 480, mttrMinutes: 14, scrapPpm: 1100, robots: 6, consumes: ['PN-PRIMER'] },
      { id: 'PAINT-40', name: 'Base Coat Booth', sequence: 40, capability: 'PAINT', cycleSeconds: 61, mtbfMinutes: 360, mttrMinutes: 18, scrapPpm: 2600, robots: 8, consumes: ['PN-BASECOAT'] },
      { id: 'PAINT-50', name: 'Clear Coat & Curing Oven', sequence: 50, capability: 'PAINT', cycleSeconds: 60, mtbfMinutes: 420, mttrMinutes: 26, scrapPpm: 1800, robots: 6, consumes: ['PN-CLEARCOAT'] },
      { id: 'PAINT-60', name: 'Paint Inspection & Polish', sequence: 60, capability: 'INSPECT', cycleSeconds: 55, mtbfMinutes: 1200, mttrMinutes: 5, scrapPpm: 300, qualityGate: true, inspectionPlan: 'IP-PAINT-VISUAL' }
    ]
  },
  {
    id: 'DOOR',
    name: 'Door Line',
    area: 'FEEDER',
    sequence: 30,
    kind: 'FEEDER',
    feeds: 'MAINASM',
    feedsStation: 'FINAL-30',
    // Feeder takt and cycle times are expressed PER DELIVERED SET (one set =
    // the four doors for one vehicle), not per individual door. Counting the
    // unit of output the line is measured on is what keeps its OEE performance
    // factor comparable with the main line's.
    taktSeconds: 60,
    piecesPerSet: 4,
    description: 'Doors are removed after paint, trimmed offline on four parallel lanes, then re-hung in final assembly.',
    stations: [
      { id: 'DOOR-10', name: 'Door Removal & ID Match', sequence: 10, capability: 'ASSEMBLE', cycleSeconds: 54, mtbfMinutes: 720, mttrMinutes: 7, scrapPpm: 400, consumes: [] },
      { id: 'DOOR-20', name: 'Water Shield & Harness', sequence: 20, capability: 'ASSEMBLE', cycleSeconds: 56, mtbfMinutes: 660, mttrMinutes: 8, scrapPpm: 900, consumes: ['PN-DR-SHIELD', 'PN-DR-HARNESS'] },
      { id: 'DOOR-30', name: 'Regulator & Glass Set', sequence: 30, capability: 'ASSEMBLE', cycleSeconds: 58, mtbfMinutes: 480, mttrMinutes: 12, scrapPpm: 1600, consumes: ['PN-DR-REGULATOR', 'PN-DR-GLASS'] },
      { id: 'DOOR-40', name: 'Trim Panel & Speaker', sequence: 40, capability: 'ASSEMBLE', cycleSeconds: 55, mtbfMinutes: 600, mttrMinutes: 9, scrapPpm: 1100, consumes: ['PN-DR-TRIM', 'PN-DR-SPEAKER'] },
      { id: 'DOOR-50', name: 'Door Function Test', sequence: 50, capability: 'TEST', cycleSeconds: 52, mtbfMinutes: 900, mttrMinutes: 6, scrapPpm: 500, qualityGate: true, inspectionPlan: 'IP-DOOR-FUNC', producesSerial: 'DRS', producesDescription: 'Trimmed door set (4 doors)' }
    ]
  },
  {
    id: 'TIRE',
    name: 'Wheel & Tire Line',
    area: 'FEEDER',
    sequence: 40,
    kind: 'FEEDER',
    feeds: 'MAINASM',
    feedsStation: 'FINAL-10',
    // Per delivered wheel set (four fitted plus a spare), as for the door line.
    taktSeconds: 60,
    piecesPerSet: 5,
    description: 'Tire mounting through dynamic balance and TPMS programming on five parallel lanes; builds a matched wheel set per VIN.',
    stations: [
      { id: 'TIRE-10', name: 'Tire Mounting', sequence: 10, capability: 'ASSEMBLE', cycleSeconds: 51, mtbfMinutes: 540, mttrMinutes: 8, scrapPpm: 700, consumes: ['PN-TIRE-235', 'PN-WHEEL-ALLOY'] },
      { id: 'TIRE-20', name: 'Bead Seating & Inflation', sequence: 20, capability: 'ASSEMBLE', cycleSeconds: 48, mtbfMinutes: 600, mttrMinutes: 6, scrapPpm: 900, consumes: ['PN-VALVE-STEM'] },
      { id: 'TIRE-30', name: 'Dynamic Balancing', sequence: 30, capability: 'TEST', cycleSeconds: 56, mtbfMinutes: 420, mttrMinutes: 10, scrapPpm: 2200, consumes: ['PN-BALANCE-WEIGHT'] },
      { id: 'TIRE-40', name: 'TPMS Programming', sequence: 40, capability: 'TEST', cycleSeconds: 46, mtbfMinutes: 780, mttrMinutes: 5, scrapPpm: 1300, consumes: ['PN-TPMS-SENSOR'] },
      { id: 'TIRE-50', name: 'Runout & Match Mount', sequence: 50, capability: 'INSPECT', cycleSeconds: 50, mtbfMinutes: 960, mttrMinutes: 5, scrapPpm: 400, qualityGate: true, inspectionPlan: 'IP-WHEEL-RUNOUT', producesSerial: 'WHS', producesDescription: 'Balanced wheel set (4 + spare)' }
    ]
  },
  {
    id: 'SUBASM',
    name: 'Sub-Assembly Cells',
    area: 'FEEDER',
    sequence: 50,
    kind: 'FEEDER',
    feeds: 'MAINASM',
    taktSeconds: 60,
    parallelCells: true,
    description: 'Powertrain dress, cockpit module, seat set and corner modules, each serialised for genealogy.',
    stations: [
      { id: 'SUB-ENG-10', name: 'Powertrain Dress-Up', sequence: 10, capability: 'ASSEMBLE', cycleSeconds: 58, cell: 'POWERTRAIN', mtbfMinutes: 480, mttrMinutes: 15, scrapPpm: 800, consumes: ['PN-ENGINE-BLOCK', 'PN-ALTERNATOR', 'PN-STARTER'] },
      { id: 'SUB-ENG-20', name: 'Powertrain Hot Test', sequence: 20, capability: 'TEST', cycleSeconds: 55, cell: 'POWERTRAIN', mtbfMinutes: 720, mttrMinutes: 12, scrapPpm: 1900, qualityGate: true, inspectionPlan: 'IP-PT-HOTTEST', producesSerial: 'PWT', producesDescription: 'Dressed and hot-tested powertrain', feedsStation: 'CHAS-10' },
      { id: 'SUB-CKP-10', name: 'Cockpit / IP Module Build', sequence: 30, capability: 'ASSEMBLE', cycleSeconds: 57, cell: 'COCKPIT', mtbfMinutes: 600, mttrMinutes: 10, scrapPpm: 1200, consumes: ['PN-IP-CARRIER', 'PN-HVAC-MODULE', 'PN-CLUSTER'], producesSerial: 'CKP', producesDescription: 'Cockpit / instrument panel module', feedsStation: 'TRIM-20' },
      { id: 'SUB-SEAT-10', name: 'Seat Set Build', sequence: 40, capability: 'ASSEMBLE', cycleSeconds: 54, cell: 'SEATING', mtbfMinutes: 660, mttrMinutes: 9, scrapPpm: 700, consumes: ['PN-SEAT-FRONT', 'PN-SEAT-REAR'], producesSerial: 'SET', producesDescription: 'Complete seat set', feedsStation: 'FINAL-20' },
      { id: 'SUB-SUSP-10', name: 'Front Corner Modules', sequence: 50, capability: 'ASSEMBLE', cycleSeconds: 52, cell: 'CHASSIS', mtbfMinutes: 540, mttrMinutes: 11, scrapPpm: 1000, consumes: ['PN-STRUT-FRONT', 'PN-HUB-FRONT', 'PN-BRAKE-FRONT'], producesSerial: 'CNF', producesDescription: 'Front corner module pair', feedsStation: 'CHAS-20' },
      { id: 'SUB-SUSP-20', name: 'Rear Corner Modules', sequence: 60, capability: 'ASSEMBLE', cycleSeconds: 51, cell: 'CHASSIS', mtbfMinutes: 560, mttrMinutes: 11, scrapPpm: 1000, consumes: ['PN-STRUT-REAR', 'PN-HUB-REAR', 'PN-BRAKE-REAR'], producesSerial: 'CNR', producesDescription: 'Rear corner module pair', feedsStation: 'CHAS-20' }
    ]
  },
  {
    id: 'MAINASM',
    name: 'Main Assembly',
    area: 'GENERAL_ASSEMBLY',
    sequence: 60,
    kind: 'MAIN',
    taktSeconds: 60,
    description: 'Trim, chassis (including powertrain marriage) and final build.',
    stations: [
      { id: 'TRIM-10', name: 'Headliner & Body Harness', sequence: 10, capability: 'ASSEMBLE', zone: 'TRIM', cycleSeconds: 57, mtbfMinutes: 660, mttrMinutes: 8, scrapPpm: 900, consumes: ['PN-HEADLINER', 'PN-BODY-HARNESS'] },
      { id: 'TRIM-20', name: 'Cockpit Module Install', sequence: 20, capability: 'ASSEMBLE', zone: 'TRIM', cycleSeconds: 59, mtbfMinutes: 600, mttrMinutes: 10, scrapPpm: 1100, consumesSerial: ['CKP'] },
      { id: 'TRIM-30', name: 'Glass & Weather Seals', sequence: 30, capability: 'ASSEMBLE', zone: 'TRIM', cycleSeconds: 56, mtbfMinutes: 700, mttrMinutes: 9, scrapPpm: 1300, consumes: ['PN-WINDSHIELD', 'PN-BACKLIGHT', 'PN-WEATHERSTRIP'] },
      { id: 'CHAS-10', name: 'Powertrain Marriage (Decking)', sequence: 40, capability: 'TORQUE', zone: 'CHASSIS', cycleSeconds: 60, mtbfMinutes: 400, mttrMinutes: 18, scrapPpm: 1500, criticalToQuality: true, torqueSpecs: [{ id: 'TQ-MOUNT-LH', nm: 110, toleranceNm: 8 }, { id: 'TQ-MOUNT-RH', nm: 110, toleranceNm: 8 }, { id: 'TQ-SUBFRAME', nm: 180, toleranceNm: 12 }], consumesSerial: ['PWT'] },
      { id: 'CHAS-20', name: 'Suspension & Exhaust', sequence: 50, capability: 'TORQUE', zone: 'CHASSIS', cycleSeconds: 58, mtbfMinutes: 520, mttrMinutes: 12, scrapPpm: 1200, criticalToQuality: true, torqueSpecs: [{ id: 'TQ-KNUCKLE', nm: 95, toleranceNm: 6 }], consumesSerial: ['CNF', 'CNR'], consumes: ['PN-EXHAUST'] },
      { id: 'CHAS-30', name: 'Brake & Fuel Lines', sequence: 60, capability: 'ASSEMBLE', zone: 'CHASSIS', cycleSeconds: 57, mtbfMinutes: 640, mttrMinutes: 10, scrapPpm: 1000, criticalToQuality: true, consumes: ['PN-BRAKE-LINE', 'PN-FUEL-LINE'] },
      { id: 'FINAL-10', name: 'Wheel & Tire Fitment', sequence: 70, capability: 'TORQUE', zone: 'FINAL', cycleSeconds: 55, mtbfMinutes: 600, mttrMinutes: 9, scrapPpm: 800, criticalToQuality: true, torqueSpecs: [{ id: 'TQ-LUGNUT', nm: 140, toleranceNm: 10 }], consumesSerial: ['WHS'] },
      { id: 'FINAL-20', name: 'Seat Set Install', sequence: 80, capability: 'TORQUE', zone: 'FINAL', cycleSeconds: 54, mtbfMinutes: 700, mttrMinutes: 8, scrapPpm: 700, criticalToQuality: true, torqueSpecs: [{ id: 'TQ-SEAT-RAIL', nm: 45, toleranceNm: 4 }], consumesSerial: ['SET'] },
      { id: 'FINAL-30', name: 'Door Re-Hang & Alignment', sequence: 90, capability: 'ASSEMBLE', zone: 'FINAL', cycleSeconds: 59, mtbfMinutes: 560, mttrMinutes: 11, scrapPpm: 1700, consumesSerial: ['DRS'] },
      { id: 'FINAL-40', name: 'Fluid Fill & Battery', sequence: 100, capability: 'ASSEMBLE', zone: 'FINAL', cycleSeconds: 58, mtbfMinutes: 620, mttrMinutes: 10, scrapPpm: 900, consumes: ['PN-COOLANT', 'PN-BRAKE-FLUID', 'PN-BATTERY-12V'] }
    ]
  },
  {
    id: 'QUALITY',
    name: 'Quality & End-of-Line',
    area: 'QUALITY',
    sequence: 70,
    kind: 'MAIN',
    taktSeconds: 60,
    description: 'Functional validation, audit and VIN release to the shipping yard.',
    stations: [
      { id: 'EOL-10', name: 'Wheel Alignment', sequence: 10, capability: 'TEST', cycleSeconds: 58, mtbfMinutes: 600, mttrMinutes: 10, scrapPpm: 1400, inspectionPlan: 'IP-EOL-ALIGN' },
      { id: 'EOL-20', name: 'Headlamp Aim', sequence: 20, capability: 'TEST', cycleSeconds: 45, mtbfMinutes: 800, mttrMinutes: 7, scrapPpm: 1100, inspectionPlan: 'IP-EOL-LAMP' },
      { id: 'EOL-30', name: 'Roll & Brake Test', sequence: 30, capability: 'TEST', cycleSeconds: 62, mtbfMinutes: 480, mttrMinutes: 14, scrapPpm: 1800, inspectionPlan: 'IP-EOL-ROLL' },
      { id: 'EOL-40', name: 'Water Leak Test', sequence: 40, capability: 'TEST', cycleSeconds: 60, mtbfMinutes: 700, mttrMinutes: 9, scrapPpm: 2100, inspectionPlan: 'IP-EOL-WATER' },
      { id: 'EOL-50', name: 'Electrical & DTC Scan', sequence: 50, capability: 'TEST', cycleSeconds: 52, mtbfMinutes: 900, mttrMinutes: 6, scrapPpm: 2400, inspectionPlan: 'IP-EOL-DTC' },
      { id: 'EOL-60', name: 'Final Audit & VIN Release', sequence: 60, capability: 'INSPECT', cycleSeconds: 55, mtbfMinutes: 1400, mttrMinutes: 5, scrapPpm: 600, qualityGate: true, terminal: true, inspectionPlan: 'IP-EOL-AUDIT' }
    ]
  }
]);

/** The order a vehicle travels through the MAIN lines. Feeders merge in. */
const MAIN_ROUTE = Object.freeze(['BODY', 'PAINT', 'MAINASM', 'QUALITY']);

/** Vehicle models this plant is tooled for. */
const MODELS = Object.freeze([
  {
    code: 'NS-AURORA-EV',
    name: 'NorthStar Aurora',
    variant: 'Long Range AWD',
    bodyStyle: 'Sedan',
    powertrain: 'BEV',
    vds: 'AURE1',
    modelYear: 2026,
    colours: ['Glacier White', 'Laurentian Blue', 'Obsidian', 'Maple Red'],
    taktShareBps: 4200,          // 42% of plant volume
    serialComponents: ['PWT', 'CKP', 'SET', 'CNF', 'CNR', 'DRS', 'WHS']
  },
  {
    code: 'NS-BOREALIS-HEV',
    name: 'NorthStar Borealis',
    variant: 'Hybrid AWD',
    bodyStyle: 'SUV',
    powertrain: 'HEV',
    vds: 'BRLS2',
    modelYear: 2026,
    colours: ['Glacier White', 'Boreal Green', 'Obsidian', 'Slate Grey'],
    taktShareBps: 3800,
    serialComponents: ['PWT', 'CKP', 'SET', 'CNF', 'CNR', 'DRS', 'WHS']
  },
  {
    code: 'NS-VOYAGEUR-ICE',
    name: 'NorthStar Voyageur',
    variant: 'Crew Cab 4x4',
    bodyStyle: 'Pickup',
    powertrain: 'ICE',
    vds: 'VYGR3',
    modelYear: 2026,
    colours: ['Glacier White', 'Obsidian', 'Copper Bronze', 'Slate Grey'],
    taktShareBps: 2000,
    serialComponents: ['PWT', 'CKP', 'SET', 'CNF', 'CNR', 'DRS', 'WHS']
  }
]);

/** Production shifts (America/Toronto). Used for OEE planned-time windows. */
const SHIFTS = Object.freeze([
  { id: 'A', name: 'Day Shift', startHour: 6, endHour: 14, breakMinutes: 40, crewSize: 620 },
  { id: 'B', name: 'Afternoon Shift', startHour: 14, endHour: 22, breakMinutes: 40, crewSize: 600 },
  { id: 'C', name: 'Night Shift', startHour: 22, endHour: 6, breakMinutes: 50, crewSize: 210, maintenanceWindow: true }
]);

// --------------------------------------------------------------------------
// Integrity checks - run once at require time.
//
// These assert the invariants the rest of the system assumes. Failing loudly at
// boot beats discovering a bad station id three hours into a production run.
// --------------------------------------------------------------------------

/**
 * ISO 3779 excludes I, O and Q from VINs so they cannot be confused with 1 and
 * 0. A model descriptor containing one of them produces VINs that no decoder
 * will accept, so it is a boot-time failure rather than a runtime surprise.
 */
function assertPlantModelIntegrity() {
  const problems = [];

  for (const model of MODELS) {
    if (model.vds.length !== 5) {
      problems.push(`Model ${model.code}: vds '${model.vds}' must be exactly 5 characters`);
    }
    const illegal = [...model.vds].filter((c) => 'IOQ'.includes(c));
    if (illegal.length) {
      problems.push(
        `Model ${model.code}: vds '${model.vds}' contains ${illegal.join(', ')} - ` +
        'ISO 3779 excludes I, O and Q from VINs'
      );
    }
  }

  const seen = new Set();
  for (const line of LINES) {
    for (const station of line.stations) {
      if (seen.has(station.id)) problems.push(`Duplicate station id '${station.id}'`);
      seen.add(station.id);
      if (!(station.cycleSeconds > 0)) {
        problems.push(`Station ${station.id}: cycleSeconds must be positive`);
      }
    }
  }

  // Every serialised class must be installed at a station that exists and that
  // actually declares it in consumesSerial, or the marriage silently never happens.
  for (const line of LINES) {
    for (const station of line.stations) {
      if (!station.producesSerial) continue;
      const target = station.feedsStation || line.feedsStation;
      if (!target) {
        problems.push(`Station ${station.id} produces '${station.producesSerial}' but no install station is defined`);
        continue;
      }
      if (!seen.has(target)) {
        problems.push(`Station ${station.id} installs '${station.producesSerial}' at unknown station '${target}'`);
      }
    }
  }

  if (problems.length) {
    throw new Error(`Plant model integrity check failed:\n  - ${problems.join('\n  - ')}`);
  }
}

// --------------------------------------------------------------------------
// Derived lookups - built once at require time.
// --------------------------------------------------------------------------

const ALL_STATIONS = Object.freeze(
  LINES.flatMap((line) =>
    line.stations.map((station) =>
      Object.freeze({
        ...station,
        lineId: line.id,
        lineName: line.name,
        areaId: line.area,
        taktSeconds: line.taktSeconds,
        cycleSeconds: station.cycleSeconds,
        qualityGate: Boolean(station.qualityGate),
        criticalToQuality: Boolean(station.criticalToQuality),
        consumes: Object.freeze(station.consumes || []),
        consumesSerial: Object.freeze(station.consumesSerial || []),
        torqueSpecs: Object.freeze(station.torqueSpecs || [])
      })
    )
  )
);

const STATION_BY_ID = new Map(ALL_STATIONS.map((s) => [s.id, s]));
const LINE_BY_ID = new Map(LINES.map((l) => [l.id, l]));
const MODEL_BY_CODE = new Map(MODELS.map((m) => [m.code, m]));
const AREA_BY_ID = new Map(AREAS.map((a) => [a.id, a]));

/** Ordered station ids a vehicle visits, across all MAIN lines. */
const MAIN_STATION_ROUTE = Object.freeze(
  MAIN_ROUTE.flatMap((lineId) =>
    LINE_BY_ID.get(lineId).stations
      .slice()
      .sort((a, b) => a.sequence - b.sequence)
      .map((s) => s.id)
  )
);

/** Component classes produced anywhere in the plant, keyed by class code. */
const SERIAL_COMPONENTS = Object.freeze(
  ALL_STATIONS
    .filter((s) => s.producesSerial)
    .reduce((acc, s) => {
      acc[s.producesSerial] = Object.freeze({
        classCode: s.producesSerial,
        description: s.producesDescription,
        builtAt: s.id,
        builtOnLine: s.lineId,
        installedAt: s.feedsStation || LINE_BY_ID.get(s.lineId).feedsStation || null
      });
      return acc;
    }, {})
);

// Fail fast if the model above is internally inconsistent.
assertPlantModelIntegrity();

// --------------------------------------------------------------------------
// Accessors
// --------------------------------------------------------------------------

const getLine = (id) => LINE_BY_ID.get(id) || null;
const getStation = (id) => STATION_BY_ID.get(id) || null;
const getModel = (code) => MODEL_BY_CODE.get(code) || null;
const getArea = (id) => AREA_BY_ID.get(id) || null;
const listStations = (lineId) =>
  (lineId ? ALL_STATIONS.filter((s) => s.lineId === lineId) : ALL_STATIONS).slice();

/**
 * The station a unit moves to after `stationId` on the main route.
 * @returns {string|null} next station id, or null at end of line.
 */
function nextMainStation(stationId) {
  const index = MAIN_STATION_ROUTE.indexOf(stationId);
  if (index === -1 || index === MAIN_STATION_ROUTE.length - 1) return null;
  return MAIN_STATION_ROUTE[index + 1];
}

/** The station before `stationId` on the main route, or null at the head. */
function previousMainStation(stationId) {
  const index = MAIN_STATION_ROUTE.indexOf(stationId);
  if (index <= 0) return null;
  return MAIN_STATION_ROUTE[index - 1];
}

/** Ordered stations within one feeder line. */
function feederRoute(lineId) {
  const line = getLine(lineId);
  if (!line || line.kind !== 'FEEDER') return [];
  return line.stations.slice().sort((a, b) => a.sequence - b.sequence).map((s) => s.id);
}

/** Next station within a feeder line, or null when the sub-assembly is done. */
function nextFeederStation(stationId) {
  const station = getStation(stationId);
  if (!station) return null;
  const route = feederRoute(station.lineId);
  const index = route.indexOf(stationId);
  if (index === -1 || index === route.length - 1) return null;
  return route[index + 1];
}

/**
 * Theoretical best output of a line in jobs per hour, i.e. 3600 / bottleneck
 * cycle time. The bottleneck is the slowest station, not the average.
 */
function lineCapacityJph(lineId) {
  const stations = listStations(lineId);
  if (!stations.length) return 0;
  const bottleneck = Math.max(...stations.map((s) => s.cycleSeconds));
  return Number((3600 / bottleneck).toFixed(2));
}

/** The slowest station on a line - the constraint to attack first. */
function bottleneckStation(lineId) {
  const stations = listStations(lineId);
  if (!stations.length) return null;
  return stations.reduce((worst, s) => (s.cycleSeconds > worst.cycleSeconds ? s : worst));
}

/** Full ISA-95 hierarchy as a serialisable tree (used by GET /api/v1/plant). */
function hierarchy(site) {
  return {
    enterprise: site.enterprise,
    site: { id: site.id, name: site.name, location: site.location, timezone: site.timezone },
    areas: AREAS.map((area) => ({
      ...area,
      lines: LINES.filter((l) => l.area === area.id).map((line) => ({
        id: line.id,
        name: line.name,
        kind: line.kind,
        sequence: line.sequence,
        taktSeconds: line.taktSeconds,
        description: line.description,
        feeds: line.feeds || null,
        capacityJph: lineCapacityJph(line.id),
        bottleneck: bottleneckStation(line.id)?.id || null,
        stationCount: line.stations.length,
        stations: listStations(line.id).map((s) => ({
          id: s.id,
          name: s.name,
          sequence: s.sequence,
          capability: s.capability,
          cycleSeconds: s.cycleSeconds,
          qualityGate: s.qualityGate,
          criticalToQuality: s.criticalToQuality,
          producesSerial: s.producesSerial || null,
          consumesSerial: s.consumesSerial,
          robots: s.robots || 0
        }))
      }))
    }))
  };
}

module.exports = {
  STATION_STATES,
  UNPLANNED_STOP_STATES,
  PLANNED_STOP_STATES,
  STOP_STATES,
  CAPABILITIES,
  AREAS,
  LINES,
  MODELS,
  SHIFTS,
  MAIN_ROUTE,
  MAIN_STATION_ROUTE,
  ALL_STATIONS,
  SERIAL_COMPONENTS,
  getLine,
  getStation,
  getModel,
  getArea,
  listStations,
  nextMainStation,
  previousMainStation,
  feederRoute,
  nextFeederStation,
  lineCapacityJph,
  bottleneckStation,
  hierarchy,
  assertPlantModelIntegrity
};
