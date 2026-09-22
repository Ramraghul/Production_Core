'use strict';

/**
 * Deterministic demo data.
 *
 * Free hosting tiers give you an ephemeral disk and cold starts. A portfolio
 * demo that shows an empty plant because the container restarted is a broken
 * demo, so on boot we backfill a realistic production history: several days of
 * completed vehicles with full genealogy, defects, andon calls and downtime,
 * ending with vehicles part-built and spread across the line so the HMI has
 * something moving the moment it loads.
 *
 * Everything runs off a seeded PRNG, so the same PC_SIM_SEED always produces
 * the same plant. That makes the API tests assertable and the hosted demo
 * identical on every restart.
 */

const {
  MAIN_STATION_ROUTE, MODELS, getStation, SERIAL_COMPONENTS, ALL_STATIONS, LINES
} = require('../core/plantModel');
const shiftCore = require('../core/shift');
const qualityCore = require('../core/quality');
const downtimeCore = require('../core/downtime');
const andonCore = require('../core/andon');
const unitCore = require('../core/unit');
const ids = require('../core/ids');
const workOrderCore = require('../core/workOrder');
const genealogyCore = require('../core/genealogy');
const bomCore = require('../core/bom');
const subCore = require('../core/subAssembly');
const controlCore = require('../core/stationControl');
const config = require('../config');
const { createLogger } = require('../logger');

const log = createLogger('seed');

/** Plausible operator and technician ids, reused so history looks coherent. */
const OPERATORS = ['op-1140', 'op-2271', 'op-3312', 'op-4408', 'op-5521', 'op-6634'];
const INSPECTORS = ['qa-201', 'qa-202', 'qa-203'];
const TECHNICIANS = ['maint-771', 'maint-772', 'maint-883'];

/**
 * Defect codes weighted the way a real plant sees them: lots of minor paint
 * dirt, very few critical torque failures.
 */
const DEFECT_WEIGHTS = Object.freeze([
  ['DIRT_INCLUSION', 24], ['ORANGE_PEEL', 14], ['SCRATCH', 12], ['TRIM_GAP', 9],
  ['GAP_FLUSH_OOS', 8], ['RUN_SAG', 6], ['CLIP_BROKEN', 6], ['HARNESS_UNSEATED', 5],
  ['BALANCE_OOS', 4], ['ALIGNMENT_OOS', 4], ['THIN_FILM', 3], ['DOOR_EFFORT_HIGH', 3],
  ['TPMS_NO_SIGNAL', 2], ['RATTLE_BSR', 2], ['LAMP_INOP', 2], ['COLOUR_MISMATCH', 1],
  ['TORQUE_LOW', 1], ['DTC_PRESENT', 1], ['WELD_MISSING', 1], ['WATER_LEAK', 1]
]);

const DOWNTIME_WEIGHTS = Object.freeze([
  ['MATERIAL_SHORTAGE', 18], ['CONVEYOR_JAM', 15], ['DOWNSTREAM_STARVED', 14],
  ['UPSTREAM_BLOCKED', 12], ['ROBOT_FAULT', 10], ['EQUIP_FAILURE', 9],
  ['TOOL_BREAKAGE', 6], ['OPERATOR_ABSENT', 5], ['QUALITY_HOLD', 4],
  ['SLOW_CYCLE', 4], ['CHANGEOVER', 3]
]);

/**
 * Disposition mix by severity. A CRITICAL defect is never waived - the domain
 * layer rejects USE_AS_IS on CRITICAL, so the generator must not attempt it.
 */
const DISPOSITION_WEIGHTS = Object.freeze({
  CRITICAL: [['REWORK', 5], ['REPAIR', 4], ['SCRAP', 1]],
  MAJOR: [['REWORK', 7], ['REPAIR', 3], ['USE_AS_IS', 1]],
  MINOR: [['REWORK', 6], ['USE_AS_IS', 4]]
});

const ANDON_WEIGHTS = Object.freeze([
  ['MATERIAL', 30], ['QUALITY', 22], ['MAINTENANCE', 20], ['PROCESS', 15],
  ['TOOLING', 10], ['SAFETY', 3]
]);

/**
 * Populate the repository with demo history.
 *
 * The backfill is deliberately split the way a real MES splits its data:
 *
 *   hot  - the last `detailShifts` shifts, with full per-vehicle detail:
 *          genealogy, station-by-station history, defects and inspections.
 *          This is what the traceability and OEE screens read.
 *   cold - everything older, stored as one aggregate row per shift. A plant
 *          historian does exactly this, and it is what keeps the demo inside
 *          a free tier's memory budget while still showing a week of trend.
 *
 * Vehicle volume is derived from the line's takt time and a target OEE, so the
 * seeded KPIs land in a plausible band rather than being asserted.
 *
 * @param {object} deps {repository, production, quality, operations}
 * @param {object} [options] {days, detailShifts, now, seed, targetOee}
 * @returns {object} counts of what was created
 */
function seedPlant(deps, options = {}) {
  const { repository, production, operations } = deps;
  const now = options.now || new Date();
  const random = ids.createRandom(options.seed ?? config.simulator.seed);
  const detailShifts = options.detailShifts ?? config.seed.detailShifts;
  const totalShifts = (options.days ?? config.seed.days) * 3;
  const targetOee = options.targetOee ?? config.seed.targetOee;

  const started = Date.now();
  const counts = {
    workOrders: 0, units: 0, completed: 0, scrapped: 0, held: 0,
    subAssemblies: 0, defects: 0, andons: 0, downtimes: 0,
    inspections: 0, shiftMetrics: 0
  };

  // Oldest first, so work-order numbering reads chronologically.
  const windows = shiftCore.recentShifts(totalShifts, now).reverse();
  const detailWindows = windows.slice(-detailShifts);
  const coldWindows = windows.slice(0, Math.max(0, windows.length - detailShifts));

  // ---- cold history: one aggregate KPI row per shift ----------------------
  for (const window of coldWindows) {
    counts.shiftMetrics += 1;
    repository.put('shiftMetrics', buildShiftMetrics({ window, random, targetOee }));
  }

  // ---- hot history: full detail -------------------------------------------
  //
  // A shift that has only just started yields no completed vehicles, which is
  // arithmetically correct and makes for an empty demo. Because a cold start
  // lands shortly after a shift change roughly one time in eight, the loop
  // below keeps reaching further back until it has produced something.
  const seedDetail = (window) => {
    const isCurrent = window.end > now;
    const windowEnd = isCurrent ? now : window.end;
    const windowSeconds = Math.max(0, Math.round((windowEnd - window.start) / 1000));

    // Vehicles are launched across the whole shift, not just the part of it
    // with room for a full build. A vehicle started in the last half hour
    // finishes during the NEXT shift, exactly as on a real line where work in
    // progress carries across the handover - and that carry-over is what fills
    // the first half hour of every shift. Capping launches to
    // `windowSeconds - buildSeconds` instead produced an artificial ~27 minute
    // hole in output at every shift boundary.
    const launchSeconds = windowSeconds;

    // Per-shift OEE varies so the trend chart is not a flat line.
    const shiftOee = Math.max(0.5, Math.min(0.95, random.normal(targetOee, 0.06)));
    const plannedUnits = Math.floor((launchSeconds / mainTakt) * shiftOee);

    if (plannedUnits <= 0) return 0;

    // One work order per model per shift, sized by that model's volume share.
    const orders = [];
    for (const model of MODELS) {
      const share = model.taktShareBps / 10000;
      const quantity = Math.max(1, Math.round(plannedUnits * share * random.float(1.05, 1.25)));
      const createdAt = new Date(window.start.getTime() - random.int(1800, 7200) * 1000);

      const workOrder = production.createWorkOrder({
        modelCode: model.code,
        quantity,
        colour: random.pick(model.colours),
        priority: random.weighted([['NORMAL', 7], ['HIGH', 2], ['EXPEDITE', 1]]),
        customerRef: `ORD-${random.int(100000, 999999)}`,
        dueDate: new Date(window.end.getTime() + 86400000).toISOString()
      }, createdAt);
      repository.put('workOrders', workOrderCore.transition(
        workOrderCore.transition(workOrder, 'RELEASED', { at: createdAt }),
        'IN_PROGRESS', { at: window.start }
      ));
      counts.workOrders += 1;
      orders.push({ model, workOrder, share, built: 0 });
    }

    // Launch vehicles evenly across the shift, model mix following the plan.
    const spacing = launchSeconds / plannedUnits;
    for (let index = 0; index < plannedUnits; index += 1) {
      const order = pickOrder(orders, index, plannedUnits);
      const startedAt = new Date(
        window.start.getTime()
        + Math.round(index * spacing + random.float(-spacing * 0.3, spacing * 0.3)) * 1000
      );

      const built = buildHistoricalUnit({
        repository, random, model: order.model, workOrder: order.workOrder,
        buildNumber: order.built + 1, startedAt, now
      });
      order.built += 1;

      counts.units += 1;
      counts.subAssemblies += built.subAssemblies;
      counts.defects += built.defects;
      counts.inspections += built.inspections;
      if (built.status === 'COMPLETED') counts.completed += 1;
      if (built.status === 'SCRAPPED') counts.scrapped += 1;
      if (built.status === 'HOLD') counts.held += 1;
    }

    // Andon and downtime across the shift. A 43-station plant realistically
    // sees a call every 20-30 minutes somewhere on the floor.
    const calls = Math.max(1, Math.round((windowSeconds / 3600) * random.float(2.2, 3.6)));
    for (let index = 0; index < calls; index += 1) {
      const at = new Date(window.start.getTime() + random.int(0, Math.max(1, windowSeconds)) * 1000);
      if (at > now) continue;
      if (seedAndonWithDowntime({ repository, random, at, now })) {
        counts.andons += 1;
        counts.downtimes += 1;
      }
    }

    return plannedUnits;
  };

  const mainTakt = 60; // MAINASM sets the plant pace
  const seeded = new Set();

  for (const window of detailWindows) {
    seeded.add(shiftCore.shiftKey(window));
    seedDetail(window);
  }

  // Nothing produced - the current shift is too young. Walk back through the
  // cold windows, promoting each to full detail, until the plant has history.
  for (let index = coldWindows.length - 1; index >= 0 && counts.units === 0; index -= 1) {
    const window = coldWindows[index];
    const key = shiftCore.shiftKey(window);
    if (seeded.has(key)) continue;

    // It is now detailed rather than rolled up, so drop the aggregate row or
    // the trend would show the same shift twice, from two different sources.
    repository.delete('shiftMetrics', key);
    counts.shiftMetrics -= 1;
    seeded.add(key);
    seedDetail(window);
  }

  // ---- live work in progress ---------------------------------------------
  const activeOrders = repository
    .all('workOrders')
    .filter((w) => w.status === 'IN_PROGRESS');

  // There is always work in progress on a running line. It goes on the latest
  // order with room for it; if there is none - a brand new plant, a very young
  // shift, or every order already full - open one rather than overfilling an
  // order or showing an empty floor.
  const wipCount = random.int(10, 16);
  const roomIn = (order) =>
    order.quantity - repository.count('units', (u) => u.workOrderId === order.id);
  let liveOrder = activeOrders.filter((order) => roomIn(order) >= wipCount).pop();
  if (!liveOrder) {
    const model = random.pick(MODELS);
    const created = production.createWorkOrder({
      modelCode: model.code,
      quantity: random.int(Math.max(40, wipCount), 90),
      colour: random.pick(model.colours),
      customerRef: `ORD-${random.int(100000, 999999)}`,
      dueDate: new Date(now.getTime() + 86400000 * 2).toISOString()
    }, now);
    liveOrder = workOrderCore.transition(
      workOrderCore.transition(created, 'RELEASED', { at: now }),
      'IN_PROGRESS', { at: now }
    );
    repository.put('workOrders', liveOrder);
    counts.workOrders += 1;
  }

  const wip = seedWorkInProgress({
    repository, production, random, workOrder: liveOrder, wipCount, now
  });
  counts.units += wip.units;
  counts.subAssemblies += wip.subAssemblies;

  // Fill each feeder buffer so final assembly does not immediately starve.
  for (const classCode of Object.keys(SERIAL_COMPONENTS)) {
    if (classCode === 'DRS') continue; // broadcast-built against a VIN
    for (let index = 0; index < random.int(3, 6); index += 1) {
      production.buildSubAssembly(classCode, {}, now);
      counts.subAssemblies += 1;
    }
  }

  counts.maintenanceOrders = seedMaintenanceHistory({
    repository, random, now, days: options.days ?? config.seed.days
  });
  seedStationStates({ repository, operations, random, now });
  repository.rebuildIndexes();

  log.info('demo data seeded', { ...counts, ms: Date.now() - started });
  return counts;
}

/**
 * Choose which model to build next so the running mix tracks the planned mix.
 * Picks whichever order is furthest behind its share - the same logic a
 * sequencer uses to hold a model mix across a shift.
 *
 * @param {Array<{share:number, built:number}>} orders
 * @param {number} index zero-based position in the shift's launch sequence
 */
function pickOrder(orders, index) {
  let best = orders[0];
  let worstDeficit = -Infinity;
  for (const order of orders) {
    const expected = order.share * (index + 1);
    const deficit = expected - order.built;
    if (deficit > worstDeficit) {
      worstDeficit = deficit;
      best = order;
    }
  }
  return best;
}

/**
 * One aggregate KPI row for a shift that is outside the detailed window.
 * These are what the trend chart reads for older history.
 */
function buildShiftMetrics({ window, random, targetOee }) {
  const seconds = Math.round((window.end - window.start) / 1000);
  // Centred on what the detailed tier actually produces, so the trend chart
  // does not show a suspicious step where hot storage meets cold storage.
  const oee = Math.max(0.48, Math.min(0.88, random.normal(targetOee * 0.87, 0.06)));
  const availability = Math.max(0.6, Math.min(0.99, random.normal(0.93, 0.04)));
  const quality = Math.max(0.9, Math.min(0.999, random.normal(0.962, 0.012)));
  const performance = Math.max(0.5, Math.min(1, oee / (availability * quality)));
  const units = Math.round((seconds / 60) * oee);

  return {
    key: shiftCore.shiftKey(window),
    shift: window.shift.id,
    shiftName: window.shift.name,
    start: window.start.toISOString(),
    end: window.end.toISOString(),
    aggregate: true,
    oee: Number((oee * 100).toFixed(2)),
    availability: Number((availability * 100).toFixed(2)),
    performance: Number((performance * 100).toFixed(2)),
    quality: Number((quality * 100).toFixed(2)),
    unitsCompleted: units,
    unitsScrapped: Math.round(units * random.float(0.002, 0.012)),
    jph: Number(((units / (seconds / 3600))).toFixed(2)),
    fpyPct: Number((random.normal(83.5, 3.0)).toFixed(1)),
    defectCount: Math.round(units * random.float(0.06, 0.16)),
    andonCount: random.int(14, 30),
    unplannedDowntimeMinutes: Number((random.float(18, 62)).toFixed(1))
  };
}

/**
 * Build one vehicle's complete history in the past, writing documents directly
 * so timestamps land inside the target shift.
 */
function buildHistoricalUnit(ctx) {
  const { repository, random, model, workOrder, buildNumber, startedAt, now } = ctx;

  const sequence = repository.nextSequence('vin', 1000);
  const vin = ids.buildVin({
    vds: model.vds, year: model.modelYear,
    plantCode: config.site.plantCode, sequence
  });

  let unit = unitCore.createUnit({
    vin, workOrderId: workOrder.id, modelCode: model.code,
    colour: workOrder.colour, buildNumber
  }, startedAt);

  let genealogy = genealogyCore.createGenealogy(vin, {
    workOrderId: workOrder.id, modelCode: model.code, site: config.site.id
  }, startedAt);

  const result = { subAssemblies: 0, defects: 0, inspections: 0, status: 'IN_PROCESS' };
  let cursor = startedAt.getTime();

  // Sub-assemblies for this VIN, built shortly before it needs them.
  //
  // A sub-assembly that fails its functional test is quarantined and can never
  // be fitted. The plant's response is to build a replacement and leave the bad
  // one in quarantine as evidence, so that is what the seeder does too - which
  // is also why the demo data contains a realistic trickle of QUARANTINED
  // records rather than a suspiciously clean buffer.
  const subs = {};
  for (const [classCode] of Object.entries(SERIAL_COMPONENTS)) {
    let sub;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      sub = buildHistoricalSub({
        repository, random, classCode, vin,
        at: new Date(cursor - random.int(600, 3600) * 1000)
      });
      result.subAssemblies += 1;
      if (sub.status !== 'QUARANTINED') break;
    }
    subs[classCode] = sub;
  }

  // A small share of vehicles are scrapped partway; the rest complete.
  const scrapAt = random.chance(0.012)
    ? random.int(3, MAIN_STATION_ROUTE.length - 2)
    : -1;

  // Carries the outcome of the station just left, so a station where a defect
  // was found closes its visit as REWORKED rather than PASS. Without this the
  // per-station quality factor is always 100% and rolled throughput yield is
  // meaningless.
  let pendingResult = unitCore.VISIT_RESULTS.PASS;

  for (let index = 0; index < MAIN_STATION_ROUTE.length; index += 1) {
    const stationId = MAIN_STATION_ROUTE[index];
    const station = getStation(stationId);

    // Cycle time: normal around ideal, with an occasional long tail.
    const cycleSeconds = Math.max(
      5,
      Math.round(random.normal(station.cycleSeconds * 1.04, station.cycleSeconds * 0.09))
        + (random.chance(0.03) ? random.int(30, 240) : 0)
    );

    const at = new Date(cursor);
    unit = unitCore.moveToStation(unit, stationId, {
      at, operator: random.pick(OPERATORS), cycleSeconds, result: pendingResult
    });
    pendingResult = unitCore.VISIT_RESULTS.PASS;

    // Back-flush parts into genealogy.
    for (const partNumber of station.consumes) {
      const part = bomCore.getPart(partNumber);
      const lotCode = part.lotControlled
        ? ids.buildLotCode(part.supplier, partNumber, at, String.fromCharCode(65 + random.int(0, 3)))
        : null;
      genealogy = genealogyCore.recordPart(genealogy, {
        partNumber, description: part.description, lotCode,
        supplier: part.supplier, quantity: bomCore.quantityPer(partNumber),
        safetyCritical: part.safetyCritical
      }, stationId, at);
      if (lotCode) repository.indexLot(lotCode, vin);
    }

    // Install sub-assemblies. Quarantined serials are skipped rather than
    // forced through - the vehicle simply runs short, which is exactly what
    // shows up on the buffer-starvation tile.
    for (const classCode of station.consumesSerial) {
      const sub = subs[classCode];
      if (!sub || sub.status === 'CONSUMED' || sub.status === 'QUARANTINED') continue;
      const consumed = subCore.consume(sub, vin, stationId, at);
      repository.put('subAssemblies', consumed);
      subs[classCode] = consumed;
      genealogy = genealogyCore.recordSubAssembly(genealogy, consumed, stationId, at);
      repository.indexSerial(consumed.serial, vin);
      (consumed.components || []).forEach((c) => c.lotCode && repository.indexLot(c.lotCode, vin));
    }

    // Defects, at roughly the station's scrap rate scaled up to a realistic
    // detection rate - a plant finds far more defects than it scraps. The
    // multiplier is tuned so plant first-pass yield lands around 80%, which is
    // a believable direct-run rate for vehicle assembly.
    const defectChance = (station.scrapPpm / 1e6) * 7;
    if (random.chance(defectChance)) {
      const defect = seedDefect({ repository, random, vin, stationId, at });
      unit = unitCore.addDefect(unit, defect.id);
      pendingResult = unitCore.VISIT_RESULTS.REWORKED;
      result.defects += 1;

      // Most defects are found, fixed and closed before the vehicle ships.
      if (random.chance(0.88)) {
        const repaired = qualityCore.disposition(
          defect,
          // Disposition has to respect severity: a CRITICAL finding can never
          // be waived USE_AS_IS, and the domain layer rejects it outright.
          random.weighted(DISPOSITION_WEIGHTS[defect.severity]),
          { operator: random.pick(TECHNICIANS), repairMinutes: random.int(3, 40) },
          new Date(at.getTime() + random.int(120, 1800) * 1000)
        );
        const closed = repaired.status === 'CLOSED'
          ? repaired
          : qualityCore.transitionDefect(
              qualityCore.transitionDefect(repaired, 'VERIFIED', {}, at),
              'CLOSED', { operator: random.pick(INSPECTORS) }, at
            );
        repository.put('defects', closed);
        unit = unitCore.clearDefect(unit, defect.id);
        unit = { ...unit, reworkCount: unit.reworkCount + 1 };
      }
    }

    // Inspection records at gate stations.
    if (station.inspectionPlan && random.chance(0.35)) {
      const inspection = seedInspection({
        repository, random, planId: station.inspectionPlan, stationId, vin, at
      });
      if (inspection) result.inspections += 1;
    }

    cursor += (cycleSeconds + random.int(2, 18)) * 1000;

    if (index === scrapAt) {
      const scrapped = unitCore.scrap(
        unit,
        `Unrecoverable ${random.pick(['weld', 'paint', 'dimensional'])} defect at ${stationId}`,
        { at: new Date(cursor), operator: random.pick(INSPECTORS) }
      );
      repository.put('units', scrapped);
      repository.put('genealogies', genealogy);
      bumpOrder(repository, workOrder.id, { scrapped: 1 });
      result.status = 'SCRAPPED';
      return result;
    }
  }

  // Release the finished vehicle - unless it still carries an open defect, in
  // which case it goes to the end-of-line hold yard exactly as it would in a
  // real plant. This is why the seeded data always contains a handful of units
  // in HOLD at EOL-60 rather than an implausibly clean 100% release rate.
  if (cursor < now.getTime()) {
    if (unit.openDefectIds.length) {
      const heldAt = cursor;
      unit = unitCore.hold(
        unit,
        `Held at end of line with ${unit.openDefectIds.length} open defect(s)`,
        { at: new Date(heldAt), operator: random.pick(INSPECTORS) }
      );

      // A repair yard does not accumulate vehicles across days. Anything held
      // more than a few hours ago has since been repaired and released; only
      // recent holds are still sitting there when the visitor looks.
      const repairWindowMs = random.int(2, 6) * 3600 * 1000;
      if (now.getTime() - heldAt > repairWindowMs) {
        const repairedAt = new Date(heldAt + repairWindowMs);

        for (const defectId of unit.openDefectIds.slice()) {
          const open = repository.get('defects', defectId);
          if (!open) continue;
          const dispositioned = qualityCore.disposition(
            open,
            random.weighted(DISPOSITION_WEIGHTS[open.severity]),
            { operator: random.pick(TECHNICIANS), repairMinutes: random.int(20, 180) },
            repairedAt
          );
          repository.put('defects', dispositioned.status === 'CLOSED'
            ? dispositioned
            : qualityCore.transitionDefect(
                qualityCore.transitionDefect(dispositioned, 'VERIFIED', {}, repairedAt),
                'CLOSED', { operator: random.pick(INSPECTORS) }, repairedAt
              ));
          unit = unitCore.clearDefect(unit, defectId);
        }

        unit = unitCore.release(unit, { at: repairedAt });
        unit = { ...unit, reworkCount: unit.reworkCount + 1, currentStation: 'EOL-60', currentLine: 'QUALITY' };
        unit = unitCore.complete(unit, { at: repairedAt, operator: random.pick(INSPECTORS) });
        genealogy = genealogyCore.seal(genealogy, repairedAt);
        bumpOrder(repository, workOrder.id, { completed: 1 });
        result.status = 'COMPLETED';
      } else {
        result.status = 'HOLD';
        bumpOrder(repository, workOrder.id, {});
      }
    } else {
      unit = unitCore.complete(unit, { at: new Date(cursor), operator: random.pick(INSPECTORS) });
      genealogy = genealogyCore.seal(genealogy, new Date(cursor));
      bumpOrder(repository, workOrder.id, { completed: 1 });
      result.status = 'COMPLETED';
    }
  } else {
    // Still on the line: started, not finished - but started all the same.
    bumpOrder(repository, workOrder.id, {});
  }

  repository.put('units', unit);
  repository.put('genealogies', genealogy);
  return result;
}

/** A serialised sub-assembly with its own parts and test result. */
function buildHistoricalSub({ repository, random, classCode, vin, at }) {
  const spec = SERIAL_COMPONENTS[classCode];
  const serial = ids.buildSerial(classCode, repository.nextSequence(`serial:${classCode}`), at);

  let sub = subCore.createSubAssembly({
    serial, classCode, builtAt: spec.builtAt,
    forVin: subCore.BROADCAST_CLASSES.includes(classCode) ? vin : null
  }, at);

  const station = getStation(spec.builtAt);
  const line = LINES.find((l) => l.id === spec.builtOnLine);
  const cellStations = (line?.stations || []).filter((s) => !station?.cell || s.cell === station.cell);

  for (const cellStation of cellStations) {
    for (const partNumber of cellStation.consumes || []) {
      const part = bomCore.getPart(partNumber);
      sub = subCore.addComponent(sub, {
        partNumber, description: part.description, supplier: part.supplier,
        quantity: bomCore.quantityPer(partNumber),
        safetyCritical: part.safetyCritical,
        lotCode: part.lotControlled
          ? ids.buildLotCode(part.supplier, partNumber, at, String.fromCharCode(65 + random.int(0, 3)))
          : null
      }, at);
    }
  }

  if (station?.inspectionPlan) {
    sub = subCore.addTestResult(sub, {
      testId: station.inspectionPlan, stationId: spec.builtAt,
      passed: !random.chance(0.015), measurements: {}
    }, at);
  }

  sub = subCore.completeBuild(sub, at);
  if (!subCore.BROADCAST_CLASSES.includes(classCode) && sub.status === 'AVAILABLE') {
    sub = subCore.allocate(sub, vin, at);
  }
  repository.put('subAssemblies', sub);
  return sub;
}

function seedDefect({ repository, random, vin, stationId, at }) {
  const station = getStation(stationId);
  // Prefer a defect code that plausibly occurs at this station.
  const local = qualityCore.DEFECT_CODES.filter((d) => d.typicalStations?.includes(stationId));
  const code = local.length && random.chance(0.75)
    ? random.pick(local).code
    : random.weighted(DEFECT_WEIGHTS.slice());

  const defect = qualityCore.createDefect({
    id: ids.sequentialId('DEF', repository.nextSequence('defect')),
    code, vin, stationId,
    detectedBy: random.pick(INSPECTORS)
  }, at);

  const withLot = { ...defect, lineId: station.lineId };
  repository.put('defects', withLot);
  return withLot;
}

function seedInspection({ repository, random, planId, stationId, vin, at }) {
  const plan = qualityCore.getInspectionPlan(planId);
  if (!plan) return null;

  // Measure around nominal, occasionally drifting out of spec.
  const measurements = {};
  for (const characteristic of plan.characteristics) {
    const span = (characteristic.upperLimit - characteristic.lowerLimit) || 1;
    const drift = random.chance(0.05) ? span * random.float(0.6, 1.1) : 0;
    const centre = (characteristic.upperLimit + characteristic.lowerLimit) / 2;
    measurements[characteristic.id] = Number(
      (random.normal(centre, span * 0.16) + drift).toFixed(3)
    );
  }

  try {
    const result = qualityCore.runInspection(planId, measurements, {
      vin, stationId, inspector: random.pick(INSPECTORS)
    }, at);
    const record = {
      id: ids.sequentialId('INSP', repository.nextSequence('inspection')),
      ...result
    };
    repository.put('inspections', record);
    return record;
  } catch (_error) {
    // A characteristic outside the numeric domain is skipped rather than
    // failing the whole seed run.
    return null;
  }
}

/** An andon call with its linked downtime, both closed in the past. */
function seedAndonWithDowntime({ repository, random, at, now }) {
  const station = random.pick(ALL_STATIONS);
  const callType = random.weighted(ANDON_WEIGHTS.slice());
  const spec = andonCore.CALL_TYPES[callType];

  let andon = andonCore.createAndon({
    id: ids.sequentialId('AND', repository.nextSequence('andon')),
    stationId: station.id, callType, raisedBy: random.pick(OPERATORS)
  }, at);

  // Response time: usually inside SLA, sometimes badly late.
  const responseSeconds = random.chance(0.78)
    ? random.int(15, spec.slaSeconds)
    : random.int(spec.slaSeconds, spec.slaSeconds * 4);
  const ackAt = new Date(at.getTime() + responseSeconds * 1000);
  const resolveAt = new Date(ackAt.getTime() + random.int(60, 2700) * 1000);

  if (resolveAt > now) return false; // would still be open in the future - skip

  if (responseSeconds > spec.slaSeconds) andon = andonCore.escalate(andon, ackAt);
  andon = andonCore.acknowledge(andon, random.pick(TECHNICIANS), ackAt);

  const reasonCode = random.weighted(DOWNTIME_WEIGHTS.slice());
  const downtime = downtimeCore.endDowntime(
    downtimeCore.createDowntime({
      id: ids.sequentialId('DT', repository.nextSequence('downtime')),
      stationId: station.id, reasonCode, andonId: andon.id,
      reportedBy: andon.raisedBy
    }, at),
    {
      repairedBy: random.pick(TECHNICIANS),
      rootCause: rootCauseFor(reasonCode, random),
      correctiveAction: correctiveActionFor(reasonCode, random)
    },
    resolveAt
  );
  repository.put('downtimes', downtime);

  andon = andonCore.resolve(
    andon, downtime.correctiveAction, random.pick(TECHNICIANS), resolveAt
  );
  repository.put('andons', { ...andon, downtimeId: downtime.id });
  return true;
}

const ROOT_CAUSES = {
  ROBOT_FAULT: ['Servo drive over-temperature', 'Tool centre point drift', 'E-stop circuit fault'],
  EQUIP_FAILURE: ['Bearing failure on drive shaft', 'Pneumatic valve stuck', 'PLC IO module fault'],
  TOOL_BREAKAGE: ['Weld tip worn past limit', 'Nutrunner socket cracked', 'Locating pin sheared'],
  CONVEYOR_JAM: ['Carrier misaligned on track', 'Skid sensor mis-read', 'Chain tension out of spec'],
  MATERIAL_SHORTAGE: ['Line-side rack empty', 'Kit delivered to wrong station', 'Supplier truck delayed'],
  QUALITY_HOLD: ['Suspect lot pending disposition', 'Torque data outside control limits'],
  DEFAULT: ['Under investigation', 'Operator-reported, no fault found']
};

const CORRECTIVE_ACTIONS = {
  ROBOT_FAULT: ['Reset drive and re-homed robot', 'Re-taught tool centre point', 'Replaced servo amplifier'],
  EQUIP_FAILURE: ['Replaced bearing assembly', 'Swapped valve manifold', 'Replaced IO card and retested'],
  TOOL_BREAKAGE: ['Dressed and replaced weld tips', 'Fitted new socket', 'Replaced locating pin'],
  CONVEYOR_JAM: ['Cleared carrier and realigned', 'Cleaned and recalibrated sensor', 'Adjusted chain tension'],
  MATERIAL_SHORTAGE: ['Expedited replenishment from stores', 'Re-routed kit to correct station'],
  QUALITY_HOLD: ['Lot released after engineering review', 'Re-verified torque tool calibration'],
  DEFAULT: ['Restarted station, monitoring', 'No fault found, returned to service']
};

const rootCauseFor = (code, random) =>
  random.pick(ROOT_CAUSES[code] || ROOT_CAUSES.DEFAULT);
const correctiveActionFor = (code, random) =>
  random.pick(CORRECTIVE_ACTIONS[code] || CORRECTIVE_ACTIONS.DEFAULT);

/** Vehicles spread across the line so the HMI has live movement. */
function seedWorkInProgress({ repository, production, random, workOrder, wipCount, now }) {
  const counts = { units: 0, subAssemblies: 0 };
  const model = MODELS.find((m) => m.code === workOrder.modelCode);

  for (let index = 0; index < wipCount; index += 1) {
    const sequence = repository.nextSequence('vin', 1000);
    const vin = ids.buildVin({
      vds: model.vds, year: model.modelYear,
      plantCode: config.site.plantCode, sequence
    });

    let unit = unitCore.createUnit({
      vin, workOrderId: workOrder.id, modelCode: model.code,
      colour: workOrder.colour, buildNumber: 900 + index
    }, now);

    let genealogy = genealogyCore.createGenealogy(vin, {
      workOrderId: workOrder.id, modelCode: model.code, site: config.site.id
    }, now);

    // Spread units evenly along the main route.
    const depth = Math.floor((index / wipCount) * (MAIN_STATION_ROUTE.length - 1)) + 1;
    let cursor = now.getTime() - depth * 62000;

    for (let step = 0; step < depth; step += 1) {
      const stationId = MAIN_STATION_ROUTE[step];
      const station = getStation(stationId);
      const at = new Date(cursor);
      unit = unitCore.moveToStation(unit, stationId, {
        at, operator: random.pick(OPERATORS),
        cycleSeconds: Math.max(5, Math.round(random.normal(station.cycleSeconds * 1.05, 6)))
      });
      for (const partNumber of station.consumes) {
        const part = bomCore.getPart(partNumber);
        const lotCode = part.lotControlled
          ? ids.buildLotCode(part.supplier, partNumber, at, String.fromCharCode(65 + random.int(0, 3)))
          : null;
        genealogy = genealogyCore.recordPart(genealogy, {
          partNumber, description: part.description, lotCode, supplier: part.supplier,
          quantity: bomCore.quantityPer(partNumber),
          safetyCritical: part.safetyCritical
        }, stationId, at);
        if (lotCode) repository.indexLot(lotCode, vin);
      }
      cursor += 62000;
    }

    repository.put('units', unit);
    repository.put('genealogies', genealogy);
    bumpOrder(repository, workOrder.id, {});
    counts.units += 1;

    // Doors are broadcast-built, so give every live VIN a door set waiting.
    production.buildSubAssembly('DRS', { forVin: vin }, now);
    counts.subAssemblies += 1;
  }

  return counts;
}

/** A believable opening state mix: mostly running, a few stopped. */
function seedStationStates({ repository, operations, random, now }) {
  operations.ensureStationStates(now);

  for (const station of ALL_STATIONS) {
    const state = random.weighted([
      ['RUNNING', 74], ['IDLE', 10], ['STARVED', 6],
      ['BLOCKED', 5], ['DOWN', 4], ['MAINTENANCE', 1]
    ]);

    // Spread PM wear across the plant so the maintenance board opens with a
    // realistic mix: most stations comfortably inside their interval, a few
    // coming due, one or two overdue.
    const interval = controlCore.pmIntervalCycles(station);
    const wear = random.weighted([[0.3, 5], [0.6, 5], [0.85, 3], [1.05, 2], [1.3, 1]]);
    const cyclesSinceMaintenance = Math.round(interval * wear * random.float(0.8, 1.05));

    const current = repository.get('stationStates', station.id);
    repository.put('stationStates', {
      ...current,
      state: state === 'MAINTENANCE' ? 'IDLE' : state,
      previousState: 'IDLE',
      since: new Date(now.getTime() - random.int(30, 1800) * 1000).toISOString(),
      cycleCount: random.int(40, 260),
      goodCount: random.int(38, 258),
      cyclesSinceMaintenance,
      lastMaintenanceAt: new Date(
        now.getTime() - Math.round(cyclesSinceMaintenance * station.cycleSeconds * 1.3) * 1000
      ).toISOString(),
      lastCycleSeconds: Math.max(5, Math.round(random.normal(station.cycleSeconds * 1.04, 5))),
      updatedAt: now.toISOString()
    });

    // A station shown in maintenance gets a real maintenance order, started a
    // little while ago - not just a state flag - so the maintenance board, the
    // lockout and the downtime log all agree from the first page load.
    if (state === 'MAINTENANCE') {
      const plannedMinutes = random.pick([15, 20, 30]);
      operations.startMaintenance(station.id, {
        type: 'PREVENTIVE',
        technician: random.pick(TECHNICIANS),
        plannedMinutes,
        note: 'Scheduled PM'
      }, new Date(now.getTime() - random.int(2, plannedMinutes - 1) * 60000));
      continue;
    }

    // A station shown as DOWN must have an open downtime record, or the
    // dashboard and the downtime log would contradict each other.
    if (state === 'DOWN') {
      const record = downtimeCore.createDowntime({
        id: ids.sequentialId('DT', repository.nextSequence('downtime')),
        stationId: station.id,
        reasonCode: random.weighted(DOWNTIME_WEIGHTS.filter(([c]) => c !== 'CHANGEOVER')),
        reportedBy: random.pick(OPERATORS),
        startedAt: new Date(now.getTime() - random.int(60, 900) * 1000).toISOString()
      }, now);
      repository.put('downtimes', record);
      repository.put('stationStates', {
        ...repository.get('stationStates', station.id),
        openDowntimeId: record.id
      });
    }
  }

  // If nothing drew maintenance, service the most overdue station - which is
  // what a maintenance planner would be doing - so the plant always opens with
  // live maintenance work to look at.
  const anyInMaintenance = repository
    .all('stationStates')
    .some((s) => controlCore.controlOf(s).mode === controlCore.CONTROL_MODES.MAINTENANCE);

  if (!anyInMaintenance) {
    const candidate = repository
      .all('stationStates')
      .filter((s) => s.state !== 'DOWN' && !controlCore.isLocked(s))
      .map((s) => ({ state: s, pm: controlCore.pmStatus(s) }))
      .sort((a, b) => b.pm.usedPct - a.pm.usedPct)[0];

    if (candidate) {
      operations.startMaintenance(candidate.state.stationId, {
        type: 'PREVENTIVE',
        technician: random.pick(TECHNICIANS),
        plannedMinutes: 20,
        note: `PM overdue at ${candidate.pm.usedPct}% of interval`
      }, new Date(now.getTime() - random.int(3, 12) * 60000));
    }
  }
}

/**
 * Completed maintenance history, so a station's maintenance tab has a record
 * to show on first load. Written directly with back-dated timestamps, through
 * the same core functions the live path uses.
 */
function seedMaintenanceHistory({ repository, random, now, days }) {
  let created = 0;

  for (const station of ALL_STATIONS) {
    const count = random.int(0, Math.max(1, days));
    for (let index = 0; index < count; index += 1) {
      const type = random.weighted([['PREVENTIVE', 6], ['CORRECTIVE', 3], ['PREDICTIVE', 1]]);
      const startedAt = new Date(now.getTime() - random.int(6, days * 24) * 3600000);
      const technician = random.pick(TECHNICIANS);

      let order = controlCore.createMaintenanceOrder({
        id: ids.sequentialId('MWO', repository.nextSequence('maintenance')),
        stationId: station.id,
        type,
        technician,
        plannedMinutes: controlCore.MAINTENANCE_TYPES[type].defaultMinutes
      }, startedAt);

      const minutes = order.plannedMinutes * random.float(0.75, 1.45);
      const checklist = order.checklist
        .map((item) => item.task)
        .filter(() => random.chance(0.93));

      order = controlCore.completeMaintenanceOrder(order, {
        technician,
        findings: random.pick(MAINTENANCE_FINDINGS[type]),
        checklist
      }, new Date(startedAt.getTime() + minutes * 60000));

      repository.put('maintenanceOrders', order);
      created += 1;
    }
  }
  return created;
}

const MAINTENANCE_FINDINGS = Object.freeze({
  PREVENTIVE: [
    'All checks within limits', 'Minor wear noted, within tolerance',
    'Consumables replaced to schedule', 'Lubrication topped up, no defects found'
  ],
  PREDICTIVE: [
    'Vibration trend elevated; bearing replaced early',
    'Thermal scan showed hot connector; re-terminated'
  ],
  CORRECTIVE: [
    'Servo amplifier replaced', 'Proximity sensor replaced and re-aligned',
    'Pneumatic valve rebuilt', 'Broken cable carrier link replaced'
  ]
});

function bumpOrder(repository, workOrderId, delta) {
  const workOrder = repository.get('workOrders', workOrderId);
  if (!workOrder) return;
  repository.put('workOrders', {
    ...workOrder,
    quantityStarted: workOrder.quantityStarted + 1,
    quantityCompleted: workOrder.quantityCompleted + (delta.completed || 0),
    quantityScrapped: workOrder.quantityScrapped + (delta.scrapped || 0)
  });
}

module.exports = { seedPlant, OPERATORS, INSPECTORS, TECHNICIANS };
