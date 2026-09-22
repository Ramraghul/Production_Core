'use strict';

/**
 * The address a request arrived on, and whether that is this machine.
 *
 * Pages that print URLs - the OpenAPI servers, the docs' curl examples - use
 * it to print the address the reader is actually on: localhost when running
 * locally, the live URL when deployed, never a mix of the two.
 */

/** `https://host[:port]` for a request. `trust proxy` makes the scheme right behind a PaaS. */
const requestOrigin = (req) => `${req.protocol}://${req.get('host')}`;

/** True for an address on this machine. */
const isLocalOrigin = (origin) =>
  /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(:\d+)?$/i.test(String(origin).replace(/\/+$/, ''));

module.exports = { requestOrigin, isLocalOrigin };
