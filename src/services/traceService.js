'use strict';

/**
 * Traceability and recall analysis.
 *
 * This is the capability that justifies an MES to a finance department. When a
 * supplier reports a bad batch, the question is "which vehicles have it, and
 * where are they now?" - and the difference between answering that in seconds
 * and answering it in weeks is the difference between recalling 40 vehicles
 * and recalling 40,000.
 *
 * Two directions:
 *   forward  - lot / serial -> affected VINs   (a recall)
 *   backward - VIN -> everything inside it     (a warranty investigation)
 */

const genealogyCore = require('../core/genealogy');
const unitCore = require('../core/unit');
const bomCore = require('../core/bom');
const { getStation } = require('../core/plantModel');
const { EVENT_TYPES } = require('./eventBus');
const { NotFoundError, ValidationError } = require('../core/errors');
const { createLogger } = require('../logger');

const log = createLogger('trace');

/** Where a vehicle is, for the purposes of a containment decision. */
const CONTAINMENT_ZONES = Object.freeze({
  IN_PLANT: 'IN_PLANT',        // still on the line - stop it now, cheapest fix
  FINISHED_GOODS: 'FINISHED_GOODS', // in the yard - rework before it ships
  SHIPPED: 'SHIPPED',          // gone - this is the expensive column
  SCRAPPED: 'SCRAPPED'
});

class TraceService {
  constructor(repository, eventBus) {
    this.repo = repository;
    this.bus = eventBus;
  }

  /**
   * Forward trace: which vehicles contain a suspect lot or serial?
   *
   * @param {object} query
   * @param {string} [query.lotCode]     supplier batch code
   * @param {string} [query.serial]      sub-assembly serial
   * @param {string} [query.partNumber]  every vehicle containing this part
   * @param {string} [query.reason]      why the query was run (audited)
   * @returns {object} recall report
   */
  recall(query, now = new Date()) {
    if (!query?.lotCode && !query?.serial && !query?.partNumber) {
      throw new ValidationError(
        'A recall query requires one of lotCode, serial or partNumber',
        { query }
      );
    }

    let vins;
    if (query.lotCode) {
      // O(1) via the lot index - this is the whole point of maintaining it.
      vins = this.repo.vinsForLot(query.lotCode);
    } else if (query.serial) {
      const vin = this.repo.vinForSerial(query.serial);
      vins = vin ? [vin] : [];
    } else {
      // Part-number queries must scan, since a part number is not indexed:
      // it appears in thousands of vehicles and an index would not narrow it.
      vins = this.repo
        .all('genealogies')
        .filter((g) => genealogyCore.partNumbers(g).includes(query.partNumber))
        .map((g) => g.vin);
    }

    const affected = vins
      .map((vin) => this.#affectedUnit(vin, query, now))
      .filter(Boolean)
      .sort((a, b) => a.containment.localeCompare(b.containment));

    const byContainment = affected.reduce((acc, unit) => {
      acc[unit.containment] = (acc[unit.containment] || 0) + 1;
      return acc;
    }, {});

    const part = query.partNumber
      || affected[0]?.matches[0]?.id
      || null;
    const partMaster = part && part.startsWith('PN-')
      ? (() => { try { return bomCore.getPart(part); } catch (_e) { return null; } })()
      : null;

    const report = {
      query: {
        lotCode: query.lotCode || null,
        serial: query.serial || null,
        partNumber: query.partNumber || null,
        reason: query.reason || null
      },
      executedAt: now.toISOString(),
      affectedCount: affected.length,
      byContainment: {
        [CONTAINMENT_ZONES.IN_PLANT]: byContainment[CONTAINMENT_ZONES.IN_PLANT] || 0,
        [CONTAINMENT_ZONES.FINISHED_GOODS]: byContainment[CONTAINMENT_ZONES.FINISHED_GOODS] || 0,
        [CONTAINMENT_ZONES.SHIPPED]: byContainment[CONTAINMENT_ZONES.SHIPPED] || 0,
        [CONTAINMENT_ZONES.SCRAPPED]: byContainment[CONTAINMENT_ZONES.SCRAPPED] || 0
      },
      supplier: partMaster?.supplier || null,
      safetyCritical: Boolean(partMaster?.safetyCritical),
      // Vehicles still in the plant can be stopped before they ship, which is
      // the only cheap outcome available once a bad lot is confirmed.
      containableNow: (byContainment[CONTAINMENT_ZONES.IN_PLANT] || 0)
        + (byContainment[CONTAINMENT_ZONES.FINISHED_GOODS] || 0),
      estimatedRecallCostCad: this.#estimateCost(affected, partMaster),
      affected,
      recommendation: this.#recommend(affected, byContainment, partMaster)
    };

    this.bus.publish(EVENT_TYPES.RECALL_QUERY, {
      query: report.query,
      affectedCount: report.affectedCount,
      byContainment: report.byContainment
    }, { source: 'trace' });

    log.info('recall query executed', {
      ...report.query, affected: report.affectedCount
    });

    return report;
  }

  #affectedUnit(vin, query, now = new Date()) {
    const genealogy = this.repo.get('genealogies', vin);
    if (!genealogy) return null;

    const matches = genealogyCore.locate(genealogy, {
      lotCode: query.lotCode,
      serial: query.serial,
      partNumber: query.partNumber
    });
    if (!matches.length) return null;

    const unit = this.repo.get('units', vin);
    return {
      vin,
      modelCode: unit?.modelCode || genealogy.modelCode,
      modelName: unit?.modelName || null,
      colour: unit?.colour || null,
      workOrderId: genealogy.workOrderId,
      status: unit?.status || 'UNKNOWN',
      currentStation: unit?.currentStation || null,
      currentLine: unit?.currentLine || null,
      builtAt: unit?.completedAt || null,
      containment: this.#containmentOf(unit, now),
      matches: matches.map((m) => ({
        level: m.level,
        type: m.type,
        id: m.id,
        description: m.description,
        lotCode: m.lotCode,
        installedAt: m.installedAt,
        installedOn: m.installedOn,
        parentId: m.parentId,
        safetyCritical: m.safetyCritical
      }))
    };
  }

  /**
   * Where a vehicle is, judged at `now` - the clock the query was run with,
   * not the wall clock. Reading Date.now() here made the answer depend on when
   * the code ran rather than on the data, and a recall replayed for an audit
   * must give the answer it gave at the time.
   */
  #containmentOf(unit, now) {
    if (!unit) return CONTAINMENT_ZONES.SHIPPED;
    if (unit.status === 'SCRAPPED') return CONTAINMENT_ZONES.SCRAPPED;
    if (unit.status === 'COMPLETED') {
      // Anything released more than 24h ago is assumed to have left the yard.
      const age = now.getTime() - Date.parse(unit.releasedAt || unit.completedAt || 0);
      return age > 86400000 ? CONTAINMENT_ZONES.SHIPPED : CONTAINMENT_ZONES.FINISHED_GOODS;
    }
    return CONTAINMENT_ZONES.IN_PLANT;
  }

  /**
   * Rough cost model. Deliberately simple and clearly labelled as an estimate -
   * its job is to make the in-plant / shipped split feel consequential on the
   * dashboard, not to be a warranty accrual.
   */
  #estimateCost(affected, partMaster) {
    const partCost = partMaster?.unitCostCad || 150;
    const rates = {
      [CONTAINMENT_ZONES.IN_PLANT]: partCost + 120,          // swap on-line
      [CONTAINMENT_ZONES.FINISHED_GOODS]: partCost + 380,    // pull from yard
      [CONTAINMENT_ZONES.SHIPPED]: partCost + 1450,          // dealer campaign
      [CONTAINMENT_ZONES.SCRAPPED]: 0
    };
    return Number(
      affected.reduce((sum, unit) => sum + (rates[unit.containment] || 0), 0).toFixed(2)
    );
  }

  #recommend(affected, byContainment, partMaster) {
    if (!affected.length) {
      return { action: 'NO_ACTION', rationale: 'No vehicles contain the queried lot or serial' };
    }
    const shipped = byContainment[CONTAINMENT_ZONES.SHIPPED] || 0;
    const inPlant = byContainment[CONTAINMENT_ZONES.IN_PLANT] || 0;

    if (partMaster?.safetyCritical && shipped > 0) {
      return {
        action: 'SAFETY_RECALL',
        rationale: `${shipped} vehicle(s) with a safety-critical part have shipped; notify Transport Canada and open a field campaign`,
        containNow: inPlant
      };
    }
    if (shipped > 0) {
      return {
        action: 'FIELD_CAMPAIGN',
        rationale: `${shipped} vehicle(s) have shipped; a dealer service campaign is required for those, contain the remaining ${inPlant} on-line`,
        containNow: inPlant
      };
    }
    return {
      action: 'CONTAIN_IN_PLANT',
      rationale: `All ${affected.length} affected vehicle(s) are still under plant control; hold and rework before release`,
      containNow: inPlant
    };
  }

  /**
   * Backward trace: the full as-built record of one vehicle.
   * This is what a dealer or a warranty analyst opens.
   */
  vehicleTrace(vin) {
    const genealogy = this.repo.get('genealogies', vin);
    if (!genealogy) throw new NotFoundError('Genealogy', vin);

    const unit = this.repo.get('units', vin);
    const defects = this.repo.all('defects').filter((d) => d.vin === vin);
    const inspections = this.repo.all('inspections').filter((i) => i.subject === vin);
    const subAssemblies = this.repo.all('subAssemblies').filter((s) => s.consumedByVin === vin);
    const flattened = genealogyCore.flatten(genealogy);

    return {
      vin,
      unit: unit ? unitCore.summarise(unit) : null,
      builtAt: unit?.completedAt || null,
      buildMinutes: unit?.buildMinutes ?? null,
      genealogy: {
        components: genealogy.components,
        flattened,
        stats: genealogyCore.stats(genealogy),
        sealedAt: genealogy.sealedAt
      },
      subAssemblies: subAssemblies.map((s) => ({
        serial: s.serial,
        classCode: s.classCode,
        description: s.description,
        builtAt: s.builtAt,
        builtOn: s.completedAt,
        installedAt: s.consumedAtStation,
        testResults: s.testResults
      })),
      quality: {
        inspections: inspections.map((i) => ({
          id: i.id, planId: i.planId, stationId: i.stationId,
          passed: i.passed, inspectedAt: i.inspectedAt
        })),
        defects: defects.map((d) => ({
          id: d.id, code: d.code, severity: d.severity, status: d.status,
          stationId: d.stationId, disposition: d.disposition, suspectLotCode: d.suspectLotCode
        })),
        firstPass: unit ? unitCore.isFirstPass(unit) : null
      },
      route: unit?.history.map((visit) => ({
        stationId: visit.stationId,
        stationName: visit.stationName,
        lineId: visit.lineId,
        enteredAt: visit.enteredAt,
        exitedAt: visit.exitedAt,
        cycleSeconds: visit.cycleSeconds,
        result: visit.result,
        operator: visit.operator
      })) || [],
      suppliers: [...new Set(flattened.map((r) => r.supplier).filter(Boolean))],
      lotCodes: genealogy.lotIndex,
      materialCostCad: bomCore.genealogyCost(genealogy)
    };
  }

  /**
   * Where a specific lot was consumed across the plant - which stations, over
   * what period. Answers "when did we start using the bad batch?".
   */
  lotUsage(lotCode) {
    const vins = this.repo.vinsForLot(lotCode);
    if (!vins.length) {
      return { lotCode, vinCount: 0, firstUsedAt: null, lastUsedAt: null, stations: [], vins: [] };
    }

    const usages = [];
    for (const vin of vins) {
      const genealogy = this.repo.get('genealogies', vin);
      if (!genealogy) continue;
      genealogyCore
        .locate(genealogy, { lotCode })
        .forEach((row) => usages.push({ vin, ...row }));
    }

    const timestamps = usages.map((u) => Date.parse(u.installedOn)).filter(Number.isFinite);
    const byStation = usages.reduce((acc, usage) => {
      acc[usage.installedAt] = (acc[usage.installedAt] || 0) + 1;
      return acc;
    }, {});

    return {
      lotCode,
      partNumber: usages[0]?.id || null,
      description: usages[0]?.description || null,
      supplier: usages[0]?.supplier || null,
      safetyCritical: Boolean(usages[0]?.safetyCritical),
      vinCount: vins.length,
      consumptionCount: usages.length,
      firstUsedAt: timestamps.length ? new Date(Math.min(...timestamps)).toISOString() : null,
      lastUsedAt: timestamps.length ? new Date(Math.max(...timestamps)).toISOString() : null,
      stations: Object.entries(byStation).map(([stationId, count]) => ({
        stationId,
        stationName: getStation(stationId)?.name || stationId,
        lineId: getStation(stationId)?.lineId || null,
        count
      })),
      vins
    };
  }

  /** Every lot the plant has consumed, newest first. Powers the recall picker. */
  listLots(query = {}) {
    const lots = this.repo.knownLots().map((lotCode) => {
      const vins = this.repo.vinsForLot(lotCode);
      const [supplier, ...rest] = lotCode.split('-');
      return {
        lotCode,
        supplier,
        partNumber: rest.slice(0, -1).join('-') || null,
        vinCount: vins.length
      };
    });

    const filtered = lots.filter((lot) =>
      (!query.supplier || lot.supplier === query.supplier)
      && (!query.partNumber || lot.partNumber === query.partNumber));

    const sorted = filtered.sort((a, b) => b.vinCount - a.vinCount);
    return {
      items: sorted.slice(0, query.limit ?? 100),
      total: sorted.length
    };
  }
}

module.exports = { TraceService, CONTAINMENT_ZONES };
