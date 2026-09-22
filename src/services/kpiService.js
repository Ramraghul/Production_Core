'use strict';

/**
 * KPI aggregation.
 *
 * Turns the raw event and state data into the numbers a plant actually reports:
 * OEE by station and line, throughput against takt, FPY, WIP and buffer health.
 *
 * Everything is computed on read from the current window rather than
 * incrementally maintained. At plant scale (43 stations, one shift of history)
 * that is microseconds, and it removes an entire class of bug where a cached
 * counter drifts away from the events it was supposed to summarise.
 */

const oeeCore = require('../core/oee');
const unitCore = require('../core/unit');
const downtimeCore = require('../core/downtime');
const shiftCore = require('../core/shift');
const {
  ALL_STATIONS, LINES, getLine, getStation, listStations,
  lineCapacityJph, bottleneckStation, MAIN_STATION_ROUTE
} = require('../core/plantModel');
const { NotFoundError } = require('../core/errors');
const qualityCore = require('../core/quality');
const workOrderCore = require('../core/workOrder');
const config = require('../config');

/**
 * Below this much elapsed time, the current shift is reported as a rolling
 * 8-hour window instead. Twenty minutes is roughly the point at which a
 * 60-second takt line has produced enough vehicles for OEE to be meaningful.
 */
const MIN_SHIFT_WINDOW_SECONDS = 20 * 60;

/** How long a computed dashboard is served to other viewers. */
const DASHBOARD_TTL_MS = 2000;

/** How long a computed shift trend is reused. */
const TREND_TTL_MS = 30000;

/** The window as the API reports it. */
const describeWindow = (window) => ({
  start: window.start.toISOString(),
  end: window.end.toISOString(),
  label: window.label,
  seconds: window.seconds
});

class KpiService {
  /**
   * @param {object} repository
   * @param {object} productionService
   * @param {object} operationsService
   * @param {object} [options] {getSimulatorSpeed} - a getter rather than the
   *   simulator itself, so the KPI layer does not depend on it existing.
   */
  constructor(repository, productionService, operationsService, options = {}) {
    this.repo = repository;
    this.production = productionService;
    this.operations = operationsService;
    this.getSimulatorSpeed = options.getSimulatorSpeed || (() => 1);
    /** Per-window indexes, reused until the repository changes. */
    this.index = { key: null, visits: null, builds: null };
    /** Short-lived result cache for the dashboard. */
    this.dashboardCache = { key: null, at: 0, value: null };
    this.trendCache = null;
  }

  /**
   * Resolve the reporting window. Defaults to the current shift, which is the
   * window every operator screen in a plant is scoped to.
   * @param {object} [options] {since, until, shiftKey}
   */
  #window(options = {}, now = new Date()) {
    if (options.since) {
      const start = new Date(options.since);
      const end = options.until ? new Date(options.until) : now;
      return {
        start,
        end,
        seconds: Math.max(1, Math.round((end - start) / 1000)),
        label: 'custom',
        shift: shiftCore.shiftAt(start)
      };
    }

    const window = shiftCore.shiftWindow(now);
    const end = now < window.end ? now : window.end;
    const elapsed = Math.round((end - window.start) / 1000);

    // A shift that started two minutes ago has produced nothing, and reporting
    // "OEE 0%" for it is arithmetically correct and completely useless. Until
    // the shift has enough elapsed time to mean something, widen to a rolling
    // eight-hour window and say so, which is what a plant dashboard does.
    if (elapsed < MIN_SHIFT_WINDOW_SECONDS) {
      const start = new Date(end.getTime() - 8 * 3600 * 1000);
      return {
        start,
        end,
        seconds: 8 * 3600,
        label: 'rolling-8h',
        rolling: true,
        rollingReason: `${shiftCore.shiftKey(window)} has only been running for ` +
          `${Math.round(elapsed / 60)} min; showing the last 8 hours instead`,
        shift: window.shift,
        shiftLengthHours: window.lengthHours
      };
    }

    return {
      start: window.start,
      end,
      seconds: Math.max(1, elapsed),
      label: shiftCore.shiftKey(window),
      rolling: false,
      shift: window.shift,
      shiftLengthHours: window.lengthHours
    };
  }

  /**
   * OEE for a single station over a window.
   *
   * Counts come from the unit history rather than the station's running
   * counters, because history is scoped to the window while counters are
   * since-boot. `goodCount` is first-pass only.
   */
  stationOee(stationId, options = {}, now = new Date()) {
    const station = getStation(stationId);
    if (!station) throw new NotFoundError('Station', stationId);

    const window = this.#window(options, now);
    const line = getLine(station.lineId);

    // Feeder lines build serialised sub-assemblies, not vehicles, so their
    // output lives in the subAssemblies collection rather than in unit history.
    // Counting only unit visits would report every feeder at 0% forever.
    const isFeeder = line?.kind === 'FEEDER';
    const visits = isFeeder ? [] : this.#visitsAt(stationId, window);
    const builds = isFeeder ? this.#buildsAt(station, window) : [];

    const totalCount = isFeeder ? builds.length : visits.length;
    const goodCount = isFeeder
      ? builds.filter((s) => s.status !== 'QUARANTINED' && s.status !== 'SCRAPPED').length
      : visits.filter((v) => v.result === unitCore.VISIT_RESULTS.PASS).length;

    const downtimes = this.repo.all('downtimes').filter(
      (d) => d.stationId === stationId && this.#overlaps(d, window)
    );
    // Split by the reason code's own OEE classification rather than by
    // planned/unplanned alone. A changeover is planned but is still a setup
    // loss against availability; preventive maintenance and a scheduled break
    // are planned and come out of planned busy time entirely.
    const unplannedSeconds = downtimes
      .filter((d) => d.countsAgainstOee !== false)
      .reduce((sum, d) => sum + this.#overlapSeconds(d, window), 0);
    const plannedSeconds = downtimes
      .filter((d) => d.countsAgainstOee === false)
      .reduce((sum, d) => sum + this.#overlapSeconds(d, window), 0);

    const result = oeeCore.calculateOee({
      plannedBusySeconds: window.seconds,
      plannedDowntimeSeconds: plannedSeconds,
      downtimeSeconds: unplannedSeconds,
      totalCount,
      goodCount,
      idealCycleSeconds: station.cycleSeconds
    });

    const state = this.repo.get('stationStates', stationId);

    return {
      stationId,
      stationName: station.name,
      lineId: station.lineId,
      capability: station.capability,
      window: describeWindow(window),
      state: state?.state || 'UNKNOWN',
      currentVin: state?.currentVin || null,
      ...result,
      throughput: oeeCore.throughput(goodCount, window.seconds, station.taktSeconds),
      avgCycleSeconds: totalCount
        ? Number((visits.reduce((s, v) => s + (v.cycleSeconds || 0), 0) / totalCount).toFixed(1))
        : null,
      downtimeEvents: downtimes.length,
      openStop: downtimes.find(downtimeCore.isOpen)?.reasonCode || null
    };
  }

  /** OEE for a whole line, rolled up from its stations. */
  lineOee(lineId, options = {}, now = new Date()) {
    const line = getLine(lineId);
    if (!line) throw new NotFoundError('Line', lineId);

    const window = this.#window(options, now);
    const stations = listStations(lineId).map((s) => this.stationOee(s.id, options, now));
    const rollup = oeeCore.rollUpLine(stations);

    // Line output is what leaves the LAST station on the line.
    const exitStation = stations[stations.length - 1];
    const goodCount = exitStation?.inputs.goodCount ?? 0;

    return {
      lineId,
      lineName: line.name,
      kind: line.kind,
      areaId: line.area,
      window: describeWindow(window),
      ...rollup,
      taktSeconds: line.taktSeconds,
      capacityJph: lineCapacityJph(lineId),
      designBottleneck: bottleneckStation(lineId)?.id || null,
      throughput: oeeCore.throughput(goodCount, window.seconds, line.taktSeconds),
      wip: this.repo.count('units', (u) => u.currentLine === lineId && !unitCore.isTerminal(u.status)),
      stations: stations.map((s) => ({
        stationId: s.stationId,
        stationName: s.stationName,
        state: s.state,
        oee: s.oee,
        availability: s.availability,
        performance: s.performance,
        quality: s.quality,
        rating: s.rating,
        totalCount: s.inputs.totalCount,
        avgCycleSeconds: s.avgCycleSeconds,
        idealCycleSeconds: s.inputs.idealCycleSeconds,
        openStop: s.openStop
      }))
    };
  }

  /** OEE for every line, plus a plant-level roll-up. */
  plantOee(options = {}, now = new Date()) {
    const window = this.#window(options, now);
    const lines = LINES.map((line) => this.lineOee(line.id, options, now));

    // Plant OEE is driven by the main route, not the feeders - a feeder that
    // is idle because its buffer is full is not a plant loss.
    const mainLines = lines.filter((l) => l.kind === 'MAIN');
    const constraint = mainLines.reduce(
      (worst, l) => (l.oee < worst.oee ? l : worst),
      mainLines[0] || { oee: 0 }
    );

    const completed = this.#completedUnits(window);
    const firstPass = completed.filter(unitCore.isFirstPass).length;

    return {
      site: config.site,
      window: {
        start: window.start.toISOString(),
        end: window.end.toISOString(),
        label: window.label,
        seconds: window.seconds,
        rolling: Boolean(window.rolling),
        rollingReason: window.rollingReason || null,
        shift: window.shift?.id || null,
        shiftName: window.shift?.name || null
      },
      oee: mainLines.length
        ? Number((mainLines.reduce((s, l) => s + l.oee, 0) / mainLines.length).toFixed(2))
        : 0,
      constraintLine: constraint.lineId || null,
      rating: oeeCore.rate(
        (mainLines.reduce((s, l) => s + l.oee, 0) / Math.max(mainLines.length, 1)) / 100
      ),
      throughput: oeeCore.throughput(completed.length, window.seconds, 60),
      firstPassYield: oeeCore.firstPassYield(firstPass, completed.length),
      rolledThroughputYield: oeeCore.rolledThroughputYield(
        MAIN_STATION_ROUTE.map((stationId) => {
          const station = lines
            .flatMap((l) => l.stations)
            .find((s) => s.stationId === stationId);
          return (station?.quality ?? 100) / 100;
        })
      ),
      wip: this.production.workInProgress().length,
      lines: lines.map((l) => ({
        lineId: l.lineId,
        lineName: l.lineName,
        kind: l.kind,
        oee: l.oee,
        availability: l.availability,
        performance: l.performance,
        quality: l.quality,
        rating: l.rating,
        constraintStation: l.constraintStation,
        jph: l.throughput.jph,
        targetJph: l.throughput.targetJph,
        wip: l.wip
      }))
    };
  }

  /**
   * The single screen a plant manager looks at: output vs plan, quality,
   * what is stopped right now, and what is about to starve.
   *
   * Cached for two seconds. Every open HMI polls this, and the calculation is
   * synchronous CPU work on the same event loop as the simulator and the
   * flows - without the cache, each extra viewer steals time from the plant.
   * Nothing on this page changes meaningfully in two seconds.
   */
  dashboard(options = {}, now = new Date()) {
    const key = `${options.since || ''}|${options.until || ''}`;
    const cache = this.dashboardCache;
    if (cache.key === key && now.getTime() - cache.at < DASHBOARD_TTL_MS && now >= cache.at) {
      return cache.value;
    }
    const value = this.#computeDashboard(options, now);
    this.dashboardCache = { key, at: now.getTime(), value };
    return value;
  }

  #computeDashboard(options, now) {
    const window = this.#window(options, now);
    const plant = this.plantOee(options, now);
    const quality = this.#quality(window);
    const stops = this.operations.currentStops();
    const openAndons = this.repo
      .all('andons')
      .filter((a) => ['RAISED', 'ACKNOWLEDGED', 'ESCALATED'].includes(a.status));

    const stationStates = this.repo.all('stationStates');
    const stateCounts = stationStates.reduce((acc, s) => {
      acc[s.state] = (acc[s.state] || 0) + 1;
      return acc;
    }, {});

    // Time compression breaks the relationship between a wall-clock KPI window
    // and the plant's physical takt: at speed N a station appears to cycle N
    // times faster than its ideal, throughput exceeds the line's physical
    // maximum, and OEE pins at 100% behind the performance cap. Say so rather
    // than presenting the inflated figures as real.
    const speed = this.getSimulatorSpeed();
    const timeCompression = speed > 1
      ? {
          active: true,
          speed,
          note: `The simulator is running at ${speed}x real time. Throughput and ` +
            'performance are measured over wall-clock windows, so they are inflated ' +
            `by up to ${speed}x. Set PC_SIM_SPEED=1 for figures that match the takt.`
        }
      : { active: false, speed };

    return {
      generatedAt: now.toISOString(),
      timeCompression,
      window: plant.window,
      headline: {
        oee: plant.oee,
        rating: plant.rating,
        jph: plant.throughput.jph,
        targetJph: plant.throughput.targetJph,
        taktAdherencePct: plant.throughput.taktAdherencePct,
        unitsCompleted: plant.throughput.goodCount,
        fpyPct: plant.firstPassYield.fpyPct,
        rtyPct: plant.rolledThroughputYield,
        wip: plant.wip,
        constraintLine: plant.constraintLine
      },
      quality,
      stations: {
        total: stationStates.length,
        ...stateCounts,
        downNow: stops.length
      },
      andon: {
        open: openAndons.length,
        escalated: openAndons.filter((a) => a.status === 'ESCALATED').length,
        calls: openAndons.slice(0, 10).map((a) => ({
          id: a.id,
          stationId: a.stationId,
          lineId: a.lineId,
          callType: a.callType,
          label: a.label,
          colour: a.colour,
          status: a.status,
          raisedAt: a.raisedAt,
          ageSeconds: Math.round((now - Date.parse(a.raisedAt)) / 1000),
          slaSeconds: a.slaSeconds
        }))
      },
      currentStops: stops.slice(0, 10),
      lines: plant.lines,
      buffers: this.production.bufferLevels(),
      workOrders: this.#workOrderSummary()
    };
  }

  /**
   * Per-shift trend for the last N shifts, oldest first.
   *
   * Reads whichever tier of storage holds that shift: recomputed from unit
   * history for the hot window, or the stored aggregate row for shifts that
   * have already been rolled up. The current shift is truncated at `now`, so a
   * shift that is two hours old is not reported as though it had run eight.
   */
  shiftTrend(count = 6, now = new Date()) {
    // Past shifts never change and the current one moves slowly; recomputing
    // eight shifts of OEE for every viewer's minute-poll is wasted CPU.
    const cache = this.trendCache;
    const age = cache ? now.getTime() - cache.at : Infinity;
    if (cache && cache.count === count && age >= 0 && age < TREND_TTL_MS) {
      return cache.value;
    }
    const value = this.#computeTrend(count, now);
    this.trendCache = { count, at: now.getTime(), value };
    return value;
  }

  #computeTrend(count, now) {
    return shiftCore
      .recentShifts(count, now)
      .map((window) => {
        const key = shiftCore.shiftKey(window);
        const isCurrent = window.end > now;
        const end = isCurrent ? now : window.end;

        const completed = this.#completedUnits({ start: window.start, end });

        // No detail for this shift: fall back to the rolled-up row.
        if (!completed.length) {
          const aggregate = this.repo.get('shiftMetrics', key);
          if (aggregate) {
            return {
              key,
              shift: aggregate.shift,
              shiftName: aggregate.shiftName,
              start: aggregate.start,
              end: aggregate.end,
              source: 'aggregate',
              partial: false,
              oee: aggregate.oee,
              unitsCompleted: aggregate.unitsCompleted,
              jph: aggregate.jph,
              fpyPct: aggregate.fpyPct
            };
          }
        }

        const options = { since: window.start.toISOString(), until: end.toISOString() };
        const plant = this.plantOee(options, end);
        const firstPass = completed.filter(unitCore.isFirstPass).length;

        return {
          key,
          shift: window.shift.id,
          shiftName: window.shift.name,
          start: window.start.toISOString(),
          end: end.toISOString(),
          source: 'detail',
          partial: isCurrent,
          oee: plant.oee,
          unitsCompleted: completed.length,
          jph: plant.throughput.jph,
          fpyPct: completed.length ? Number(((firstPass / completed.length) * 100).toFixed(1)) : null
        };
      })
      .reverse(); // oldest first, so charts read left to right
  }

  #quality(window) {
    const defects = this.repo
      .all('defects')
      .filter((d) => Date.parse(d.createdAt) >= window.start.getTime());
    const completed = this.#completedUnits(window);
    const firstPass = completed.filter(unitCore.isFirstPass).length;
    const dpmoValue = oeeCore.dpmo(defects.length, Math.max(completed.length, 1), ALL_STATIONS.length);

    return {
      defectCount: defects.length,
      openDefects: defects.filter((d) => d.status !== 'CLOSED').length,
      critical: defects.filter((d) => d.severity === 'CRITICAL').length,
      major: defects.filter((d) => d.severity === 'MAJOR').length,
      minor: defects.filter((d) => d.severity === 'MINOR').length,
      fpyPct: completed.length ? Number(((firstPass / completed.length) * 100).toFixed(1)) : null,
      scrapped: this.repo.count('units', (u) =>
        u.status === 'SCRAPPED' && Date.parse(u.updatedAt) >= window.start.getTime()),
      dpmo: dpmoValue,
      sigmaLevel: oeeCore.sigmaLevel(dpmoValue),
      topDefects: qualityCore.pareto(defects, { limit: 5 })
    };
  }

  #workOrderSummary() {
    const orders = this.repo.all('workOrders');
    return {
      total: orders.length,
      inProgress: orders.filter((w) => w.status === 'IN_PROGRESS').length,
      released: orders.filter((w) => w.status === 'RELEASED').length,
      completed: orders.filter((w) => w.status === 'COMPLETED').length,
      active: orders
        .filter((w) => ['RELEASED', 'IN_PROGRESS'].includes(w.status))
        .slice(0, 5)
        .map((w) => ({
          id: w.id,
          modelCode: w.modelCode,
          modelName: w.modelName,
          colour: w.colour,
          priority: w.priority,
          status: w.status,
          ...workOrderCore.progress(w)
        }))
    };
  }

  /**
   * Sub-assemblies that completed at a feeder station inside the window.
   *
   * Every serial passes through every station on its cell's route, so a build
   * counts once at each station on that route - which is what makes a feeder's
   * per-station cycle count comparable to a main line's.
   */
  #buildsAt(station, window) {
    const onLine = this.#indexFor(window).builds.get(station.lineId) || [];
    // SUBASM runs parallel cells; a powertrain never visits the seat cell.
    return station.cell
      ? onLine.filter((sub) => getStation(sub.builtAt)?.cell === station.cell)
      : onLine;
  }

  /**
   * Station visits that CLOSED inside the window.
   *
   * Served from an index built once per window. Scanning every vehicle's
   * history separately for each of 43 stations made a plant-wide calculation
   * 43 full scans; the index makes it one.
   */
  #visitsAt(stationId, window) {
    return this.#indexFor(window).visits.get(stationId) || [];
  }

  /**
   * Visits and feeder builds grouped by station for one window, rebuilt only
   * when the window or the repository contents change.
   */
  #indexFor(window) {
    const key = `${window.start.getTime()}|${window.end.getTime()}|${this.repo.stats.writes}`;
    if (this.index.key === key) return this.index;

    const from = window.start.getTime();
    const to = window.end.getTime();

    const visits = new Map();
    for (const unit of this.repo.all('units')) {
      for (const visit of unit.history) {
        const exited = Date.parse(visit.exitedAt);
        if (exited < from || exited > to) continue;
        if (!visits.has(visit.stationId)) visits.set(visit.stationId, []);
        visits.get(visit.stationId).push(visit);
      }
    }

    const builds = new Map();
    for (const sub of this.repo.all('subAssemblies')) {
      const at = Date.parse(sub.completedAt || sub.createdAt || 0);
      if (at < from || at > to) continue;
      if (!builds.has(sub.builtOnLine)) builds.set(sub.builtOnLine, []);
      builds.get(sub.builtOnLine).push(sub);
    }

    this.index = { key, visits, builds };
    return this.index;
  }

  #completedUnits(window) {
    return this.repo.all('units').filter((u) => {
      if (u.status !== 'COMPLETED' || !u.completedAt) return false;
      const at = Date.parse(u.completedAt);
      return at >= window.start.getTime() && at <= window.end.getTime();
    });
  }

  #overlaps(record, window) {
    const start = Date.parse(record.startedAt);
    const end = record.endedAt ? Date.parse(record.endedAt) : Date.now();
    return end >= window.start.getTime() && start <= window.end.getTime();
  }

  /** Seconds of a downtime record that fall inside the window. */
  #overlapSeconds(record, window) {
    const start = Math.max(Date.parse(record.startedAt), window.start.getTime());
    const end = Math.min(
      record.endedAt ? Date.parse(record.endedAt) : Date.now(),
      window.end.getTime()
    );
    return Math.max(0, Math.round((end - start) / 1000));
  }
}

module.exports = { KpiService };
