'use strict';

/**
 * HTTP middleware.
 *
 * Small, explicit and dependency-light. The two that matter operationally:
 *
 *  - `errorHandler` translates the domain error taxonomy into HTTP. Because
 *    every domain error carries a `status` and a stable `code`, the mapping is
 *    mechanical and no route ever needs a try/catch.
 *  - `apiKeyAuth` protects writes only. Reads stay open so the hosted demo is
 *    browsable without credentials, which is the point of a portfolio piece.
 */

const crypto = require('crypto');
const config = require('../../config');
const { DomainError, UnauthorizedError } = require('../../core/errors');
const { createLogger } = require('../../logger');

const log = createLogger('http');

/** Attach a correlation id to every request and echo it back. */
function requestId(req, res, next) {
  req.id = req.get('x-request-id') || crypto.randomUUID();
  res.set('x-request-id', req.id);
  next();
}

/** One structured log line per request, emitted on completion. */
function requestLogger(req, res, next) {
  const startedAt = process.hrtime.bigint();
  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - startedAt) / 1e6;
    const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'debug';
    log[level]('request', {
      id: req.id,
      method: req.method,
      path: req.originalUrl.split('?')[0],
      status: res.statusCode,
      ms: Number(ms.toFixed(1))
    });
  });
  next();
}

/**
 * API-key authentication for state-changing requests.
 *
 * Accepts the key in `x-api-key` or as a bearer token. Comparison is
 * constant-time so the endpoint does not leak key material through timing.
 */
function apiKeyAuth(req, res, next) {
  const isRead = ['GET', 'HEAD', 'OPTIONS'].includes(req.method);
  if (isRead && !config.security.protectReads) return next();

  const presented = req.get('x-api-key')
    || (req.get('authorization') || '').replace(/^Bearer\s+/i, '');

  if (!presented) {
    return next(new UnauthorizedError(
      'This endpoint changes plant state and requires an API key. ' +
      'Send it as the x-api-key header.'
    ));
  }

  const expected = config.security.apiKey;
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  const ok = a.length === b.length && crypto.timingSafeEqual(a, b);

  if (!ok) return next(new UnauthorizedError('The supplied API key is not valid'));

  req.authenticated = true;
  return next();
}

/**
 * Per-client limit on state-changing requests.
 *
 * The hosted demo's API key is published, so the key alone does not stop a
 * script hammering the plant. A fixed one-minute window per client IP is
 * enough for that. It runs before authentication, so guessing keys is limited
 * too. The counts live in this process - on a host running several instances
 * it is a brake per instance, not a global quota.
 */
let rateWindowStart = 0;
const writesInWindow = new Map();

function writeRateLimit(req, res, next) {
  const limit = config.security.writesPerMinute;
  if (!limit || ['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();

  const now = Date.now();
  const windowStart = now - (now % 60000);
  if (windowStart !== rateWindowStart) {
    // A new window: every count from the last one is stale, so drop them all
    // rather than letting the map grow with every client ever seen.
    rateWindowStart = windowStart;
    writesInWindow.clear();
  }

  const client = req.ip || 'unknown';
  const count = (writesInWindow.get(client) || 0) + 1;
  writesInWindow.set(client, count);

  res.set('RateLimit-Limit', String(limit));
  res.set('RateLimit-Remaining', String(Math.max(0, limit - count)));
  if (count <= limit) return next();

  const retryAfterSeconds = Math.ceil((windowStart + 60000 - now) / 1000);
  res.set('Retry-After', String(retryAfterSeconds));
  return res.status(429).json({
    error: {
      code: 'RATE_LIMITED',
      message: `More than ${limit} state-changing requests in a minute from this client. ` +
        `Try again in ${retryAfterSeconds} s.`,
      details: { limit, retryAfterSeconds }
    },
    requestId: req.id
  });
}

/**
 * Wrap an async route so a rejected promise reaches the error handler.
 * Express 4 does not do this on its own.
 */
const asyncHandler = (handler) => (req, res, next) =>
  Promise.resolve(handler(req, res, next)).catch(next);

/** Parse and clamp pagination and sorting from the query string. */
function pagination(req, _res, next) {
  const limit = Number.parseInt(req.query.limit, 10);
  const offset = Number.parseInt(req.query.offset, 10);
  req.page = {
    limit: Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 500) : undefined,
    offset: Number.isFinite(offset) ? Math.max(offset, 0) : 0,
    sort: typeof req.query.sort === 'string' ? req.query.sort : undefined,
    order: req.query.order === 'asc' ? 'asc' : 'desc'
  };
  next();
}

/** 404 for anything that fell through the route table. */
function notFound(req, res) {
  res.status(404).json({
    error: {
      code: 'ROUTE_NOT_FOUND',
      message: `No route matches ${req.method} ${req.originalUrl}`,
      details: { hint: 'The full API surface is documented at /api-docs' }
    }
  });
}

/**
 * Terminal error handler.
 *
 * Domain errors carry their own status and code. Anything else is a genuine
 * bug and is reported as a 500 with the stack withheld in production.
 */
function errorHandler(error, req, res, _next) {
  if (error instanceof DomainError) {
    return res.status(error.status).json({
      ...error.toJSON(),
      requestId: req.id
    });
  }

  if (error?.type === 'entity.parse.failed') {
    return res.status(400).json({
      error: { code: 'MALFORMED_JSON', message: 'The request body is not valid JSON' },
      requestId: req.id
    });
  }

  log.error('unhandled error', {
    id: req.id,
    path: req.originalUrl,
    error: error?.message,
    stack: error?.stack?.split('\n').slice(0, 4).join(' | ')
  });

  return res.status(500).json({
    error: {
      code: 'INTERNAL_ERROR',
      message: 'An unexpected error occurred while processing the request',
      ...(config.isProduction ? {} : { details: { message: error?.message } })
    },
    requestId: req.id
  });
}

module.exports = {
  requestId,
  requestLogger,
  apiKeyAuth,
  writeRateLimit,
  asyncHandler,
  pagination,
  notFound,
  errorHandler
};
