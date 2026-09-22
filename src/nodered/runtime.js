'use strict';

/**
 * Embedded Node-RED runtime.
 *
 * Node-RED runs inside this process rather than as a separate service, which
 * buys three things:
 *
 *   1. one port, so the flows, the API, the HMI and Swagger all deploy to a
 *      free tier that exposes a single TCP port
 *   2. the custom nodes call the domain services directly - no HTTP hop, no
 *      second copy of the state
 *   3. one lifecycle: the flows come up and go down with the application
 */

const fs = require('fs');
const path = require('path');
const RED = require('node-red');
const { buildSettings } = require('./settings');
const { setContext } = require('../context');
const config = require('../config');
const { createLogger } = require('../logger');

const log = createLogger('node-red');

class NodeRedRuntime {
  /**
   * @param {object} ctx application context
   */
  constructor(ctx) {
    this.ctx = ctx;
    this.started = false;
    this.settings = null;
  }

  /**
   * Initialise the runtime against an HTTP server and Express app.
   *
   * @param {import('http').Server} server
   * @param {import('express').Express} app
   */
  init(server, app) {
    if (!config.nodeRed.enabled) {
      log.info('node-red runtime disabled by configuration');
      return;
    }

    // Custom nodes reach the services through this, so it must be registered
    // before the runtime loads any node module.
    setContext(this.ctx);

    // The flows reference ${PC_MQTT_HOST} and ${PC_MQTT_PORT}. Those may never
    // have been set explicitly - config resolves its own defaults - so write
    // the resolved values back into the environment before Node-RED reads the
    // flow file. Without this the broker config substitutes to an empty string
    // and every mqtt node comes up disconnected.
    process.env.PC_MQTT_HOST = String(config.mqtt.host);
    process.env.PC_MQTT_PORT = String(config.mqtt.port);
    // The MQTT command channel checks commands against the same key as the
    // REST API, read in the flow with env.get('PC_API_KEY').
    process.env.PC_API_KEY = String(config.security.apiKey);

    this.#ensureUserDir();
    this.#ensureFlowFile();

    this.settings = buildSettings(this.ctx);
    RED.init(server, this.settings);

    app.use(config.nodeRed.httpAdminRoot, RED.httpAdmin);
    app.use(config.nodeRed.httpNodeRoot, RED.httpNode);

    log.info('node-red initialised', {
      editor: config.nodeRed.httpAdminRoot,
      httpNodes: config.nodeRed.httpNodeRoot,
      flows: path.relative(config.rootDir, config.nodeRed.flowFile)
    });
  }

  /** @returns {Promise<void>} */
  async start() {
    if (!config.nodeRed.enabled) return;
    await RED.start();
    this.started = true;

    const flowCount = RED.nodes.getFlows()?.flows?.length ?? 0;
    log.info('node-red flows running', {
      nodes: flowCount,
      editorUrl: `http://localhost:${config.http.port}${config.nodeRed.httpAdminRoot}`
    });
  }

  /** @returns {Promise<void>} */
  async stop() {
    if (!this.started) return;
    await RED.stop();
    this.started = false;
  }

  /** Runtime status, surfaced through GET /api/v1/health. */
  status() {
    if (!config.nodeRed.enabled) return { enabled: false };
    let flows = null;
    try {
      flows = RED.nodes.getFlows();
    } catch (_error) { /* runtime not started yet */ }

    return {
      enabled: true,
      running: this.started,
      editorPath: config.nodeRed.httpAdminRoot,
      httpNodeRoot: config.nodeRed.httpNodeRoot,
      readOnly: config.security.editorReadOnly,
      nodeCount: flows?.flows?.length ?? 0,
      revision: flows?.rev ?? null
    };
  }

  #ensureUserDir() {
    fs.mkdirSync(config.nodeRed.userDir, { recursive: true });
  }

  /**
   * Node-RED will happily start with no flow file and show an empty canvas,
   * which on a fresh deployment looks like a broken build. Fail loudly with an
   * actionable message instead.
   */
  #ensureFlowFile() {
    if (fs.existsSync(config.nodeRed.flowFile)) return;
    throw new Error(
      `Flow file not found at ${config.nodeRed.flowFile}.\n` +
      'Flows are generated from flows/plant.spec.js - run `npm run build:flows` ' +
      'to create them, then start the application again.'
    );
  }
}

module.exports = { NodeRedRuntime, RED };
