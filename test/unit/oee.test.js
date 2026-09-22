'use strict';

const oee = require('../../src/core/oee');

describe('OEE calculation (ISO 22400-2)', () => {
  it('computes availability, performance, quality and their product', () => {
    const result = oee.calculateOee({
      plannedBusySeconds: 28800,   // 8 h
      downtimeSeconds: 2880,       // 10% unplanned stop
      totalCount: 400,
      goodCount: 392,
      idealCycleSeconds: 60
    });

    expect(result.availability).toBe(90);
    expect(result.performance).toBe(92.59);   // 400 x 60 / 25920
    expect(result.quality).toBe(98);
    expect(result.oee).toBeCloseTo(90 * 0.9259 * 0.98, 0);
  });

  it('subtracts planned downtime from the denominator, not just the numerator', () => {
    // A planned stop should not hurt availability; an unplanned one should.
    const planned = oee.calculateOee({
      plannedBusySeconds: 28800, plannedDowntimeSeconds: 3600, downtimeSeconds: 0,
      totalCount: 100, goodCount: 100, idealCycleSeconds: 60
    });
    const unplanned = oee.calculateOee({
      plannedBusySeconds: 28800, plannedDowntimeSeconds: 0, downtimeSeconds: 3600,
      totalCount: 100, goodCount: 100, idealCycleSeconds: 60
    });

    expect(planned.availability).toBe(100);
    expect(unplanned.availability).toBe(87.5);
  });

  it('caps performance at 100% and warns that the cycle time is wrong', () => {
    // 200 units of 60 s in one hour is physically impossible; the master data
    // is wrong, and letting it through would silently inflate plant OEE.
    const result = oee.calculateOee({
      plannedBusySeconds: 3600, downtimeSeconds: 0,
      totalCount: 200, goodCount: 200, idealCycleSeconds: 60
    });

    expect(result.performance).toBe(100);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0].code).toBe('PERFORMANCE_CAPPED');
  });

  it('produces a loss waterfall that sums back to net planned time', () => {
    const result = oee.calculateOee({
      plannedBusySeconds: 26400, downtimeSeconds: 2520,
      totalCount: 390, goodCount: 378, idealCycleSeconds: 60
    });

    expect(result.losses.accountedSeconds).toBe(result.inputs.netPlannedSeconds);
  });

  it('caps the waterfall with performance, so it still balances and agrees with OEE', () => {
    // 900 units at a 60 s cycle in 398 minutes of run time is 226% performance.
    const result = oee.calculateOee({
      plannedBusySeconds: 26400, downtimeSeconds: 2520,
      totalCount: 900, goodCount: 873, idealCycleSeconds: 60
    });
    const l = result.losses;

    expect(result.performance).toBe(100);
    expect(l.valueAddingSeconds).toBeLessThanOrEqual(result.inputs.actualProductionSeconds);
    expect(l.performanceLossSeconds).toBe(0);
    expect(l.accountedSeconds).toBe(result.inputs.netPlannedSeconds);
    // Value-adding share of planned time is the OEE itself.
    expect((l.valueAddingSeconds / result.inputs.netPlannedSeconds) * 100).toBeCloseTo(result.oee, 1);
  });

  it('returns zeroes rather than NaN for an idle station', () => {
    const result = oee.calculateOee({
      plannedBusySeconds: 0, downtimeSeconds: 0,
      totalCount: 0, goodCount: 0, idealCycleSeconds: 60
    });

    expect(result.oee).toBe(0);
    expect(Number.isNaN(result.availability)).toBe(false);
    expect(Number.isNaN(result.performance)).toBe(false);
  });

  it('rejects impossible inputs', () => {
    expect(() => oee.calculateOee({
      plannedBusySeconds: 3600, totalCount: 10, goodCount: 20, idealCycleSeconds: 60
    })).toThrow(/goodCount cannot exceed totalCount/);

    expect(() => oee.calculateOee({
      plannedBusySeconds: -1, totalCount: 0, goodCount: 0, idealCycleSeconds: 60
    })).toThrow(/non-negative/);
  });

  it('bands OEE against the world-class benchmark', () => {
    expect(oee.rate(0.90)).toBe('WORLD_CLASS');
    expect(oee.rate(0.75)).toBe('GOOD');
    expect(oee.rate(0.62)).toBe('ACCEPTABLE');
    expect(oee.rate(0.40)).toBe('NEEDS_ATTENTION');
  });
});

describe('line roll-up', () => {
  const stations = [
    { stationId: 'A', availability: 95, performance: 96, quality: 99 },
    { stationId: 'B', availability: 82, performance: 88, quality: 97 },
    { stationId: 'C', availability: 97, performance: 99, quality: 99.5 }
  ];

  it('takes availability and performance from the constraint, not the average', () => {
    const line = oee.rollUpLine(stations);

    // B is the constraint: 0.82 x 0.88 is the lowest product.
    expect(line.constraintStation).toBe('B');
    expect(line.availability).toBe(82);
    expect(line.performance).toBe(88);
  });

  it('compounds quality along the route, so the line is worse than any station', () => {
    const line = oee.rollUpLine(stations);
    const worstStationQuality = Math.min(...stations.map((s) => s.quality));

    expect(line.quality).toBeLessThan(worstStationQuality);
    expect(line.quality).toBeCloseTo(0.99 * 0.97 * 0.995 * 100, 1);
  });

  it('handles a line with no stations', () => {
    expect(oee.rollUpLine([]).oee).toBe(0);
  });
});

describe('throughput and yield', () => {
  it('computes JPH and takt adherence', () => {
    const result = oee.throughput(378, 28800, 60);

    expect(result.jph).toBe(47.25);
    expect(result.targetJph).toBe(60);
    expect(result.actualTaktSeconds).toBe(76.2);
    // Adherence is computed from the unrounded takt (28800 / 378 = 76.1904),
    // not from the rounded display value, so rounding error does not compound.
    expect(result.taktAdherencePct).toBe(78.8);
  });

  it('reports rolled throughput yield below every individual station', () => {
    // Forty stations at 99% each is only 67% overall - the number that
    // surprises people, and the reason RTY is worth reporting at all.
    expect(oee.rolledThroughputYield(Array(40).fill(0.99))).toBeCloseTo(66.9, 1);
    expect(oee.rolledThroughputYield([])).toBeNull();
  });

  it('computes first pass yield and defects per unit', () => {
    const result = oee.firstPassYield(82, 100);
    expect(result.fpyPct).toBe(82);
    expect(result.defectsPerUnit).toBe(0.18);
  });

  it('returns null FPY when nothing was produced', () => {
    expect(oee.firstPassYield(0, 0).fpyPct).toBeNull();
  });
});

describe('six sigma metrics', () => {
  it('computes DPMO from defects, units and opportunities', () => {
    expect(oee.dpmo(12, 390, 43)).toBe(716);
    expect(oee.dpmo(0, 100, 43)).toBe(0);
    expect(oee.dpmo(5, 0, 43)).toBeNull();
  });

  it('maps DPMO to a sigma level with the conventional 1.5-sigma shift', () => {
    // 6210 DPMO is the textbook 4-sigma point; 233 is 5-sigma.
    expect(oee.sigmaLevel(6210)).toBeCloseTo(4.0, 1);
    expect(oee.sigmaLevel(233)).toBeCloseTo(5.0, 1);
    expect(oee.sigmaLevel(0)).toBe(6);
  });
});
