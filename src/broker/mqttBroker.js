'use strict';

/**
 * Embedded MQTT broker (Aedes).
 *
 * Running the broker in-process is the single decision that makes this project
 * deployable anywhere: there is no Mosquitto to install, no second container,
 * and no managed broker to pay for. Node-RED's MQTT nodes connect to
 * 127.0.0.1:1883 and behave exactly as they would against a real broker.
 *
 * Two listeners are exposed:
 *   - TCP on PC_MQTT_PORT, for Node-RED and any local MQTT client
 *   - WebSocket on the HTTP port at /mqtt, so a browser - or a PaaS host that
 *     only exposes one TCP port - can still reach it
 *
 * Topic namespace (ISA-95 shaped, one level per hierarchy tier):
 *
 *   northstar/<site>/<line>/<station>/telemetry
 *   northstar/<site>/<line>/<station>/state
 *   northstar/<site>/<line>/<station>/event
 *   northstar/<site>/plant/event/<eventType>
 *   northstar/<site>/plant/andon
 */

const net = require('net');

// aedes 1.x exports `{ Aedes }`; 0.x exported the constructor directly.
// Accept either so a minor-version bump cannot break the boot.
const aedesModule = require('aedes');
const Aedes = aedesModule.Aedes || aedesModule.default || aedesModule;
const config = require('../config');
const { createLogger } = require('../logger');

const log = createLogger('mqtt');

class MqttBroker {
  /**
   * @param {import('../services/eventBus').EventBus} eventBus
   */
  constructor(eventBus) {
    this.eventBus = eventBus;
    this.aedes = null;
    this.server = null;
    this.wsHandler = null;
    this.unsubscribe = null;
    this.stats = { published: 0, received: 0, clients: 0 };
    this.startedAt = null;
  }

  /**
   * Start the broker and begin mirroring plant events onto MQTT.
   *
   * aedes 1.x requires an explicit async `listen()` before it will answer a
   * CONNECT; skipping it produces a TCP socket that accepts connections and
   * then never sends CONNACK, which looks exactly like a firewall problem.
   *
   * @returns {Promise<void>}
   */
  async start() {
    if (!config.mqtt.enabled) {
      log.info('mqtt broker disabled by configuration');
      return;
    }

    this.aedes = typeof Aedes.createBroker === 'function'
      ? await Aedes.createBroker({ id: `production-core-${config.site.id}` })
      : await (async () => {
          const instance = new Aedes({ id: `production-core-${config.site.id}` });
          await instance.listen?.();
          return instance;
        })();

    this.aedes.on('client', (client) => {
      this.stats.clients += 1;
      log.debug('client connected', { id: client?.id, total: this.stats.clients });
    });
    this.aedes.on('clientDisconnect', (client) => {
      this.stats.clients = Math.max(0, this.stats.clients - 1);
      log.debug('client disconnected', { id: client?.id });
    });
    this.aedes.on('clientError', (client, error) => {
      log.warn('client error', { id: client?.id, error: error.message });
    });

    // Inbound messages from Node-RED flows or external publishers.
    this.aedes.on('publish', (packet, client) => {
      if (!client) return; // our own republished events
      this.stats.received += 1;
      log.debug('inbound', { topic: packet.topic, from: client.id });
    });

    await this.#listenTcp();

    this.#attachEventMirror();
    this.startedAt = new Date().toISOString();
  }

  /**
   * Bind the TCP listener.
   *
   * A port clash must not take the application down - the REST API, the HMI
   * and the Node-RED flows all work without MQTT, so the failure is logged and
   * the boot continues.
   * @returns {Promise<void>}
   */
  #listenTcp() {
    return new Promise((resolve) => {
      const server = net.createServer((socket) => this.aedes.handle(socket));

      const onError = (error) => {
        log.warn('mqtt tcp listener unavailable, continuing without it', {
          port: config.mqtt.port, error: error.message
        });
        this.server = null;
        resolve();
      };

      server.once('error', onError);
      server.listen(config.mqtt.port, () => {
        server.removeListener('error', onError);
        server.on('error', (error) => log.error('broker error', { error: error.message }));
        this.server = server;
        log.info('mqtt broker listening', {
          port: config.mqtt.port,
          ws: config.mqtt.wsEnabled ? config.mqtt.wsPath : 'disabled'
        });
        resolve();
      });
    });
  }

  /**
   * Bridge MQTT-over-WebSocket onto an existing HTTP server, so the broker is
   * reachable on the one port a PaaS host exposes.
   * @param {import('http').Server} httpServer
   */
  attachWebSocket(httpServer) {
    if (!config.mqtt.enabled || !config.mqtt.wsEnabled || !this.aedes) return;

    let WebSocketServer;
    try {
      // ws arrives as a transitive dependency of Node-RED.
      ({ WebSocketServer } = require('ws'));
    } catch (_error) {
      log.warn('ws is not available; MQTT over WebSocket is disabled');
      return;
    }

    const wss = new WebSocketServer({ noServer: true });

    wss.on('connection', (socket) => {
      const stream = createWebSocketStream(socket);
      this.aedes.handle(stream);
    });

    httpServer.on('upgrade', (request, socket, head) => {
      // Only claim our own path; Node-RED's editor uses upgrades too.
      const { pathname } = new URL(request.url, 'http://localhost');
      if (pathname !== config.mqtt.wsPath) return;
      wss.handleUpgrade(request, socket, head, (ws) => wss.emit('connection', ws, request));
    });

    this.wsHandler = wss;
    log.info('mqtt over websocket attached', { path: config.mqtt.wsPath });
  }

  /** Mirror every plant event onto the MQTT topic tree. */
  #attachEventMirror() {
    const root = config.mqtt.topicRoot;
    const site = config.site.id.toLowerCase();

    this.unsubscribe = this.eventBus.onAny((envelope) => {
      const topics = [];

      if (envelope.stationId && envelope.lineId) {
        const suffix = envelope.type === 'station.telemetry' ? 'telemetry'
          : envelope.type === 'station.state' ? 'state'
            : 'event';
        topics.push(
          `${root}/${site}/${envelope.lineId.toLowerCase()}/${envelope.stationId.toLowerCase()}/${suffix}`
        );
      }

      // Every event also lands on a plant-wide topic keyed by type, so a flow
      // can subscribe to `northstar/win/plant/event/unit/+` and get all unit
      // events without knowing which line they came from.
      topics.push(`${root}/${site}/plant/event/${envelope.type.replace(/\./g, '/')}`);

      const payload = JSON.stringify(envelope);
      for (const topic of topics) this.publish(topic, payload);
    });
  }

  /**
   * Publish a message. Safe to call before the broker has started.
   * @param {string} topic
   * @param {string|object} payload
   * @param {object} [options] {qos, retain}
   */
  publish(topic, payload, options = {}) {
    if (!this.aedes) return false;
    this.aedes.publish({
      cmd: 'publish',
      topic,
      payload: typeof payload === 'string' ? payload : JSON.stringify(payload),
      qos: options.qos ?? 0,
      retain: options.retain ?? false,
      dup: false
    }, (error) => {
      if (error) log.warn('publish failed', { topic, error: error.message });
    });
    this.stats.published += 1;
    return true;
  }

  /** Broker status, surfaced through GET /api/v1/health. */
  status() {
    return {
      enabled: config.mqtt.enabled,
      running: Boolean(this.aedes),
      tcpPort: this.server ? config.mqtt.port : null,
      websocketPath: this.wsHandler ? config.mqtt.wsPath : null,
      topicRoot: `${config.mqtt.topicRoot}/${config.site.id.toLowerCase()}`,
      connectedClients: this.stats.clients,
      messagesPublished: this.stats.published,
      messagesReceived: this.stats.received,
      startedAt: this.startedAt
    };
  }

  /** @returns {Promise<void>} */
  stop() {
    return new Promise((resolve) => {
      this.unsubscribe?.();
      this.wsHandler?.close();
      const closeServer = () => {
        if (!this.server) return resolve();
        this.server.close(() => resolve());
      };
      if (this.aedes) this.aedes.close(closeServer);
      else closeServer();
    });
  }
}

/**
 * Adapt a WebSocket into the duplex stream Aedes expects.
 * Kept local rather than pulling in `websocket-stream`, which is unmaintained.
 */
function createWebSocketStream(socket) {
  const { Duplex } = require('stream');

  const stream = new Duplex({
    objectMode: false,
    read() { /* data is pushed from the socket's message handler */ },
    write(chunk, _encoding, callback) {
      if (socket.readyState === socket.OPEN) {
        socket.send(chunk, { binary: true }, () => callback());
      } else {
        callback();
      }
    },
    final(callback) {
      try { socket.close(); } catch (_e) { /* already closed */ }
      callback();
    }
  });

  socket.on('message', (data) => {
    stream.push(Buffer.isBuffer(data) ? data : Buffer.from(data));
  });
  socket.on('close', () => stream.push(null));
  socket.on('error', (error) => stream.destroy(error));

  return stream;
}

module.exports = { MqttBroker };
