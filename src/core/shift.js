'use strict';

/**
 * Shift calendar.
 *
 * OEE is meaningless without a time window, and the window that a plant
 * actually reports on is the shift. Everything here answers one of two
 * questions: "which shift is it right now?" and "what was the planned busy
 * time for that shift?".
 *
 * Times are handled in the site timezone (America/Toronto) via Intl rather
 * than a date library, so there is no dependency and DST is still correct.
 */

const { SHIFTS } = require('./plantModel');
const config = require('../config');

const SHIFT_BY_ID = new Map(SHIFTS.map((s) => [s.id, s]));

/**
 * Local wall-clock parts of an instant, in the site timezone.
 * @param {Date} date
 * @param {string} [timeZone]
 */
/**
 * Intl.DateTimeFormat instances are expensive to construct - far more than to
 * use - and a plant-wide OEE calculation asks for local time twice per
 * station. Building a fresh one per call made this the single largest cost of
 * the dashboard, so formatters are cached per timezone.
 */
const FORMATTERS = new Map();

function formatterFor(timeZone) {
  let formatter = FORMATTERS.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false
    });
    FORMATTERS.set(timeZone, formatter);
  }
  return formatter;
}

function localParts(date, timeZone = config.site.timezone) {
  const parts = formatterFor(timeZone).formatToParts(date).reduce((acc, p) => {
    if (p.type !== 'literal') acc[p.type] = p.value;
    return acc;
  }, {});
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    // Intl renders midnight as "24" in some locales; normalise it.
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    second: Number(parts.second),
    dateKey: `${parts.year}-${parts.month}-${parts.day}`
  };
}

/**
 * Which shift is running at `date`.
 * Shift C wraps past midnight, which is why the comparison is split.
 * @returns {object} the shift definition
 */
function shiftAt(date = new Date()) {
  const { hour } = localParts(date);
  for (const shift of SHIFTS) {
    const wraps = shift.endHour <= shift.startHour;
    const inside = wraps
      ? hour >= shift.startHour || hour < shift.endHour
      : hour >= shift.startHour && hour < shift.endHour;
    if (inside) return shift;
  }
  return SHIFTS[0];
}

/**
 * Start and end instants of the shift containing `date`.
 * @returns {{shift:object, start:Date, end:Date, dateKey:string}}
 */
function shiftWindow(date = new Date()) {
  const shift = shiftAt(date);
  const parts = localParts(date);
  const wraps = shift.endHour <= shift.startHour;

  // Build the start instant by walking back from `date` to the shift start.
  const hoursIntoShift = wraps && parts.hour < shift.endHour
    ? parts.hour + (24 - shift.startHour)
    : parts.hour - shift.startHour;

  const minutesIntoShift = hoursIntoShift * 60 + parts.minute;
  // Subtract the millisecond remainder as well, so a window starts exactly on
  // the boundary (14:00:00.000) rather than wherever the clock happened to be.
  const start = new Date(
    date.getTime() - minutesIntoShift * 60000 - parts.second * 1000 - date.getMilliseconds()
  );
  const lengthHours = wraps
    ? (24 - shift.startHour) + shift.endHour
    : shift.endHour - shift.startHour;
  const end = new Date(start.getTime() + lengthHours * 3600000);

  return {
    shift,
    start,
    end,
    lengthHours,
    dateKey: localParts(start).dateKey
  };
}

/**
 * Planned busy time in seconds - shift length minus scheduled breaks.
 * This is the denominator of OEE availability per ISO 22400-2.
 */
function plannedBusySeconds(shift, lengthHours) {
  const hours = lengthHours ?? (shift.endHour <= shift.startHour
    ? (24 - shift.startHour) + shift.endHour
    : shift.endHour - shift.startHour);
  return Math.max(0, hours * 3600 - shift.breakMinutes * 60);
}

/** Seconds elapsed within the current shift, clamped to the shift length. */
function elapsedInShift(date = new Date()) {
  const { start, end } = shiftWindow(date);
  return Math.max(0, Math.min(
    Math.round((date.getTime() - start.getTime()) / 1000),
    Math.round((end.getTime() - start.getTime()) / 1000)
  ));
}

/**
 * The N most recent shift windows, newest first.
 *
 * The current (partially elapsed) shift is included by default, because both
 * callers want it: the trend chart needs a "so far today" bar, and the demo
 * seeder needs to backfill the shift the visitor is actually looking at.
 * Pass `includeCurrent: false` for the last N *completed* shifts.
 *
 * @param {number} count
 * @param {Date} [from]
 * @param {{includeCurrent?: boolean}} [options]
 * @returns {Array<{shift:object, start:Date, end:Date, lengthHours:number, dateKey:string}>}
 */
function recentShifts(count = 6, from = new Date(), options = {}) {
  const includeCurrent = options.includeCurrent !== false;
  const windows = [];
  let cursor = shiftWindow(from).start;

  if (includeCurrent) {
    windows.push(shiftWindow(from));
  }

  while (windows.length < count) {
    cursor = new Date(cursor.getTime() - 1000); // step into the previous shift
    const window = shiftWindow(cursor);
    windows.push(window);
    cursor = window.start;
  }
  return windows;
}

/** Stable key for a shift instance, e.g. "2026-09-16-A". */
const shiftKey = (window) => `${window.dateKey}-${window.shift.id}`;

const getShift = (id) => SHIFT_BY_ID.get(id) || null;
const listShifts = () => SHIFTS.slice();

/** Is a maintenance window open? Night shift runs PM on the equipment. */
const isMaintenanceWindow = (date = new Date()) => Boolean(shiftAt(date).maintenanceWindow);

module.exports = {
  SHIFTS,
  localParts,
  shiftAt,
  shiftWindow,
  plannedBusySeconds,
  elapsedInShift,
  recentShifts,
  shiftKey,
  getShift,
  listShifts,
  isMaintenanceWindow
};
