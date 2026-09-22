'use strict';

/**
 * Minimal structured logger.
 *
 * Deliberately dependency-free: the whole point of this project is that it
 * boots on a clean host with nothing but Node. Output is newline-delimited
 * JSON in production (so it is grep/jq-able in a PaaS log drain) and a compact
 * human-readable line in development.
 */

const config = require('./config');

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };

const ESC = String.fromCharCode(27);
const COLOURS = {
  debug: `${ESC}[90m`,
  info: `${ESC}[36m`,
  warn: `${ESC}[33m`,
  error: `${ESC}[31m`
};
const RESET = `${ESC}[0m`;

const threshold = () => LEVELS[config.logging.level] ?? LEVELS.info;

function format(value) {
  if (value === null || value === undefined) return String(value);
  if (typeof value === 'object') {
    try { return JSON.stringify(value); } catch (_e) { return '[object]'; }
  }
  return String(value);
}

function emit(level, scope, message, fields) {
  if (LEVELS[level] < threshold()) return;

  const record = {
    time: new Date().toISOString(),
    level,
    scope,
    msg: message,
    ...(fields || {})
  };

  if (config.isProduction) {
    process.stdout.write(`${JSON.stringify(record)}\n`);
    return;
  }

  const colour = COLOURS[level] || '';
  const extras = fields && Object.keys(fields).length
    ? ` ${Object.entries(fields).map(([k, v]) => `${k}=${format(v)}`).join(' ')}`
    : '';
  const stamp = record.time.slice(11, 23);
  process.stdout.write(
    `${colour}${stamp} ${level.toUpperCase().padEnd(5)}${RESET} ` +
    `[${scope}] ${message}${extras}\n`
  );
}

/**
 * @param {string} scope short subsystem name shown in every line, e.g. "api".
 */
function createLogger(scope) {
  return {
    debug: (msg, fields) => emit('debug', scope, msg, fields),
    info: (msg, fields) => emit('info', scope, msg, fields),
    warn: (msg, fields) => emit('warn', scope, msg, fields),
    error: (msg, fields) => emit('error', scope, msg, fields),
    child: (sub) => createLogger(`${scope}:${sub}`)
  };
}

module.exports = { createLogger, LEVELS };
