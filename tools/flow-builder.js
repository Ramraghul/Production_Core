'use strict';

/**
 * Flow builder - the "flows as code" engine.
 *
 * Node-RED stores flows as a flat array of node objects with generated ids and
 * hand-placed coordinates. Edited by hand that file is unreviewable: a one-node
 * change produces a diff full of moved coordinates, and adding a station to a
 * 40-station plant means forty minutes of dragging.
 *
 * This builder emits that array from a declarative description instead:
 *
 *   - ids are derived deterministically from a logical name, so regenerating
 *     an unchanged flow produces a byte-identical file and the diff shows only
 *     what actually changed
 *   - coordinates are assigned by a simple column/row layout, so nodes never
 *     overlap and adding one does not shift the rest
 *   - wiring is by logical name, so a typo is a build error rather than a
 *     silently disconnected node discovered in production
 *
 * The result is a flows.json that is generated, reviewable and reproducible -
 * and still a completely ordinary Node-RED file that opens in the editor.
 */

const crypto = require('crypto');

/** Node-RED ids are 16 lowercase hex characters. */
function stableId(namespace, name) {
  return crypto
    .createHash('sha256')
    .update(`${namespace}::${name}`)
    .digest('hex')
    .slice(0, 16);
}

/** Grid geometry. Generous enough that labels do not collide. */
const GRID = Object.freeze({
  originX: 140,
  originY: 80,
  columnWidth: 200,
  rowHeight: 62
});

class FlowBuilder {
  constructor() {
    /** @type {object[]} every node, in emission order */
    this.nodes = [];
    /** @type {Map<string,string>} logical name -> node id */
    this.ids = new Map();
    /** @type {Array<{from:string,to:string,output:number}>} deferred wires */
    this.pendingWires = [];
    this.currentTab = null;
  }

  // ---- structure ---------------------------------------------------------

  /**
   * Open a new tab. Subsequent nodes belong to it until the next call.
   * @param {string} name  displayed on the tab
   * @param {object} [options] {info, disabled}
   */
  tab(name, options = {}) {
    const id = stableId('tab', name);
    this.nodes.push({
      id,
      type: 'tab',
      label: name,
      disabled: options.disabled === true,
      info: options.info || '',
      env: []
    });
    this.currentTab = { id, name, columns: new Map() };
    this.ids.set(`tab:${name}`, id);
    return this;
  }

  /**
   * Place a node.
   *
   * @param {string} name   logical name, unique within the tab; used for wiring
   * @param {object} spec   the node body (type plus its own properties)
   * @param {object} layout {column, row} - zero-based grid position
   */
  node(name, spec, layout = {}) {
    if (!this.currentTab) throw new Error('A tab must be opened before adding nodes');

    const key = `${this.currentTab.name}/${name}`;
    if (this.ids.has(key)) {
      throw new Error(`Duplicate node name '${name}' on tab '${this.currentTab.name}'`);
    }

    const column = layout.column ?? 0;
    // When no row is given, stack downward within the column.
    const used = this.currentTab.columns.get(column) ?? 0;
    const row = layout.row ?? used;
    this.currentTab.columns.set(column, Math.max(used, row + 1));

    const id = stableId(this.currentTab.name, name);
    this.ids.set(key, id);

    this.nodes.push({
      id,
      z: this.currentTab.id,
      x: GRID.originX + column * GRID.columnWidth,
      y: GRID.originY + row * GRID.rowHeight,
      wires: [],
      ...spec
    });

    return this;
  }

  /** A configuration node: global, with no tab, position or wires. */
  configNode(name, spec) {
    const id = stableId('config', name);
    this.ids.set(`config:${name}`, id);
    this.nodes.push({ id, ...spec });
    return id;
  }

  /** Reference a config node by name, for use inside a node spec. */
  config(name) {
    const id = this.ids.get(`config:${name}`);
    if (!id) throw new Error(`Unknown config node '${name}'`);
    return id;
  }

  /**
   * Wire one node to another. Resolved after every node exists, so order does
   * not matter and a forward reference is legal.
   *
   * @param {string} from   logical name
   * @param {string} to     logical name, or an array of names to fan out
   * @param {number} [output] source output index (default 0)
   */
  wire(from, to, output = 0) {
    const targets = Array.isArray(to) ? to : [to];
    for (const target of targets) {
      this.pendingWires.push({
        tab: this.currentTab.name,
        from,
        to: target,
        output
      });
    }
    return this;
  }

  /** Wire a chain: a -> b -> c. */
  chain(...names) {
    for (let index = 0; index < names.length - 1; index += 1) {
      this.wire(names[index], names[index + 1]);
    }
    return this;
  }

  /** A sticky note on the canvas. */
  comment(name, text, layout = {}) {
    return this.node(name, { type: 'comment', name: text.split('\n')[0], info: text }, layout);
  }

  // ---- emit --------------------------------------------------------------

  /**
   * Resolve every wire and return the finished flow array.
   * @throws {Error} when a wire names a node that does not exist
   */
  build() {
    const byId = new Map(this.nodes.map((node) => [node.id, node]));

    for (const { tab, from, to, output } of this.pendingWires) {
      const fromId = this.ids.get(`${tab}/${from}`);
      const toId = this.ids.get(`${tab}/${to}`);

      if (!fromId) throw new Error(`Cannot wire from unknown node '${from}' on tab '${tab}'`);
      if (!toId) throw new Error(`Cannot wire '${from}' to unknown node '${to}' on tab '${tab}'`);

      const node = byId.get(fromId);
      while (node.wires.length <= output) node.wires.push([]);
      if (!node.wires[output].includes(toId)) node.wires[output].push(toId);
    }

    // Config nodes carry no wires array; strip the empty one the builder adds.
    for (const node of this.nodes) {
      if (node.z === undefined && node.type !== 'tab' && Array.isArray(node.wires) && !node.wires.length) {
        delete node.wires;
      }
    }

    return this.nodes;
  }

  /** Counts for the build report. */
  stats() {
    const byType = this.nodes.reduce((acc, node) => {
      acc[node.type] = (acc[node.type] || 0) + 1;
      return acc;
    }, {});
    return {
      total: this.nodes.length,
      tabs: this.nodes.filter((n) => n.type === 'tab').length,
      wires: this.pendingWires.length,
      byType
    };
  }
}

// ---- node factories ------------------------------------------------------
//
// Thin helpers that produce the property bag Node-RED expects for each core
// node type. They exist so the spec file reads as intent rather than as schema.

const n = {
  inject: (name, options = {}) => ({
    type: 'inject',
    name,
    props: options.props || [{ p: 'payload' }, { p: 'topic', vt: 'str' }],
    repeat: options.repeat ? String(options.repeat) : '',
    crontab: '',
    once: options.once === true,
    onceDelay: options.onceDelay ? String(options.onceDelay) : '0.1',
    topic: options.topic || '',
    payload: options.payload !== undefined ? String(options.payload) : '',
    payloadType: options.payloadType || 'date'
  }),

  func: (name, code, options = {}) => ({
    type: 'function',
    name,
    func: code,
    outputs: options.outputs ?? 1,
    timeout: options.timeout ?? 0,
    noerr: 0,
    initialize: options.initialize || '',
    finalize: '',
    libs: []
  }),

  change: (name, rules) => ({
    type: 'change',
    name,
    rules,
    action: '',
    property: '',
    from: '',
    to: '',
    reg: false
  }),

  switchNode: (name, property, rules, options = {}) => ({
    type: 'switch',
    name,
    property,
    propertyType: options.propertyType || 'msg',
    rules,
    checkall: options.checkall === undefined ? 'true' : String(options.checkall),
    repair: false,
    outputs: rules.length
  }),

  debug: (name, options = {}) => ({
    type: 'debug',
    name,
    active: options.active !== false,
    tosidebar: true,
    console: false,
    tostatus: options.tostatus === true,
    complete: options.complete || 'payload',
    targetType: options.targetType || 'msg',
    statusVal: options.statusVal || '',
    statusType: options.statusType || 'auto'
  }),

  mqttIn: (name, topic, brokerId, options = {}) => ({
    type: 'mqtt in',
    name,
    topic,
    qos: options.qos === undefined ? '0' : String(options.qos),
    datatype: options.datatype || 'json',
    broker: brokerId,
    nl: false,
    rap: true,
    rh: 0,
    inputs: 0
  }),

  mqttOut: (name, topic, brokerId, options = {}) => ({
    type: 'mqtt out',
    name,
    topic,
    qos: options.qos === undefined ? '0' : String(options.qos),
    retain: options.retain ? 'true' : '',
    respTopic: '',
    contentType: '',
    userProps: '',
    correl: '',
    expiry: '',
    broker: brokerId
  }),

  mqttBroker: (name, options = {}) => ({
    type: 'mqtt-broker',
    name,
    // Kept as strings so a `${ENV_VAR}` placeholder survives; Node-RED
    // substitutes these at flow-start time.
    broker: options.host || '127.0.0.1',
    port: String(options.port ?? 1883),
    clientid: options.clientId || '',
    autoConnect: true,
    usetls: false,
    protocolVersion: '4',
    keepalive: '60',
    cleansession: true,
    autoUnsubscribe: true,
    birthTopic: '',
    birthQos: '0',
    birthPayload: '',
    birthMsg: {},
    closeTopic: '',
    closeQos: '0',
    closePayload: '',
    closeMsg: {},
    willTopic: '',
    willQos: '0',
    willPayload: '',
    willMsg: {},
    userProps: '',
    sessionExpiry: ''
  }),

  httpIn: (name, url, method = 'get') => ({
    type: 'http in',
    name,
    url,
    method,
    upload: false,
    swaggerDoc: ''
  }),

  httpResponse: (name, options = {}) => ({
    type: 'http response',
    name,
    statusCode: options.statusCode ? String(options.statusCode) : '',
    headers: options.headers || {}
  }),

  template: (name, template, options = {}) => ({
    type: 'template',
    name,
    field: options.field || 'payload',
    fieldType: 'msg',
    format: options.format || 'handlebars',
    syntax: options.syntax || 'mustache',
    template,
    output: options.output || 'str'
  }),

  linkOut: (name, targets = []) => ({
    type: 'link out',
    name,
    mode: 'link',
    links: targets
  }),

  linkIn: (name) => ({
    type: 'link in',
    name,
    links: []
  }),

  delay: (name, seconds) => ({
    type: 'delay',
    name,
    pauseType: 'delay',
    timeout: String(seconds),
    timeoutUnits: 'seconds',
    rate: '1',
    nbRateUnits: '1',
    rateUnits: 'second',
    randomFirst: '1',
    randomLast: '5',
    randomUnits: 'seconds',
    drop: false,
    allowrate: false,
    outputs: 1
  }),

  status: (name, scope = null) => ({
    type: 'status',
    name,
    scope
  }),

  catchNode: (name, scope = null) => ({
    type: 'catch',
    name,
    scope,
    uncaught: false
  })
};

module.exports = { FlowBuilder, stableId, GRID, n };
