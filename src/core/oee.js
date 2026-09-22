'use strict';

/**
 * OEE and the surrounding KPI set, per ISO 22400-2.
 *
 *   Availability = Actual Production Time / Planned Busy Time
 *   Performance  = (Ideal Cycle Time x Total Count) / Actual Production Time
 *   Quality      = Good Count / Total Count
 *   OEE          = Availability x Performance x Quality
 *
 * Two details separate a real implementation from a wrong one:
 *
 *  - Performance must be capped at 1.0. If a station reports more output than
 *    its ideal cycle time allows, the cycle time is wrong, not the station -
 *    letting it exceed 100% silently hides a bad master-data value and inflates
 *    plant OEE. We cap and flag it.
 *
 *  - Good Count is units that passed FIRST time. Counting reworked units as
 *    good turns the quality factor into a measure of how good the repair shop
 *    is, which is not what anyone wants to know.
 */

const { ValidationError } = require('./errors');

/** World-class benchmarks used to colour-code the HMI. */
const BENCHMARKS = Object.freeze({
  WORLD_CLASS: 0.85,
  GOOD: 0.70,
  ACCEPTABLE: 0.60
});

const clamp01 = (value) => Math.max(0, Math.min(1, value));
const pct = (value) => Number((value * 100).toFixed(2));

/**
 * Compute OEE for one station or line over one time window.
 *
 * @param {object} input
 * @param {number} input.plannedBusySeconds  shift length minus planned breaks
 * @param {number} input.downtimeSeconds     unplanned stop time in the window
 * @param {number} input.plannedDowntimeSeconds  planned stops inside the window
 * @param {number} input.totalCount          units produced (good + bad)
 * @param {number} input.goodCount           units that passed first time
 * @param {number} input.idealCycleSeconds   the station's rated cycle time
 * @returns {object} full KPI record
 */
function calculateOee(input) {
  const {
    plannedBusySeconds = 0,
    downtimeSeconds = 0,
    plannedDowntimeSeconds = 0,
    totalCount = 0,
    goodCount = 0,
    idealCycleSeconds = 0
  } = input || {};

  if (plannedBusySeconds < 0 || downtimeSeconds < 0 || totalCount < 0 || goodCount < 0) {
    throw new ValidationError('OEE inputs must be non-negative', input);
  }
  if (goodCount > totalCount) {
    throw new ValidationError('goodCount cannot exceed totalCount', { goodCount, totalCount });
  }

  // Planned busy time excludes planned stops; ISO 22400 calls this APT's parent.
  const netPlannedSeconds = Math.max(0, plannedBusySeconds - plannedDowntimeSeconds);
  const actualProductionSeconds = Math.max(0, netPlannedSeconds - downtimeSeconds);

  const availability = netPlannedSeconds > 0
    ? clamp01(actualProductionSeconds / netPlannedSeconds)
    : 0;

  const theoreticalRunSeconds = idealCycleSeconds * totalCount;
  const rawPerformance = actualProductionSeconds > 0
    ? theoreticalRunSeconds / actualProductionSeconds
    : 0;
  // A raw value above 1 means the master-data cycle time is too slow.
  const performanceCapped = rawPerformance > 1.0001;
  const performance = clamp01(rawPerformance);

  const quality = totalCount > 0 ? clamp01(goodCount / totalCount) : 0;
  const oee = availability * performance * quality;

  return {
    availability: pct(availability),
    performance: pct(performance),
    quality: pct(quality),
    oee: pct(oee),
    // TEEP measures OEE against all 24 hours, not just scheduled time - the
    // "what could this asset do if we ran it flat out" number.
    teep: plannedBusySeconds > 0
      ? pct(oee * (netPlannedSeconds / 86400))
      : 0,
    rating: rate(oee),
    inputs: {
      plannedBusySeconds,
      plannedDowntimeSeconds,
      downtimeSeconds,
      netPlannedSeconds,
      actualProductionSeconds,
      totalCount,
      goodCount,
      badCount: totalCount - goodCount,
      idealCycleSeconds
    },
    losses: losses({
      netPlannedSeconds,
      actualProductionSeconds,
      theoreticalRunSeconds,
      totalCount,
      goodCount
    }),
    warnings: performanceCapped
      ? [{
          code: 'PERFORMANCE_CAPPED',
          message:
            `Reported output implies ${pct(rawPerformance)}% performance, which is ` +
            'physically impossible. Either the ideal cycle time of ' +
            `${idealCycleSeconds}s is wrong for this station, or the window is ` +
            'short enough that a burst of output has outrun the average.'
        }]
      : []
  };
}

/**
 * Break the shift down into where the time actually went, in seconds.
 * This is the waterfall a CI team reads top to bottom.
 */
function losses({
  netPlannedSeconds,
  actualProductionSeconds,
  theoreticalRunSeconds,
  totalCount,
  goodCount
}) {
  const availabilityLoss = Math.max(0, netPlannedSeconds - actualProductionSeconds);
  // Ideal run time cannot exceed the time the station actually ran. When the
  // reported output implies otherwise (performance capped), the waterfall is
  // capped with it - or value-adding time would exceed the shift itself.
  const effectiveRun = Math.min(theoreticalRunSeconds, actualProductionSeconds);
  const performanceLoss = Math.max(0, actualProductionSeconds - effectiveRun);
  const qualityLoss = totalCount > 0 ? (effectiveRun * (totalCount - goodCount)) / totalCount : 0;
  const valueAdding = Math.max(0, effectiveRun - qualityLoss);

  return {
    availabilityLossSeconds: Math.round(availabilityLoss),
    performanceLossSeconds: Math.round(performanceLoss),
    qualityLossSeconds: Math.round(qualityLoss),
    valueAddingSeconds: Math.round(valueAdding),
    // Sanity anchor: these should sum back to net planned time.
    accountedSeconds: Math.round(availabilityLoss + performanceLoss + qualityLoss + valueAdding)
  };
}

/** Benchmark label for an OEE fraction (0..1). */
function rate(oeeFraction) {
  if (oeeFraction >= BENCHMARKS.WORLD_CLASS) return 'WORLD_CLASS';
  if (oeeFraction >= BENCHMARKS.GOOD) return 'GOOD';
  if (oeeFraction >= BENCHMARKS.ACCEPTABLE) return 'ACCEPTABLE';
  return 'NEEDS_ATTENTION';
}

/**
 * Roll station-level OEE up to a line.
 *
 * A line does NOT average its stations' OEE - the line can only run as fast as
 * its constraint, so availability and performance are taken from the
 * bottleneck, while quality compounds along the route (each station's yield
 * multiplies, because a defect at any station spoils the unit).
 *
 * @param {Array<object>} stationOees results of calculateOee, each with `stationId`
 */
function rollUpLine(stationOees) {
  if (!stationOees.length) {
    return { availability: 0, performance: 0, quality: 0, oee: 0, rating: 'NEEDS_ATTENTION', stationCount: 0 };
  }

  // The constraint is the station with the worst availability x performance.
  const constraint = stationOees.reduce((worst, s) => {
    const score = (s.availability / 100) * (s.performance / 100);
    const worstScore = (worst.availability / 100) * (worst.performance / 100);
    return score < worstScore ? s : worst;
  });

  const availability = constraint.availability / 100;
  const performance = constraint.performance / 100;
  // Rolled throughput yield: multiply each station's first-pass quality.
  const quality = stationOees.reduce((product, s) => product * (s.quality / 100), 1);
  const oee = availability * performance * quality;

  return {
    availability: pct(availability),
    performance: pct(performance),
    quality: pct(quality),
    oee: pct(oee),
    rating: rate(oee),
    stationCount: stationOees.length,
    constraintStation: constraint.stationId || null,
    worstQualityStation: stationOees
      .reduce((worst, s) => (s.quality < worst.quality ? s : worst))
      .stationId || null
  };
}

/**
 * Throughput metrics.
 * @param {number} goodCount
 * @param {number} windowSeconds
 * @param {number} taktSeconds  the demand pace the line is supposed to hold
 */
function throughput(goodCount, windowSeconds, taktSeconds) {
  const hours = windowSeconds / 3600;
  const jph = hours > 0 ? goodCount / hours : 0;
  const actualTakt = goodCount > 0 ? windowSeconds / goodCount : null;

  return {
    goodCount,
    windowSeconds,
    jph: Number(jph.toFixed(2)),
    targetJph: taktSeconds ? Number((3600 / taktSeconds).toFixed(2)) : null,
    actualTaktSeconds: actualTakt ? Number(actualTakt.toFixed(1)) : null,
    targetTaktSeconds: taktSeconds ?? null,
    // Above 100% means the line is beating its demand pace.
    taktAdherencePct: taktSeconds && actualTakt
      ? Number(((taktSeconds / actualTakt) * 100).toFixed(1))
      : null
  };
}

/**
 * First pass yield across a set of units.
 * @param {number} firstPassCount units that never failed or were reworked
 * @param {number} totalCount
 */
function firstPassYield(firstPassCount, totalCount) {
  return {
    firstPassCount,
    totalCount,
    fpyPct: totalCount > 0 ? Number(((firstPassCount / totalCount) * 100).toFixed(2)) : null,
    defectsPerUnit: totalCount > 0
      ? Number(((totalCount - firstPassCount) / totalCount).toFixed(4))
      : null
  };
}

/**
 * Rolled throughput yield - the probability a unit clears every station clean.
 * Always lower than any individual station's yield, which is exactly the point:
 * 40 stations at 99% each is only 67% RTY.
 * @param {Array<number>} stationYields as fractions (0..1)
 */
function rolledThroughputYield(stationYields) {
  if (!stationYields.length) return null;
  return Number((stationYields.reduce((product, y) => product * y, 1) * 100).toFixed(2));
}

/** Defects per million opportunities - the Six Sigma unit. */
function dpmo(defectCount, unitCount, opportunitiesPerUnit) {
  const opportunities = unitCount * opportunitiesPerUnit;
  if (opportunities <= 0) return null;
  return Math.round((defectCount / opportunities) * 1e6);
}

/** Approximate sigma level from DPMO (with the conventional 1.5-sigma shift). */
function sigmaLevel(dpmoValue) {
  if (dpmoValue === null || dpmoValue <= 0) return 6;
  const defectRate = dpmoValue / 1e6;
  if (defectRate >= 1) return 0;
  // Inverse-normal approximation (Acklam), adequate for a dashboard tile.
  const z = inverseNormal(1 - defectRate);
  return Number(Math.max(0, z + 1.5).toFixed(2));
}

/** Acklam's rational approximation of the inverse normal CDF. */
function inverseNormal(p) {
  const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02,
    1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
  const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02,
    6.680131188771972e+01, -1.328068155288572e+01];
  const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00,
    -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
  const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00,
    3.754408661907416e+00];
  const pLow = 0.02425;
  const pHigh = 1 - pLow;

  if (p < pLow) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5])
      / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > pHigh) {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5])
      / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  const q = p - 0.5;
  const r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q
    / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

module.exports = {
  BENCHMARKS,
  calculateOee,
  rollUpLine,
  rate,
  throughput,
  firstPassYield,
  rolledThroughputYield,
  dpmo,
  sigmaLevel
};
