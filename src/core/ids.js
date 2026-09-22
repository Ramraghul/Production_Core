'use strict';

/**
 * Identifier generation for the plant.
 *
 * VINs are not random strings: they follow ISO 3779 / FMVSS 565, including the
 * position-9 check digit. That means a VIN produced here validates against any
 * off-the-shelf VIN decoder, which is the point - traceability data that does
 * not survive contact with a real system is not traceability data.
 *
 *   pos  1-3   WMI  world manufacturer identifier  ("2NS" - 2 = built in Canada)
 *   pos  4-8   VDS  vehicle descriptor  (model / body / restraint / powertrain)
 *   pos  9     check digit  (computed, 0-9 or X)
 *   pos 10     model year code
 *   pos 11     assembly plant code  ("W" = Windsor)
 *   pos 12-17  sequential production number
 */

const { ValidationError } = require('./errors');

// I, O and Q are excluded from VINs to avoid confusion with 1 and 0.
const VIN_ALPHABET = 'ABCDEFGHJKLMNPRSTUVWXYZ0123456789';

const TRANSLITERATION = {
  A: 1, B: 2, C: 3, D: 4, E: 5, F: 6, G: 7, H: 8,
  J: 1, K: 2, L: 3, M: 4, N: 5, P: 7, R: 9,
  S: 2, T: 3, U: 4, V: 5, W: 6, X: 7, Y: 8, Z: 9
};

const WEIGHTS = [8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2];

// ISO 3779 model-year codes. The letters skip I, O, Q, U, Z and the digit 0.
const YEAR_CODES = 'ABCDEFGHJKLMNPRSTVWXY123456789';

/**
 * Model-year character for a calendar year. The 30-character cycle repeats
 * every 30 years; 2010 maps to 'A', which anchors the whole table.
 * @param {number} year e.g. 2026
 * @returns {string} single character
 */
function modelYearCode(year) {
  const offset = ((year - 2010) % 30 + 30) % 30;
  return YEAR_CODES[offset];
}

/**
 * Compute the ISO 3779 check digit for a 17-character VIN.
 * The character currently at position 9 is ignored, so this works on both a
 * complete VIN (to verify) and a template with a placeholder (to fill in).
 *
 * @param {string} vin 17 characters
 * @returns {string} '0'-'9' or 'X'
 */
function vinCheckDigit(vin) {
  if (typeof vin !== 'string' || vin.length !== 17) {
    throw new ValidationError('A VIN must be exactly 17 characters', { vin });
  }
  const upper = vin.toUpperCase();
  let sum = 0;
  for (let i = 0; i < 17; i += 1) {
    if (i === 8) continue; // position 9 is the check digit itself
    const ch = upper[i];
    const value = /[0-9]/.test(ch) ? Number(ch) : TRANSLITERATION[ch];
    if (value === undefined) {
      throw new ValidationError(`Character '${ch}' is not valid in a VIN`, { vin, position: i + 1 });
    }
    sum += value * WEIGHTS[i];
  }
  const remainder = sum % 11;
  return remainder === 10 ? 'X' : String(remainder);
}

/**
 * True when `vin` is structurally valid and its check digit agrees.
 * @param {string} vin
 * @returns {boolean}
 */
function isValidVin(vin) {
  if (typeof vin !== 'string' || vin.length !== 17) return false;
  const upper = vin.toUpperCase();
  if (/[IOQ]/.test(upper)) return false;
  if (![...upper].every((c) => VIN_ALPHABET.includes(c))) return false;
  try {
    return vinCheckDigit(upper) === upper[8];
  } catch (_err) {
    return false;
  }
}

/**
 * Build a complete, check-digit-correct VIN.
 *
 * @param {object} opts
 * @param {string} opts.wmi        3 chars, defaults to '2NS' (Canada / NorthStar)
 * @param {string} opts.vds        5 chars describing the model
 * @param {number} opts.year       model year, e.g. 2026
 * @param {string} opts.plantCode  1 char
 * @param {number} opts.sequence   production number, zero-padded to 6 digits
 * @returns {string} 17-character VIN
 */
function buildVin({ wmi = '2NS', vds, year, plantCode = 'W', sequence }) {
  if (!vds || vds.length !== 5) {
    throw new ValidationError('VDS must be exactly 5 characters', { vds });
  }
  if (!Number.isInteger(sequence) || sequence < 0 || sequence > 999999) {
    throw new ValidationError('VIN sequence must be an integer in 0..999999', { sequence });
  }
  const serial = String(sequence).padStart(6, '0');
  const draft = `${wmi}${vds}0${modelYearCode(year)}${plantCode}${serial}`;
  const check = vinCheckDigit(draft);
  return `${draft.slice(0, 8)}${check}${draft.slice(9)}`;
}

/**
 * Decode the structural fields of a VIN. Does not look anything up - it only
 * splits the string according to ISO 3779.
 * @param {string} vin
 */
function decodeVin(vin) {
  if (!isValidVin(vin)) throw new ValidationError('Invalid VIN', { vin });
  const upper = vin.toUpperCase();
  return {
    vin: upper,
    wmi: upper.slice(0, 3),
    countryOfManufacture: upper[0] === '2' ? 'Canada' : 'Other',
    vds: upper.slice(3, 8),
    checkDigit: upper[8],
    modelYearCode: upper[9],
    plantCode: upper[10],
    sequence: Number(upper.slice(11)),
    valid: true
  };
}

/**
 * Serial number for a serialised sub-assembly or component.
 * Format: <PREFIX>-<YYDDD>-<SEQ6>   e.g. ENG-26259-000412
 * The Julian date makes shift-level lot analysis possible without a join.
 *
 * @param {string} prefix short component class code
 * @param {number} sequence
 * @param {Date} [at]
 */
function buildSerial(prefix, sequence, at = new Date()) {
  const year = String(at.getUTCFullYear()).slice(-2);
  const startOfYear = Date.UTC(at.getUTCFullYear(), 0, 0);
  const dayOfYear = Math.floor((at.getTime() - startOfYear) / 86400000);
  const julian = `${year}${String(dayOfYear).padStart(3, '0')}`;
  return `${prefix}-${julian}-${String(sequence).padStart(6, '0')}`;
}

/**
 * Supplier lot / batch code. Recall analysis pivots on this value.
 * Format: <SUPPLIER>-<PART>-<YYWW><BATCH>   e.g. MAGNA-BRK1042-2637B
 */
function buildLotCode(supplierCode, partNumber, at = new Date(), batchLetter = 'A') {
  const year = String(at.getUTCFullYear()).slice(-2);
  const week = String(isoWeek(at)).padStart(2, '0');
  return `${supplierCode}-${partNumber}-${year}${week}${batchLetter}`;
}

/** ISO-8601 week number (1-53). */
function isoWeek(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
}

/**
 * Monotonic, human-sortable event identifier.
 * Format: <base36 millis>-<counter base36>   e.g. m3k2p9x-1f
 */
let eventCounter = 0;
function eventId() {
  eventCounter = (eventCounter + 1) % 0xffffff;
  return `${Date.now().toString(36)}-${eventCounter.toString(36).padStart(4, '0')}`;
}

/** Generic prefixed identifier, e.g. WO-2026-0007, AND-000123. */
function sequentialId(prefix, sequence, width = 6) {
  return `${prefix}-${String(sequence).padStart(width, '0')}`;
}

/**
 * Deterministic pseudo-random generator (mulberry32).
 *
 * The simulator and the seeder both run off this, so a given PC_SIM_SEED always
 * produces the same plant history. That is what makes the API tests assertable
 * and the hosted demo look identical on every cold start.
 *
 * @param {number} seed
 */
function createRandom(seed = 1) {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  return {
    next,
    /** Uniform integer in [min, max] inclusive. */
    int: (min, max) => Math.floor(next() * (max - min + 1)) + min,
    /** Uniform float in [min, max). */
    float: (min, max) => next() * (max - min) + min,
    /** Uniformly pick one element. */
    pick: (arr) => arr[Math.floor(next() * arr.length)],
    /** True with probability p. */
    chance: (p) => next() < p,
    /**
     * Normal deviate via Box-Muller, clamped to +/-4 sigma so a stray tail
     * value cannot produce a negative cycle time.
     */
    normal: (mean = 0, stdDev = 1) => {
      const u1 = Math.max(next(), Number.EPSILON);
      const u2 = next();
      const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
      return mean + stdDev * Math.max(-4, Math.min(4, z));
    },
    /** Weighted pick. `weighted([['a',3],['b',1]])` returns 'a' 75% of the time. */
    weighted: (pairs) => {
      const total = pairs.reduce((sum, [, w]) => sum + w, 0);
      let roll = next() * total;
      for (const [value, weight] of pairs) {
        roll -= weight;
        if (roll <= 0) return value;
      }
      return pairs[pairs.length - 1][0];
    }
  };
}

module.exports = {
  VIN_ALPHABET,
  modelYearCode,
  vinCheckDigit,
  isValidVin,
  buildVin,
  decodeVin,
  buildSerial,
  buildLotCode,
  isoWeek,
  eventId,
  sequentialId,
  createRandom
};
