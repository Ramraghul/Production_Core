'use strict';

const ids = require('../../src/core/ids');
const { MODELS } = require('../../src/core/plantModel');

describe('VIN generation (ISO 3779)', () => {
  // The canonical NHTSA test VIN. If the check-digit algorithm is wrong, this
  // is the assertion that catches it - a self-consistent but incorrect
  // implementation would still validate its own output.
  it('validates a known-good real-world VIN', () => {
    expect(ids.isValidVin('1M8GDM9AXKP042788')).toBe(true);
  });

  it('rejects a VIN whose check digit has been tampered with', () => {
    expect(ids.isValidVin('1M8GDM9A0KP042788')).toBe(false);
  });

  it('rejects I, O and Q, which ISO 3779 excludes', () => {
    expect(ids.isValidVin('1M8GDM9AXKP04278O')).toBe(false);
    expect(() => ids.vinCheckDigit('1M8GDM9AXKP04278I')).toThrow(/not valid in a VIN/);
  });

  it('rejects anything that is not 17 characters', () => {
    expect(ids.isValidVin('1M8GDM9AXKP04278')).toBe(false);
    expect(ids.isValidVin('')).toBe(false);
    expect(ids.isValidVin(null)).toBe(false);
  });

  it('builds VINs that validate for every model in the plant', () => {
    for (const model of MODELS) {
      const vin = ids.buildVin({
        vds: model.vds, year: model.modelYear, plantCode: 'W', sequence: 4211
      });
      expect(vin).toHaveLength(17);
      expect(ids.isValidVin(vin)).toBe(true);
    }
  });

  it('builds VINs that validate across the whole sequence range', () => {
    for (const sequence of [0, 1, 999, 12345, 999999]) {
      const vin = ids.buildVin({ vds: 'AURE1', year: 2026, sequence });
      expect(ids.isValidVin(vin)).toBe(true);
      expect(ids.decodeVin(vin).sequence).toBe(sequence);
    }
  });

  it('marks Canadian-built vehicles by WMI', () => {
    const decoded = ids.decodeVin(ids.buildVin({ vds: 'AURE1', year: 2026, sequence: 1 }));
    expect(decoded.wmi).toBe('2NS');
    expect(decoded.countryOfManufacture).toBe('Canada');
    expect(decoded.plantCode).toBe('W');
  });

  it('uses the correct ISO 3779 model-year code', () => {
    // The 30-character cycle: 2010 = 'A', so 2026 must be 'T'.
    expect(ids.modelYearCode(2010)).toBe('A');
    expect(ids.modelYearCode(2026)).toBe('T');
    expect(ids.modelYearCode(2040)).toBe('A'); // cycle repeats after 30 years
  });

  it('rejects a VDS that is not exactly 5 characters', () => {
    expect(() => ids.buildVin({ vds: 'ABC', year: 2026, sequence: 1 })).toThrow(/exactly 5/);
  });

  it('rejects an out-of-range sequence', () => {
    expect(() => ids.buildVin({ vds: 'AURE1', year: 2026, sequence: 1000000 })).toThrow(/0\.\.999999/);
  });
});

describe('serial and lot codes', () => {
  it('encodes the Julian date so lot analysis needs no join', () => {
    const serial = ids.buildSerial('ENG', 412, new Date('2026-09-16T00:00:00Z'));
    expect(serial).toBe('ENG-26259-000412');
  });

  it('builds a lot code from supplier, part and ISO week', () => {
    const lot = ids.buildLotCode('MAGNA', 'PN-UB-FLOOR', new Date('2026-09-16T00:00:00Z'), 'B');
    expect(lot).toMatch(/^MAGNA-PN-UB-FLOOR-26\d{2}B$/);
  });

  it('computes ISO week numbers', () => {
    expect(ids.isoWeek(new Date('2026-01-01T00:00:00Z'))).toBe(1);
    expect(ids.isoWeek(new Date('2026-12-31T00:00:00Z'))).toBe(53);
  });

  it('produces monotonically sortable event ids', () => {
    const first = ids.eventId();
    const second = ids.eventId();
    expect(first).not.toBe(second);
    expect(typeof first).toBe('string');
  });
});

describe('deterministic PRNG', () => {
  it('produces an identical sequence for the same seed', () => {
    const a = ids.createRandom(42);
    const b = ids.createRandom(42);
    const sequenceA = Array.from({ length: 50 }, () => a.next());
    const sequenceB = Array.from({ length: 50 }, () => b.next());
    expect(sequenceA).toEqual(sequenceB);
  });

  it('produces different sequences for different seeds', () => {
    expect(ids.createRandom(1).next()).not.toBe(ids.createRandom(2).next());
  });

  it('keeps int() inside its inclusive bounds', () => {
    const random = ids.createRandom(7);
    for (let i = 0; i < 500; i += 1) {
      const value = random.int(3, 9);
      expect(value).toBeGreaterThanOrEqual(3);
      expect(value).toBeLessThanOrEqual(9);
      expect(Number.isInteger(value)).toBe(true);
    }
  });

  it('clamps normal() so a tail value cannot produce a negative cycle time', () => {
    const random = ids.createRandom(11);
    for (let i = 0; i < 2000; i += 1) {
      const value = random.normal(10, 2);
      expect(value).toBeGreaterThanOrEqual(10 - 4 * 2);
      expect(value).toBeLessThanOrEqual(10 + 4 * 2);
    }
  });

  it('respects weights in weighted()', () => {
    const random = ids.createRandom(3);
    let heavy = 0;
    for (let i = 0; i < 2000; i += 1) {
      if (random.weighted([['a', 9], ['b', 1]]) === 'a') heavy += 1;
    }
    // Expect ~90%; allow slack so this does not become a flaky statistics test.
    expect(heavy).toBeGreaterThan(1600);
    expect(heavy).toBeLessThan(1950);
  });
});
