'use strict';

/**
 * Custom Node-RED node tests.
 *
 * These run the real nodes inside a real (headless) Node-RED runtime via
 * node-red-node-test-helper, so what is under test is the node as the editor
 * loads it - not a hand-rolled stand-in.
 */

const helper = require('node-red-node-test-helper');

const unitNode = require('../../nodes/pc-unit/pc-unit.js');
const stationNode = require('../../nodes/pc-station/pc-station.js');
const gateNode = require('../../nodes/pc-quality-gate/pc-quality-gate.js');
const oeeNode = require('../../nodes/pc-oee/pc-oee.js');
const andonNode = require('../../nodes/pc-andon/pc-andon.js');
const genealogyNode = require('../../nodes/pc-genealogy/pc-genealogy.js');
const workOrderNode = require('../../nodes/pc-workorder/pc-workorder.js');

const { setContext, resetContext } = require('../../src/context');
const {
  makeContext, buildVehicle, releaseUnits, walkRoute, MAIN_STATION_ROUTE
} = require('../helpers/factory');

helper.init(require.resolve('node-red'));

let ctx;

beforeEach((done) => {
  ctx = makeContext();
  setContext(ctx);
  helper.startServer(done);
});

afterEach((done) => {
  helper.unload();
  resetContext();
  helper.stopServer(done);
});

/** Load a one-node flow wired into a helper sink, and run one message. */
function runNode(nodeModule, nodeConfig, message) {
  return new Promise((resolve, reject) => {
    const flow = [
      { ...nodeConfig, id: 'n1', z: 'f1', wires: [['out']] },
      { id: 'out', z: 'f1', type: 'helper' },
      { id: 'f1', type: 'tab', label: 'test' }
    ];
    const timer = setTimeout(() => reject(new Error('node produced no output')), 5000);

    // Unload first so a test can drive the node more than once: the helper
    // spies on the runtime log and refuses to wrap it twice.
    helper.unload().then(() => helper.load(nodeModule, flow, () => {
      helper.getNode('out').on('input', (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      helper.getNode('n1').receive(message);
    }));
  });
}

/** Load a two-output node and report which output the message came out of. */
function runBranchingNode(nodeModule, nodeConfig, message) {
  return new Promise((resolve, reject) => {
    const flow = [
      { ...nodeConfig, id: 'n1', z: 'f1', wires: [['pass'], ['hold']] },
      { id: 'pass', z: 'f1', type: 'helper' },
      { id: 'hold', z: 'f1', type: 'helper' },
      { id: 'f1', type: 'tab', label: 'test' }
    ];
    const timer = setTimeout(() => reject(new Error('node produced no output')), 5000);

    helper.unload().then(() => helper.load(nodeModule, flow, () => {
      helper.getNode('pass').on('input', (msg) => {
        clearTimeout(timer);
        resolve({ output: 'pass', msg });
      });
      helper.getNode('hold').on('input', (msg) => {
        clearTimeout(timer);
        resolve({ output: 'hold', msg });
      });
      helper.getNode('n1').receive(message);
    }));
  });
}

describe('pc-unit', () => {
  it('loads with its defaults', (done) => {
    helper.load(unitNode, [{ id: 'n1', type: 'pc-unit', name: 'test' }], () => {
      const node = helper.getNode('n1');
      expect(node).toBeTruthy();
      expect(node.name).toBe('test');
      done();
    });
  });

  it('fetches a vehicle by VIN from the message', async () => {
    const built = buildVehicle(ctx);
    const msg = await runNode(
      unitNode,
      { type: 'pc-unit', operation: 'get', vin: 'vin', vinType: 'msg' },
      { vin: built.vin }
    );

    expect(msg.payload.vin).toBe(built.vin);
    expect(msg.payload.status).toBe('COMPLETED');
    expect(msg.topic).toBe(`unit/${built.vin}`);
  });

  it('advances a vehicle along the routing', async () => {
    const { vins: [vin] } = releaseUnits(ctx, 1);
    const msg = await runNode(
      unitNode,
      { type: 'pc-unit', operation: 'advance', vin: 'vin', vinType: 'msg' },
      { vin }
    );

    expect(msg.payload.currentStation).toBe('BODY-10');
  });

  it('reports a domain refusal on msg.error rather than throwing', async () => {
    // A quality gate refusing a vehicle is a normal outcome a flow branches on,
    // not a crash - so the message must still arrive, annotated.
    const { vins: [vin] } = releaseUnits(ctx, 1);
    walkRoute(ctx, vin, { through: MAIN_STATION_ROUTE.indexOf('BODY-50') + 1 });
    ctx.quality.raiseDefect({ code: 'DIM_OUT_OF_TOL', vin, stationId: 'BODY-50' });

    const msg = await runNode(
      unitNode,
      { type: 'pc-unit', operation: 'move', vin: 'vin', vinType: 'msg', station: 'PAINT-10', stationType: 'str' },
      { vin }
    );

    expect(msg.payload).toBeNull();
    expect(msg.error.code).toBe('QUALITY_HOLD');
    expect(msg.error.status).toBe(409);
  });

  it('lists work in progress', async () => {
    const { vins: [vin] } = releaseUnits(ctx, 1);
    walkRoute(ctx, vin, { through: 3 });

    const msg = await runNode(unitNode, { type: 'pc-unit', operation: 'wip' }, {});
    expect(Array.isArray(msg.payload)).toBe(true);
    expect(msg.payload.some((u) => u.vin === vin)).toBe(true);
  });
});

describe('pc-station', () => {
  it('reads a station state', async () => {
    const msg = await runNode(
      stationNode,
      { type: 'pc-station', operation: 'get', station: 'CHAS-10', stationType: 'str' },
      {}
    );

    expect(msg.payload.stationId).toBe('CHAS-10');
    expect(msg.payload.lineId).toBe('MAINASM');
  });

  it('changes state and opens a downtime record', async () => {
    const msg = await runNode(
      stationNode,
      { type: 'pc-station', operation: 'setState', station: 'PAINT-40', stationType: 'str', state: 'DOWN', reasonCode: 'ROBOT_FAULT' },
      {}
    );

    expect(msg.payload.state).toBe('DOWN');
    expect(msg.payload.openDowntimeId).toBeTruthy();
    expect(ctx.operations.currentStops()).toHaveLength(1);
  });

  it('lists the stations on one line', async () => {
    const msg = await runNode(
      stationNode,
      { type: 'pc-station', operation: 'list', lineFilter: 'BODY' },
      {}
    );

    expect(msg.payload).toHaveLength(5);
    expect(msg.payload.every((s) => s.lineId === 'BODY')).toBe(true);
  });
});

describe('pc-station control operations', () => {
  const stationNodeConfig = (operation, extra = {}) => ({
    type: 'pc-station', operation, station: 'stationId', stationType: 'msg', ...extra
  });

  it('stops and starts a station', async () => {
    const stopped = await runNode(stationNode, stationNodeConfig('stop'),
      { stationId: 'PAINT-40', reasonCode: 'SCHEDULED_BREAK', operator: 'flow-test' });
    expect(stopped.payload.state).toBe('STOPPED');
    expect(stopped.payload.control.reasonCode).toBe('SCHEDULED_BREAK');

    const started = await runNode(stationNode, stationNodeConfig('start'), { stationId: 'PAINT-40' });
    expect(started.payload.control.mode).toBe('AUTO');
  });

  it('reports a refused command on msg.error rather than throwing', async () => {
    const msg = await runNode(stationNode, stationNodeConfig('start'), { stationId: 'PAINT-40' });
    expect(msg.payload).toBeNull();
    expect(msg.error.code).toBe('INVALID_STATE_TRANSITION');
  });

  it('opens and completes a maintenance order', async () => {
    const started = await runNode(stationNode, stationNodeConfig('maintenance', { maintenanceType: 'PREDICTIVE' }),
      { stationId: 'TIRE-30', technician: 'maint-772', plannedMinutes: 10 });
    expect(started.maintenanceOrderId).toMatch(/^MWO-/);
    expect(started.payload.activeMaintenance.type).toBe('PREDICTIVE');

    const done = await runNode(stationNode, stationNodeConfig('completeMaintenance'),
      { stationId: 'TIRE-30', findings: 'Spindle runout within limits' });
    expect(done.payload.completedOrder.findings).toBe('Spindle runout within limits');
  });

  it('reports PM status for every station', async () => {
    const msg = await runNode(stationNode, { type: 'pc-station', operation: 'pmStatus' }, {});
    expect(msg.payload).toHaveLength(43);
    expect(msg.payload[0]).toHaveProperty('usedPct');
  });
});

describe('pc-quality-gate', () => {
  it('routes a clean vehicle out of the pass output', async () => {
    const { vins: [vin] } = releaseUnits(ctx, 1);
    walkRoute(ctx, vin, { through: MAIN_STATION_ROUTE.indexOf('BODY-50') + 1 });

    const result = await runBranchingNode(
      gateNode,
      { type: 'pc-quality-gate', mode: 'evaluate', vin: 'vin', vinType: 'msg', station: 'BODY-50', stationType: 'str' },
      { vin }
    );

    expect(result.output).toBe('pass');
    expect(result.msg.payload.pass).toBe(true);
  });

  it('routes a defective vehicle out of the hold output and holds it', async () => {
    const { vins: [vin] } = releaseUnits(ctx, 1);
    walkRoute(ctx, vin, { through: MAIN_STATION_ROUTE.indexOf('BODY-50') + 1 });
    ctx.quality.raiseDefect({ code: 'DIM_OUT_OF_TOL', vin, stationId: 'BODY-50' });

    const result = await runBranchingNode(
      gateNode,
      { type: 'pc-quality-gate', mode: 'evaluate', vin: 'vin', vinType: 'msg', station: 'BODY-50', stationType: 'str', holdOnFail: true },
      { vin }
    );

    expect(result.output).toBe('hold');
    expect(result.msg.payload.recommendation).toBe('HOLD_OFFLINE');
    expect(ctx.repository.get('units', vin).status).toBe('HOLD');
  });

  it('runs an inspection plan and blocks on the defects it raises', async () => {
    const { vins: [vin] } = releaseUnits(ctx, 1);
    walkRoute(ctx, vin, { through: MAIN_STATION_ROUTE.indexOf('BODY-50') + 1 });

    const result = await runBranchingNode(
      gateNode,
      { type: 'pc-quality-gate', mode: 'inspect', vin: 'vin', vinType: 'msg', station: 'BODY-50', stationType: 'str', holdOnFail: true },
      { vin, measurements: { 'CMM-A-PILLAR': 1.9, 'CMM-ROCKER': 0.1, 'WELD-COUNT': 415 } }
    );

    expect(result.output).toBe('hold');
    expect(result.msg.payload.inspection.passed).toBe(false);
    expect(result.msg.payload.defectsRaised.length).toBeGreaterThan(0);
  });
});

describe('pc-oee', () => {
  it('computes plant OEE', async () => {
    buildVehicle(ctx);
    const msg = await runNode(oeeNode, { type: 'pc-oee', scope: 'plant' }, {});

    expect(msg.payload).toHaveProperty('oee');
    expect(msg.payload.lines).toHaveLength(7);
    expect(msg.topic).toBe('kpi/plant');
  });

  it('computes line OEE for a target from the message', async () => {
    const msg = await runNode(
      oeeNode,
      { type: 'pc-oee', scope: 'line', target: 'lineId', targetType: 'msg' },
      { lineId: 'MAINASM' }
    );

    expect(msg.payload.lineId).toBe('MAINASM');
    expect(msg.payload.stations).toHaveLength(10);
  });

  it('returns the full dashboard', async () => {
    const msg = await runNode(oeeNode, { type: 'pc-oee', scope: 'dashboard' }, {});

    expect(msg.payload).toHaveProperty('headline');
    expect(msg.payload).toHaveProperty('buffers');
  });

  it('reports an unknown line on msg.error', async () => {
    const msg = await runNode(
      oeeNode,
      { type: 'pc-oee', scope: 'line', target: 'NOPE', targetType: 'str' },
      {}
    );

    expect(msg.error.code).toBe('NOT_FOUND');
  });
});

describe('pc-andon', () => {
  it('raises a line-stopping call and takes the station down', async () => {
    const msg = await runNode(
      andonNode,
      { type: 'pc-andon', operation: 'raise', station: 'PAINT-40', stationType: 'str', callType: 'MAINTENANCE' },
      {}
    );

    expect(msg.payload.callType).toBe('MAINTENANCE');
    expect(msg.payload.stopsLine).toBe(true);
    expect(ctx.operations.getStationState('PAINT-40').state).toBe('DOWN');
  });

  it('escalates every call that has blown its SLA', async () => {
    const at = new Date(Date.now() - 600000);
    ctx.operations.raiseAndon({ stationId: 'TRIM-10', callType: 'MATERIAL' }, at);

    const msg = await runNode(andonNode, { type: 'pc-andon', operation: 'sweep' }, {});

    expect(msg.payload).toHaveLength(1);
    expect(msg.payload[0].status).toBe('ESCALATED');
  });
});

describe('pc-genealogy', () => {
  it('returns the as-built tree for a vehicle', async () => {
    const built = buildVehicle(ctx);
    const msg = await runNode(
      genealogyNode,
      { type: 'pc-genealogy', operation: 'get', vin: 'vin', vinType: 'msg' },
      { vin: built.vin }
    );

    expect(msg.payload.stats.totalNodes).toBeGreaterThan(40);
    expect(msg.payload.sealedAt).toBeTruthy();
  });

  it('runs a recall query from a lot code on the message', async () => {
    const built = buildVehicle(ctx);
    const lotCode = ctx.repository.get('genealogies', built.vin).lotIndex[0];

    const msg = await runNode(
      genealogyNode,
      { type: 'pc-genealogy', operation: 'recall', lotCode: 'lotCode', lotCodeType: 'msg' },
      { lotCode }
    );

    expect(msg.payload.affectedCount).toBeGreaterThan(0);
    expect(msg.affectedVins).toContain(built.vin);
  });
});

describe('pc-workorder', () => {
  it('creates a work order from node configuration', async () => {
    const msg = await runNode(
      workOrderNode,
      { type: 'pc-workorder', operation: 'create', modelCode: 'NS-VOYAGEUR-ICE', quantity: 12 },
      {}
    );

    expect(msg.payload.modelCode).toBe('NS-VOYAGEUR-ICE');
    expect(msg.payload.quantity).toBe(12);
    expect(msg.workOrderId).toBe(msg.payload.id);
  });

  it('releases units and reports their VINs', async () => {
    const workOrder = ctx.production.createWorkOrder({ modelCode: 'NS-AURORA-EV', quantity: 5 });

    const msg = await runNode(
      workOrderNode,
      { type: 'pc-workorder', operation: 'release', orderId: 'workOrderId', orderIdType: 'msg', createUnits: 2 },
      { workOrderId: workOrder.id }
    );

    expect(msg.vins).toHaveLength(2);
    expect(msg.payload.units).toHaveLength(2);
  });
});

describe('context guard', () => {
  it('errors clearly when the application has not booted', (done) => {
    resetContext();

    const flow = [
      { id: 'n1', z: 'f1', type: 'pc-unit', operation: 'wip', wires: [['out']] },
      { id: 'out', z: 'f1', type: 'helper' },
      { id: 'f1', type: 'tab', label: 'test' }
    ];

    helper.load(unitNode, flow, () => {
      const node = helper.getNode('n1');
      node.error = (error) => {
        expect(String(error)).toMatch(/not initialised/);
        done();
      };
      node.receive({});
    });
  });
});
