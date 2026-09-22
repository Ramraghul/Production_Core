'use strict';

/**
 * Composition root.
 *
 * Boots every subsystem in dependency order and wires them together:
 *
 *   store + event bus  ->  services  ->  MQTT broker
 *                                    ->  Express (API, Swagger, HMI)
 *                                    ->  Node-RED (flows, custom nodes)
 *                                    ->  simulator
 *
 * Order matters in two places. The MQTT broker must be listening before
 * Node-RED starts, or the flows' mqtt-in nodes come up disconnected and sit
 * retrying. And the application context must be registered before Node-RED
 * loads any node module, because the custom nodes read it at construction.
 */

const http = require('http');

const { createContext } = require('./services');
const { createApp, finalizeApp } = require('./api/app');
const { MqttBroker } = require('./broker/mqttBroker');
const { NodeRedRuntime } = require('./nodered/runtime');
const { Simulator } = require('./simulator');
const config = require('./config');
const { createLogger } = require('./logger');

const log = createLogger('server');

class Server {
  constructor(options = {}) {
    this.options = options;
    this.ctx = null;
    this.app = null;
    this.httpServer = null;
    this.broker = null;
    this.nodeRed = null;
    this.simulator = null;
    this.startedAt = null;
  }

  /**
   * Start everything.
   * @returns {Promise<Server>}
   */
  async start() {
    const begunAt = Date.now();

    // ---- 1. domain state -------------------------------------------------
    this.ctx = createContext(this.options.context);

    // ---- 2. MQTT broker --------------------------------------------------
    // Started before Node-RED so the flows' mqtt-in nodes connect on their
    // first attempt rather than backing off.
    this.broker = new MqttBroker(this.ctx.eventBus);
    await this.broker.start();
    this.ctx.broker = this.broker;

    // ---- 3. HTTP ---------------------------------------------------------
    this.app = createApp(this.ctx);
    this.httpServer = http.createServer(this.app);
    this.broker.attachWebSocket(this.httpServer);

    // ---- 4. Node-RED -----------------------------------------------------
    // init() registers the application context, which the custom nodes need,
    // and mounts the editor and http-in routes onto the Express app.
    if (config.nodeRed.enabled) {
      this.nodeRed = new NodeRedRuntime(this.ctx);
      this.nodeRed.init(this.httpServer, this.app);
      this.ctx.nodeRed = this.nodeRed;
    }

    // Static assets and the terminal error handler go last, after Node-RED has
    // claimed /red and /factory.
    finalizeApp(this.app);

    await this.#listen();

    if (this.nodeRed) await this.nodeRed.start();

    // ---- 5. simulator ----------------------------------------------------
    if (config.simulator.enabled) {
      this.simulator = new Simulator(this.ctx);
      this.ctx.simulator = this.simulator;
      if (config.simulator.autoStart) this.simulator.start();
    }

    this.startedAt = new Date().toISOString();
    this.#logBanner(Date.now() - begunAt);

    return this;
  }

  #listen() {
    return new Promise((resolve, reject) => {
      this.httpServer.once('error', reject);
      this.httpServer.listen(config.http.port, config.http.host, () => {
        this.httpServer.removeListener('error', reject);
        resolve();
      });
    });
  }

  /**
   * Shut down in reverse order, so nothing publishes into a closed broker.
   * @returns {Promise<void>}
   */
  async stop() {
    log.info('shutting down');

    this.simulator?.stop();
    await this.nodeRed?.stop();

    if (this.httpServer) {
      await new Promise((resolve) => this.httpServer.close(resolve));
    }

    await this.broker?.stop();

    // Flush one last snapshot so a restart resumes where this left off.
    this.ctx?.repository.stopAutoSnapshot();
    this.ctx?.repository.saveSnapshot();

    log.info('shutdown complete');
  }

  /** The bound port, useful in tests where port 0 was requested. */
  get port() {
    const address = this.httpServer?.address();
    return typeof address === 'object' ? address?.port : config.http.port;
  }

  #logBanner(bootMs) {
    const base = config.http.publicUrl || `http://localhost:${this.port}`;
    const diagnostics = this.ctx.repository.diagnostics();

    log.info('production core is running', {
      bootMs,
      env: config.env,
      port: this.port,
      units: diagnostics.collections.units,
      workOrders: diagnostics.collections.workOrders
    });

    if (config.isProduction) return;

    // A readable summary beats hunting through JSON logs for the URLs.
    const lines = [
      '',
      '  Production Core - NorthStar Motors, Windsor Assembly Plant',
      `  ${'-'.repeat(58)}`,
      `  Plant HMI       ${base}/`,
      `  Flow editor     ${base}${config.nodeRed.httpAdminRoot}`,
      `  API docs        ${base}/api-docs`,
      `  REST API        ${base}/api/v1`,
      `  Factory API     ${base}${config.nodeRed.httpNodeRoot}/status`,
      `  Line board      ${base}${config.nodeRed.httpNodeRoot}/board`,
      `  Event stream    ${base}/api/v1/events/stream`,
      `  MQTT broker     mqtt://localhost:${config.mqtt.port}`,
      `  ${'-'.repeat(58)}`,
      `  ${diagnostics.collections.units} vehicles | ` +
      `${diagnostics.collections.genealogies} genealogy records | ` +
      `${diagnostics.indexes.lots} supplier lots`,
      `  Simulator ${this.simulator?.running ? `running at ${this.simulator.speed}x` : 'stopped'}` +
      ` | API key: ${config.security.apiKey}`,
      ''
    ];
    process.stdout.write(`${lines.join('\n')}\n`);
  }
}

module.exports = { Server };
