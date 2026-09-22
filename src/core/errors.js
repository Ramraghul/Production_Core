'use strict';

/**
 * Domain error taxonomy.
 *
 * The API layer maps `status` straight onto the HTTP response and `code` into
 * the machine-readable error body, so callers can branch on a stable string
 * instead of parsing prose.
 */

class DomainError extends Error {
  /**
   * @param {string} code    stable SCREAMING_SNAKE identifier
   * @param {string} message human-readable explanation
   * @param {number} status  HTTP status the API layer should use
   * @param {object} [details] extra machine-readable context
   */
  constructor(code, message, status = 400, details = undefined) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.status = status;
    if (details !== undefined) this.details = details;
    if (Error.captureStackTrace) Error.captureStackTrace(this, this.constructor);
  }

  toJSON() {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details ? { details: this.details } : {})
      }
    };
  }
}

class NotFoundError extends DomainError {
  constructor(entity, id) {
    super('NOT_FOUND', `${entity} '${id}' was not found`, 404, { entity, id });
  }
}

class ValidationError extends DomainError {
  constructor(message, details) {
    super('VALIDATION_FAILED', message, 400, details);
  }
}

/** Raised when an operation is legal in general but not from the current state. */
class StateTransitionError extends DomainError {
  constructor(entity, id, from, to, reason) {
    super(
      'INVALID_STATE_TRANSITION',
      reason || `${entity} '${id}' cannot move from ${from} to ${to}`,
      409,
      { entity, id, from, to }
    );
  }
}

class ConflictError extends DomainError {
  constructor(message, details) {
    super('CONFLICT', message, 409, details);
  }
}

class UnauthorizedError extends DomainError {
  constructor(message = 'A valid API key is required for this operation') {
    super('UNAUTHORIZED', message, 401);
  }
}

/** Raised when a quality gate refuses to pass a unit downstream. */
class QualityHoldError extends DomainError {
  constructor(vin, station, defects) {
    super(
      'QUALITY_HOLD',
      `Unit ${vin} is held at ${station} by ${defects.length} open defect(s)`,
      409,
      { vin, station, defects }
    );
  }
}

module.exports = {
  DomainError,
  NotFoundError,
  ValidationError,
  StateTransitionError,
  ConflictError,
  UnauthorizedError,
  QualityHoldError
};
