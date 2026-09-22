'use strict';

/**
 * In-process event bus.
 *
 * Everything that happens on the plant floor is published here exactly once,
 * and four consumers fan out from it:
 *
 *   - the repository, which appends it to the event log
 *   - the MQTT broker, which republishes it for the Node-RED flows
 *   - the SSE endpoint, which streams it to the browser HMI
 *   - the KPI engine, which folds it into the running shift counters
 *
 * Publishing is synchronous and never throws: a subscriber that fails must not
 * be able to stall a production line, so errors are logged and swallowed.
 */

const { EventEmitter } = require('events');
const { eventId } = require('../core/ids');
const { createLogger } = require('../logger');

const log = createLogger('events');

/**
 * Canonical event types. Grouped by subject so MQTT topic wildcards are useful
 * (e.g. subscribing to `unit.*` gets every vehicle movement).
 */
const EVENT_TYPES = Object.freeze({
  // Work order
  WORK_ORDER_CREATED: 'workorder.created',
  WORK_ORDER_RELEASED: 'workorder.released',
  WORK_ORDER_UPDATED: 'workorder.updated',
  WORK_ORDER_COMPLETED: 'workorder.completed',

  // Unit / vehicle
  UNIT_CREATED: 'unit.created',
  UNIT_MOVED: 'unit.moved',
  UNIT_HELD: 'unit.held',
  UNIT_REWORK: 'unit.rework',
  UNIT_RELEASED: 'unit.released',
  UNIT_COMPLETED: 'unit.completed',
  UNIT_SCRAPPED: 'unit.scrapped',

  // Sub-assembly
  SUB_BUILT: 'subassembly.built',
  SUB_CONSUMED: 'subassembly.consumed',
  SUB_QUARANTINED: 'subassembly.quarantined',

  // Quality
  INSPECTION_RECORDED: 'quality.inspection',
  DEFECT_RAISED: 'quality.defect.raised',
  DEFECT_DISPOSITIONED: 'quality.defect.dispositioned',
  DEFECT_CLOSED: 'quality.defect.closed',
  GATE_BLOCKED: 'quality.gate.blocked',

  // Station and equipment
  STATION_STATE_CHANGED: 'station.state',
  STATION_CYCLE_COMPLETE: 'station.cycle',
  TELEMETRY: 'station.telemetry',
  STATION_STARTED: 'station.started',
  STATION_STOPPED: 'station.stopped',

  // Maintenance
  MAINTENANCE_STARTED: 'maintenance.started',
  MAINTENANCE_COMPLETED: 'maintenance.completed',

  // Andon and downtime
  ANDON_RAISED: 'andon.raised',
  ANDON_ACKNOWLEDGED: 'andon.acknowledged',
  ANDON_ESCALATED: 'andon.escalated',
  ANDON_RESOLVED: 'andon.resolved',
  DOWNTIME_STARTED: 'downtime.started',
  DOWNTIME_ENDED: 'downtime.ended',

  // System
  SHIFT_CHANGED: 'system.shift',
  SIMULATOR_STATE: 'system.simulator',
  RECALL_QUERY: 'system.recall'
});

/** Severity drives colour on the HMI event feed and MQTT QoS selection. */
const SEVERITY_BY_TYPE = Object.freeze({
  'quality.defect.raised': 'warning',
  'quality.gate.blocked': 'warning',
  'andon.raised': 'warning',
  'andon.escalated': 'error',
  'downtime.started': 'error',
  'unit.scrapped': 'error',
  'subassembly.quarantined': 'warning',
  'andon.resolved': 'success',
  'downtime.ended': 'success',
  'unit.completed': 'success',
  'workorder.completed': 'success',
  'station.stopped': 'warning',
  'station.started': 'success',
  'maintenance.started': 'warning',
  'maintenance.completed': 'success'
});

class EventBus extends EventEmitter {
  constructor() {
    super();
    // A busy plant has many listeners on the wildcard channel; the default
    // limit of 10 would emit spurious leak warnings.
    this.setMaxListeners(64);
    this.published = 0;
  }

  /**
   * Publish a plant event.
   *
   * @param {string} type one of EVENT_TYPES
   * @param {object} payload event-specific body
   * @param {object} [meta] {stationId, lineId, vin, source}
   * @returns {object} the envelope that was published
   */
  publish(type, payload = {}, meta = {}) {
    const envelope = {
      id: eventId(),
      type,
      timestamp: new Date().toISOString(),
      severity: SEVERITY_BY_TYPE[type] || 'info',
      source: meta.source || 'core',
      stationId: meta.stationId ?? payload.stationId ?? null,
      lineId: meta.lineId ?? payload.lineId ?? null,
      vin: meta.vin ?? payload.vin ?? null,
      payload
    };

    this.published += 1;

    // Specific channel, then the firehose. Subscriber failures are contained
    // so one bad consumer cannot take the line down.
    this.#safeEmit(type, envelope);
    this.#safeEmit('*', envelope);

    return envelope;
  }

  /** Subscribe to one event type. @returns {function} unsubscribe */
  on_(type, handler) {
    this.on(type, handler);
    return () => this.off(type, handler);
  }

  /** Subscribe to every event. @returns {function} unsubscribe */
  onAny(handler) {
    this.on('*', handler);
    return () => this.off('*', handler);
  }

  #safeEmit(channel, envelope) {
    for (const listener of this.listeners(channel)) {
      try {
        listener(envelope);
      } catch (error) {
        log.error('event subscriber threw', {
          channel,
          type: envelope.type,
          error: error.message
        });
      }
    }
  }
}

module.exports = { EventBus, EVENT_TYPES, SEVERITY_BY_TYPE };
