'use strict';

/**
 * Shared helpers for the Production Core custom nodes.
 *
 * Every node follows the same shape, so the boilerplate lives here:
 *   - resolve a property from node config, msg, flow or global
 *   - run an operation, catching domain errors into `msg.error` and node status
 *   - reflect the result in the node's status dot, which is how a flow author
 *     sees what happened without opening the debug sidebar
 */

const { getContext, hasContext } = require('../../src/context');

/** Node-RED status presets. */
const STATUS = {
  idle: (text) => ({ fill: 'grey', shape: 'ring', text: text || 'ready' }),
  ok: (text) => ({ fill: 'green', shape: 'dot', text }),
  busy: (text) => ({ fill: 'blue', shape: 'dot', text: text || 'working' }),
  warn: (text) => ({ fill: 'yellow', shape: 'dot', text }),
  error: (text) => ({ fill: 'red', shape: 'ring', text })
};

/**
 * Resolve a configurable value.
 *
 * Node-RED's typed-input widget stores a value plus its type ('str', 'msg',
 * 'flow', 'global', 'num', ...). This evaluates that pair against the incoming
 * message, falling back to a literal when no type was recorded.
 *
 * @param {object} node
 * @param {object} msg
 * @param {*} value
 * @param {string} type
 * @param {*} [fallback]
 */
function resolve(node, msg, value, type, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  try {
    switch (type) {
      case 'msg': return node.RED.util.getMessageProperty(msg, value) ?? fallback;
      case 'flow': return node.context().flow.get(value) ?? fallback;
      case 'global': return node.context().global.get(value) ?? fallback;
      case 'num': return Number(value);
      case 'bool': return value === true || value === 'true';
      case 'json': return typeof value === 'string' ? JSON.parse(value) : value;
      case 'str':
      default: return value;
    }
  } catch (_error) {
    return fallback;
  }
}

/**
 * Wrap a node operation with consistent error handling and status reporting.
 *
 * Domain errors are NOT thrown into the flow by default. A quality gate that
 * refuses a vehicle is a normal outcome a flow should branch on, not a crash,
 * so the error is attached to `msg.error` and the message continues. Tick
 * "Throw domain errors" on the node to get Node-RED catch-node behaviour.
 *
 * @param {object} node
 * @param {object} msg
 * @param {function} send
 * @param {function} done
 * @param {function} operation receives the app context, returns {payload, status, output}
 */
function run(node, msg, send, done, operation) {
  if (!hasContext()) {
    node.status(STATUS.error('no context'));
    node.error(new Error(
      'Production Core is not initialised. Start the application with `npm start` ' +
      'rather than running Node-RED standalone.'
    ), msg);
    return done();
  }

  try {
    const result = operation(getContext());
    if (result === undefined) {
      node.status(STATUS.idle());
      return done();
    }

    msg.payload = result.payload;
    if (result.extra) Object.assign(msg, result.extra);
    node.status(result.status || STATUS.ok('ok'));

    // A multi-output node returns an `output` index; everything else uses 0.
    if (typeof result.output === 'number') {
      const outputs = [];
      for (let i = 0; i < result.output; i += 1) outputs.push(null);
      outputs.push(msg);
      send(outputs);
    } else {
      send(msg);
    }
    return done();
  } catch (error) {
    const isDomainError = Boolean(error.code && error.status);
    node.status(STATUS.error(error.code || 'error'));

    if (node.throwErrors || !isDomainError) {
      node.error(error, msg);
      return done(error);
    }

    // Expected domain outcome: annotate and pass through so the flow can branch.
    msg.error = {
      code: error.code,
      message: error.message,
      status: error.status,
      details: error.details
    };
    msg.payload = null;
    send(msg);
    return done();
  }
}

/** Register a node type, wiring the common config in one place. */
function register(RED, typeName, constructor) {
  function NodeConstructor(config) {
    RED.nodes.createNode(this, config);
    this.RED = RED;
    this.throwErrors = config.throwErrors === true;
    this.status(STATUS.idle());
    constructor.call(this, config, RED);
  }
  RED.nodes.registerType(typeName, NodeConstructor);
}

module.exports = { STATUS, resolve, run, register };
