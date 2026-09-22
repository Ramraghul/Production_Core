'use strict';

/**
 * Flow contract tests.
 *
 * flows/flows.json is a build output. These assert that it is structurally
 * loadable by Node-RED, that it is in step with its source spec, and that the
 * station and line ids baked into the flows still exist in the plant model -
 * which is the failure that would otherwise appear as a silently dead flow.
 */

const fs = require('fs');
const path = require('path');

const { buildFlows } = require('../../flows/plant.spec');
const plantModel = require('../../src/core/plantModel');

const FLOW_FILE = path.resolve(__dirname, '..', '..', 'flows', 'flows.json');

const flows = buildFlows();
const tabs = flows.filter((f) => f.type === 'tab');
const byId = new Map(flows.map((f) => [f.id, f]));

describe('generated flows', () => {
  it('is committed and matches the spec byte for byte', () => {
    // Ids are derived from logical names, so an unchanged spec regenerates an
    // identical file. If this fails, someone edited flows.json by hand or
    // forgot to run `npm run build:flows`.
    expect(fs.existsSync(FLOW_FILE)).toBe(true);
    expect(fs.readFileSync(FLOW_FILE, 'utf8')).toBe(`${JSON.stringify(flows, null, 2)}\n`);
  });

  it('is deterministic across builds', () => {
    expect(JSON.stringify(buildFlows())).toBe(JSON.stringify(flows));
  });

  it('covers every part of the plant', () => {
    const labels = tabs.map((t) => t.label);
    expect(labels).toHaveLength(13);
    expect(labels).toEqual(expect.arrayContaining([
      expect.stringContaining('Body Shop'),
      expect.stringContaining('Paint Shop'),
      expect.stringContaining('Door Line'),
      expect.stringContaining('Wheel & Tire'),
      expect.stringContaining('Sub-Assembly'),
      expect.stringContaining('Main Assembly'),
      expect.stringContaining('Quality & EOL'),
      expect.stringContaining('Andon & Downtime'),
      expect.stringContaining('Maintenance'),
      expect.stringContaining('OEE & KPI'),
      expect.stringContaining('Factory API'),
      expect.stringContaining('Traceability')
    ]));
  });

  it('gives every tab a description', () => {
    const undocumented = tabs.filter((t) => !t.info || t.info.length < 40).map((t) => t.label);
    expect(undocumented).toEqual([]);
  });
});

describe('structural validity', () => {
  it('has no duplicate node ids', () => {
    const ids = flows.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('places every node on a tab that exists', () => {
    const tabIds = new Set(tabs.map((t) => t.id));
    const orphans = flows
      .filter((f) => f.z !== undefined && !tabIds.has(f.z))
      .map((f) => `${f.type} ${f.name || f.id}`);
    expect(orphans).toEqual([]);
  });

  it('wires only to nodes that exist', () => {
    const dangling = [];
    for (const node of flows) {
      for (const outputs of node.wires || []) {
        for (const target of outputs) {
          if (!byId.has(target)) dangling.push(`${node.name || node.id} -> ${target}`);
        }
      }
    }
    expect(dangling).toEqual([]);
  });

  it('never wires more outputs than a node declares', () => {
    const overwired = flows
      .filter((f) => (f.type === 'function' || f.type === 'switch') && f.outputs !== undefined)
      .filter((f) => (f.wires || []).length > f.outputs)
      .map((f) => `${f.type} '${f.name}' declares ${f.outputs} but wires ${f.wires.length}`);
    expect(overwired).toEqual([]);
  });

  it('gives every switch node one output per rule', () => {
    const mismatched = flows
      .filter((f) => f.type === 'switch')
      .filter((f) => f.outputs !== f.rules.length)
      .map((f) => f.name);
    expect(mismatched).toEqual([]);
  });

  it('points every MQTT node at a broker config that exists', () => {
    const configIds = new Set(
      flows.filter((f) => f.z === undefined && f.type !== 'tab').map((f) => f.id)
    );
    const orphaned = flows
      .filter((f) => f.type === 'mqtt in' || f.type === 'mqtt out')
      .filter((f) => !configIds.has(f.broker))
      .map((f) => f.name);
    expect(orphaned).toEqual([]);
  });

  it('gives every function node syntactically valid code', () => {
    const broken = [];
    for (const node of flows.filter((f) => f.type === 'function')) {
      try {
        // Node-RED wraps function bodies in an async function; compiling the
        // same way catches a syntax error here rather than at flow start.
        Function('msg', 'node', 'flow', 'global', 'context', 'env', node.func);
      } catch (error) {
        broken.push(`${node.name}: ${error.message}`);
      }
    }
    expect(broken).toEqual([]);
  });
});

describe('flows agree with the plant model', () => {
  /** Every station or line id that appears anywhere in the flow definitions. */
  const serialised = JSON.stringify(flows);

  it('references only stations that exist', () => {
    // Station ids follow a LETTERS-NUMBER shape; catch any that look like one
    // but are not in the plant model.
    const candidates = new Set(serialised.match(/\b[A-Z]{3,5}(?:-[A-Z]{3,4})?-\d{2}\b/g) || []);
    const known = new Set(plantModel.ALL_STATIONS.map((s) => s.id));
    const unknown = [...candidates].filter((id) => !known.has(id));
    expect(unknown).toEqual([]);
  });

  it('uses the configured MQTT topic root consistently', () => {
    const { TOPIC_ROOT } = require('../../flows/plant.spec');
    const mqttNodes = flows.filter((f) => f.type === 'mqtt in' || f.type === 'mqtt out');
    const offTree = mqttNodes
      .filter((f) => f.topic && !f.topic.startsWith(TOPIC_ROOT))
      .map((f) => `${f.name}: ${f.topic}`);
    expect(offTree).toEqual([]);
  });

  it('uses only custom node types the package registers', () => {
    const registered = new Set(Object.keys(require('../../package.json')['node-red'].nodes));
    const used = new Set(flows.filter((f) => f.type.startsWith('pc-')).map((f) => f.type));
    const unregistered = [...used].filter((type) => !registered.has(type));
    expect(unregistered).toEqual([]);
  });

  it('exercises the custom nodes rather than only core ones', () => {
    const custom = flows.filter((f) => f.type.startsWith('pc-'));
    expect(custom.length).toBeGreaterThan(20);
  });
});
