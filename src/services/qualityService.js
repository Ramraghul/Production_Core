'use strict';

/**
 * Quality orchestration: inspections, defect lifecycle and gate enforcement.
 *
 * The rule this service exists to enforce is simple and absolute: a unit with
 * an open CRITICAL defect does not move. Everything else here - Pareto charts,
 * FPY, DPMO - is reporting. The gate is the control.
 */

const qualityCore = require('../core/quality');
const unitCore = require('../core/unit');
const { getStation, ALL_STATIONS } = require('../core/plantModel');
const oeeCore = require('../core/oee');
const genealogyCore = require('../core/genealogy');
const ids = require('../core/ids');
const { EVENT_TYPES } = require('./eventBus');
const { NotFoundError, ValidationError } = require('../core/errors');
const { createLogger } = require('../logger');

const log = createLogger('quality');

class QualityService {
  constructor(repository, eventBus, productionService) {
    this.repo = repository;
    this.bus = eventBus;
    this.production = productionService;
  }

  // ---- inspections -------------------------------------------------------

  /**
   * Run an inspection plan and raise a defect for every out-of-spec
   * characteristic. Returns both the inspection record and the defects raised,
   * because the caller (a flow, a test rig) needs to know if it can proceed.
   *
   * @param {object} input {planId, stationId, vin|serial, measurements, inspector}
   */
  recordInspection(input, now = new Date()) {
    if (!input?.planId && !input?.stationId) {
      throw new ValidationError('Either planId or stationId is required');
    }

    const planId = input.planId
      || getStation(input.stationId)?.inspectionPlan;
    if (!planId) {
      throw new ValidationError(
        `Station '${input.stationId}' has no inspection plan`,
        { stationId: input.stationId }
      );
    }

    const result = qualityCore.runInspection(planId, input.measurements, {
      vin: input.vin,
      serial: input.serial,
      stationId: input.stationId,
      inspector: input.inspector
    }, now);

    const record = {
      id: input.id || ids.sequentialId('INSP', this.repo.nextSequence('inspection')),
      ...result
    };
    this.repo.put('inspections', record);

    // Raise one defect per failed characteristic.
    const defects = result.results
      .filter((r) => !r.inSpec)
      .map((failure) => this.raiseDefect({
        code: failure.defectCode,
        vin: input.vin,
        serial: input.serial,
        stationId: record.stationId,
        inspectionId: record.id,
        detectedBy: input.inspector || 'AUTO',
        measurement: {
          characteristicId: failure.characteristicId,
          value: failure.value,
          limits: [failure.lowerLimit, failure.upperLimit],
          deviation: failure.deviation
        }
      }, now));

    this.bus.publish(EVENT_TYPES.INSPECTION_RECORDED, {
      id: record.id,
      planId,
      stationId: record.stationId,
      subject: record.subject,
      passed: record.passed,
      failedCharacteristics: record.failedCharacteristics,
      defectsRaised: defects.map((d) => d.id)
    }, {
      vin: input.vin || null,
      stationId: record.stationId,
      lineId: getStation(record.stationId)?.lineId || null
    });

    return { inspection: record, defects };
  }

  listInspections(query = {}) {
    return this.repo.find('inspections', {
      where: (i) =>
        (!query.stationId || i.stationId === query.stationId)
        && (!query.planId || i.planId === query.planId)
        && (!query.subject || i.subject === query.subject)
        && (query.passed === undefined || i.passed === query.passed),
      sort: 'inspectedAt',
      order: 'desc',
      limit: query.limit ?? 50,
      offset: query.offset
    });
  }

  // ---- defects -----------------------------------------------------------

  /** Raise a defect and attach it to its unit so gates can see it. */
  raiseDefect(input, now = new Date()) {
    const id = input.id || ids.sequentialId('DEF', this.repo.nextSequence('defect'));
    const defect = qualityCore.createDefect({ ...input, id }, now);

    // If the part is lot-controlled, tag the suspect lot at the point of detection.
    if (!defect.suspectLotCode && defect.vin) {
      defect.suspectLotCode = this.#inferSuspectLot(defect);
    }

    this.repo.put('defects', defect);

    if (defect.vin) {
      const unit = this.repo.get('units', defect.vin);
      if (unit) this.repo.put('units', unitCore.addDefect(unit, defect.id));
    }

    this.bus.publish(EVENT_TYPES.DEFECT_RAISED, {
      id: defect.id,
      code: defect.code,
      family: defect.family,
      severity: defect.severity,
      vin: defect.vin,
      serial: defect.serial,
      stationId: defect.stationId,
      suspectLotCode: defect.suspectLotCode
    }, { vin: defect.vin, stationId: defect.stationId, lineId: defect.lineId });

    log.info('defect raised', {
      id: defect.id, code: defect.code, severity: defect.severity, at: defect.stationId
    });
    return defect;
  }

  getDefect(id) {
    const defect = this.repo.get('defects', id);
    if (!defect) throw new NotFoundError('Defect', id);
    return defect;
  }

  listDefects(query = {}) {
    return this.repo.find('defects', {
      where: (d) =>
        (!query.status || d.status === query.status)
        && (!query.severity || d.severity === query.severity)
        && (!query.code || d.code === query.code)
        && (!query.family || d.family === query.family)
        && (!query.vin || d.vin === query.vin)
        && (!query.stationId || d.stationId === query.stationId)
        && (!query.lineId || d.lineId === query.lineId)
        && (query.open === undefined || (d.status !== 'CLOSED') === query.open),
      sort: query.sort || 'createdAt',
      order: query.order || 'desc',
      limit: query.limit ?? 50,
      offset: query.offset
    });
  }

  /**
   * Disposition a defect. When the decision closes it, the defect is detached
   * from the unit so downstream gates stop blocking - and if the decision was
   * SCRAP, the vehicle is scrapped with it.
   */
  dispositionDefect(id, decision, context = {}, now = new Date()) {
    const defect = this.getDefect(id);
    const next = qualityCore.disposition(defect, decision, context, now);
    this.repo.put('defects', next);

    if (next.status === qualityCore.DEFECT_STATES.CLOSED && next.vin) {
      const unit = this.repo.get('units', next.vin);
      if (unit) this.repo.put('units', unitCore.clearDefect(unit, id));
    }

    this.bus.publish(EVENT_TYPES.DEFECT_DISPOSITIONED, {
      id, decision, vin: next.vin, status: next.status, by: next.dispositionedBy
    }, { vin: next.vin, stationId: next.stationId, lineId: next.lineId });

    if (decision === qualityCore.DISPOSITIONS.SCRAP && next.vin) {
      const unit = this.repo.get('units', next.vin);
      if (unit && !unitCore.isTerminal(unit.status)) {
        this.production.scrapUnit(next.vin, `Defect ${id} (${next.code}) dispositioned SCRAP`, context, now);
      }
    }

    return next;
  }

  /** Close a defect after repair verification. */
  closeDefect(id, context = {}, now = new Date()) {
    const defect = this.getDefect(id);
    const verified = defect.status === qualityCore.DEFECT_STATES.IN_REPAIR
      ? qualityCore.transitionDefect(defect, qualityCore.DEFECT_STATES.VERIFIED, context, now)
      : defect;
    const closed = qualityCore.transitionDefect(verified, qualityCore.DEFECT_STATES.CLOSED, context, now);
    this.repo.put('defects', closed);

    if (closed.vin) {
      const unit = this.repo.get('units', closed.vin);
      if (unit) this.repo.put('units', unitCore.clearDefect(unit, id));
    }

    this.bus.publish(EVENT_TYPES.DEFECT_CLOSED, {
      id, vin: closed.vin, code: closed.code, by: closed.closedBy
    }, { vin: closed.vin, stationId: closed.stationId, lineId: closed.lineId });

    return closed;
  }

  // ---- gates -------------------------------------------------------------

  /**
   * Can this unit pass the gate at `stationId`?
   * Pure query - it does not move anything. Flows call this before advancing.
   */
  evaluateGate(vin, stationId) {
    const unit = this.repo.get('units', vin);
    if (!unit) throw new NotFoundError('Unit', vin);

    const station = getStation(stationId);
    const open = this.repo.all('defects').filter((d) => d.vin === vin && d.status !== 'CLOSED');
    const blocking = open.filter(
      (d) => d.severity === 'CRITICAL' || (d.severity === 'MAJOR' && !d.disposition)
    );

    return {
      vin,
      stationId,
      isGate: Boolean(station?.qualityGate),
      pass: blocking.length === 0,
      openDefects: open.length,
      blockingDefects: blocking.map((d) => ({
        id: d.id, code: d.code, severity: d.severity, disposition: d.disposition
      })),
      worstSeverity: qualityCore.worstSeverity(open),
      recommendation: blocking.length === 0
        ? 'RELEASE'
        : blocking.some((d) => d.severity === 'CRITICAL')
          ? 'HOLD_OFFLINE'
          : 'REWORK_IN_STATION'
    };
  }

  // ---- reporting ---------------------------------------------------------

  /**
   * Quality summary for a time window: FPY, Pareto, DPMO and severity mix.
   * @param {object} [options] {since, lineId}
   */
  summary(options = {}) {
    const since = options.since ? Date.parse(options.since) : 0;
    const defects = this.repo.all('defects').filter(
      (d) => Date.parse(d.createdAt) >= since && (!options.lineId || d.lineId === options.lineId)
    );

    const units = this.repo.all('units').filter(
      (u) => u.status === 'COMPLETED' && Date.parse(u.completedAt || 0) >= since
    );
    const firstPass = units.filter(unitCore.isFirstPass).length;

    const oee = oeeCore;
    const opportunitiesPerUnit = ALL_STATIONS.length;
    const dpmoValue = oee.dpmo(defects.length, Math.max(units.length, 1), opportunitiesPerUnit);

    return {
      windowStart: options.since || null,
      lineId: options.lineId || 'ALL',
      unitsCompleted: units.length,
      defectCount: defects.length,
      openDefects: defects.filter((d) => d.status !== 'CLOSED').length,
      firstPassYield: oee.firstPassYield(firstPass, units.length),
      bySeverity: {
        CRITICAL: defects.filter((d) => d.severity === 'CRITICAL').length,
        MAJOR: defects.filter((d) => d.severity === 'MAJOR').length,
        MINOR: defects.filter((d) => d.severity === 'MINOR').length
      },
      byFamily: qualityCore.pareto(defects, { groupBy: 'family', limit: 8 }),
      paretoByCode: qualityCore.pareto(defects, { groupBy: 'code', limit: 10 }),
      paretoByStation: qualityCore.pareto(defects, { groupBy: 'stationId', limit: 10 }),
      dpmo: dpmoValue,
      sigmaLevel: oee.sigmaLevel(dpmoValue),
      dispositionMix: Object.keys(qualityCore.DISPOSITIONS).reduce((acc, key) => {
        const count = defects.filter((d) => d.disposition === key).length;
        if (count) acc[key] = count;
        return acc;
      }, {})
    };
  }

  /**
   * Best-effort link from a defect to the supplier lot most likely responsible.
   *
   * Preference order, narrowest evidence first:
   *   1. a lot-controlled part fitted at the exact station that found it
   *   2. failing that, the most recent safety-critical lot fitted upstream on
   *      the same line - inspection stations consume no parts, so a defect
   *      found at BODY-50 was almost always introduced at BODY-10..40
   *
   * This is a hint for a quality engineer, not a verdict, so it is recorded as
   * `suspectLotCode` and never used to auto-quarantine anything.
   */
  #inferSuspectLot(defect) {
    const genealogy = this.repo.get('genealogies', defect.vin);
    if (!genealogy) return null;

    const rows = genealogyCore.flatten(genealogy).filter((r) => r.lotCode);
    if (!rows.length) return null;

    const atStation = rows.find((row) => row.installedAt === defect.stationId);
    if (atStation) return atStation.lotCode;

    // Fall back to the same line, most recently fitted first, preferring
    // safety-critical parts since those are the ones worth chasing.
    const onLine = rows
      .filter((row) => getStation(row.installedAt)?.lineId === defect.lineId)
      .sort((a, b) => {
        if (a.safetyCritical !== b.safetyCritical) return a.safetyCritical ? -1 : 1;
        return Date.parse(b.installedOn) - Date.parse(a.installedOn);
      });

    return onLine.length ? onLine[0].lotCode : null;
  }
}

module.exports = { QualityService };
