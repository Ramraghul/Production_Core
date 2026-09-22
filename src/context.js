'use strict';

/**
 * Process-wide application context holder.
 *
 * Node-RED loads custom nodes through its own module loader, so they cannot be
 * handed the context by constructor injection the way the HTTP layer is. This
 * module is the handshake: the composition root registers the context here at
 * boot, and each custom node reads it on first message.
 *
 * It is a singleton by necessity, not by preference - which is why the getter
 * fails loudly rather than returning undefined. A node that silently gets no
 * context would look like a flow wiring bug, and the operator would go hunting
 * in the editor for a problem that is actually in the boot sequence.
 */

let context = null;

/** Called once by the composition root. */
function setContext(next) {
  context = next;
  return context;
}

/**
 * @returns {object} the application context
 * @throws {Error} when called before the runtime has booted
 */
function getContext() {
  if (!context) {
    throw new Error(
      'Production Core context is not initialised. The custom Node-RED nodes ' +
      'require the application to be started through src/index.js, which builds ' +
      'the service context before the Node-RED runtime loads any nodes.'
    );
  }
  return context;
}

/** True when the context is available. Lets a node degrade instead of throwing. */
const hasContext = () => context !== null;

/** Test helper: drop the context between suites. */
function resetContext() {
  context = null;
}

module.exports = { setContext, getContext, hasContext, resetContext };
