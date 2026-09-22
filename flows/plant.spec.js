'use strict';

/**
 * The factory, as Node-RED flows.
 *
 * This file is the source; flows/flows.json is the build output. Run
 * `npm run build:flows` after editing, and `npm run verify:flows` in CI to
 * assert the committed JSON matches this spec.
 *
 * Twelve tabs, laid out the way the plant is laid out:
 *
 *   00  Plant Overview      MQTT ingest, event fan-out, plant status heartbeat
 *   10  Body Shop           line monitoring and station state
 *   20  Paint Shop          booth conditions and paint quality gate
 *   30  Door Line           feeder line, broadcast door sets
 *   40  Wheel & Tire        feeder line, balance and TPMS
 *   50  Sub-Assembly        buffer levels and starvation warning
 *   60  Main Assembly       the production spine: routing and quality gates
 *   70  Quality & EOL       end-of-line test, audit and vehicle release
 *   80  Andon & Downtime    escalation ladder and stoppage tracking
 *   85  Maintenance         PM scheduling and station control over MQTT
 *   90  OEE & KPI Engine    ISO 22400 calculation and publication
 *   95  Factory API         HTTP endpoints served by the flows themselves
 *   99  Traceability        recall analysis and containment
 */

const { FlowBuilder, n } = require('../tools/flow-builder');
const { LINES, MAIN_STATION_ROUTE } = require('../src/core/plantModel');

const TOPIC_ROOT = 'northstar/win';

/**
 * Build the complete flow set.
 * @returns {object[]} Node-RED flow array
 */
function buildFlows() {
  const b = new FlowBuilder();

  // Single shared broker config, pointing at the embedded Aedes instance.
  //
  // Host and port come from the environment rather than being hardcoded: the
  // application resolves PC_MQTT_HOST and PC_MQTT_PORT (including their
  // defaults) into the process environment before Node-RED starts, so the
  // flows follow the broker wherever it is actually listening. Hardcoding 1883
  // here meant a deployment on any other port came up with every mqtt node
  // silently disconnected.
  b.configNode('plant-broker', n.mqttBroker('Plant Broker (embedded)', {
    host: '${PC_MQTT_HOST}',
    port: '${PC_MQTT_PORT}',
    clientId: 'production-core-flows'
  }));
  const broker = b.config('plant-broker');

  plantOverview(b, broker);
  lineMonitor(b, broker, 'BODY', '10 - Body Shop');
  paintShop(b, broker);
  doorLine(b, broker);
  wheelAndTire(b, broker);
  subAssembly(b, broker);
  mainAssembly(b, broker);
  qualityAndEol(b, broker);
  andonAndDowntime(b, broker);
  maintenance(b, broker);
  kpiEngine(b, broker);
  factoryApi(b);
  traceability(b, broker);

  return b.build();
}

// ==========================================================================
// 00 - Plant Overview
// ==========================================================================

function plantOverview(b, broker) {
  b.tab('00 - Plant Overview', {
    info: [
      '# Plant Overview',
      '',
      'Every plant event is mirrored onto MQTT by the application and arrives here.',
      'This tab normalises the feed, routes it by severity, and re-publishes a',
      'plant status heartbeat that the HMI and any external system can subscribe to.',
      '',
      '**Topics consumed**: `' + TOPIC_ROOT + '/plant/event/#`',
      '',
      '**Topics produced**: `' + TOPIC_ROOT + '/plant/status`'
    ].join('\n')
  });

  b.comment('header', [
    'Plant event ingest',
    '',
    'The embedded broker republishes every domain event onto the topic tree.',
    'Subscribing here rather than calling the API means a flow reacts to what',
    'happened, instead of polling for what changed.'
  ].join('\n'), { column: 0, row: 0 });

  b.node('events-in', n.mqttIn('all plant events', `${TOPIC_ROOT}/plant/event/#`, broker), { column: 0, row: 1 });

  b.node('normalise', n.func('normalise envelope', [
    '// The broker delivers the full event envelope. Flatten the parts a flow',
    '// normally branches on into msg properties so downstream switch nodes stay',
    '// readable, and keep the whole envelope on msg.payload.',
    'const event = msg.payload || {};',
    '',
    'msg.eventType = event.type || "unknown";',
    'msg.severity = event.severity || "info";',
    'msg.stationId = event.stationId || null;',
    'msg.lineId = event.lineId || null;',
    'msg.vin = event.vin || null;',
    'msg.topic = event.type;',
    '',
    '// A short human-readable line for the event feed.',
    'const p = event.payload || {};',
    'msg.summary = [',
    '  event.type,',
    '  msg.vin ? `VIN ${msg.vin}` : null,',
    '  msg.stationId ? `at ${msg.stationId}` : null,',
    '  p.reason || p.reasonLabel || p.label || null',
    '].filter(Boolean).join(" ");',
    '',
    'return msg;'
  ].join('\n')), { column: 1, row: 1 });

  b.node('by-severity', n.switchNode('route by severity', 'severity', [
    { t: 'eq', v: 'error', vt: 'str' },
    { t: 'eq', v: 'warning', vt: 'str' },
    { t: 'else' }
  ]), { column: 2, row: 1 });

  b.node('errors', n.debug('errors', { complete: 'summary', tostatus: true, statusVal: 'summary' }), { column: 3, row: 0 });
  b.node('warnings', n.debug('warnings', { complete: 'summary', tostatus: true, statusVal: 'summary' }), { column: 3, row: 2 });
  b.node('info', n.debug('info', { active: false, complete: 'summary' }), { column: 3, row: 4 });

  // Fan the normalised feed out to the other tabs.
  b.node('fanout', n.linkOut('plant events', []), { column: 3, row: 6 });

  b.chain('events-in', 'normalise', 'by-severity');
  b.wire('by-severity', 'errors', 0);
  b.wire('by-severity', 'warnings', 1);
  b.wire('by-severity', 'info', 2);
  b.wire('normalise', 'fanout');

  // ---- plant status heartbeat --------------------------------------------
  b.comment('hb-header', [
    'Plant status heartbeat',
    '',
    'Publishes a compact plant summary every 15 seconds so a subscriber gets',
    'current state without having to replay the event log.'
  ].join('\n'), { column: 0, row: 8 });

  b.node('hb-tick', n.inject('every 15s', { repeat: 15, once: true, onceDelay: 5 }), { column: 0, row: 9 });
  b.node('hb-kpi', { type: 'pc-oee', name: 'plant dashboard', scope: 'dashboard', target: '', targetType: 'str', shifts: 8, throwErrors: false }, { column: 1, row: 9 });

  b.node('hb-shape', n.func('shape status', [
    '// Trim the dashboard payload down to what a status subscriber needs. The',
    '// full dashboard is large, and a heartbeat that ships 40 kB every 15',
    '// seconds is a heartbeat nobody subscribes to.',
    'const d = msg.payload;',
    '',
    'msg.payload = {',
    '  site: "Windsor Assembly Plant",',
    '  generatedAt: d.generatedAt,',
    '  shift: d.window.shift,',
    '  oee: d.headline.oee,',
    '  rating: d.headline.rating,',
    '  jph: d.headline.jph,',
    '  targetJph: d.headline.targetJph,',
    '  unitsCompleted: d.headline.unitsCompleted,',
    '  fpyPct: d.headline.fpyPct,',
    '  wip: d.headline.wip,',
    '  constraintLine: d.headline.constraintLine,',
    '  stationsDown: d.stations.downNow,',
    '  andonOpen: d.andon.open,',
    '  lines: d.lines.map((l) => ({ id: l.lineId, oee: l.oee, jph: l.jph, wip: l.wip }))',
    '};',
    'return msg;'
  ].join('\n')), { column: 2, row: 9 });

  b.node('hb-out', n.mqttOut('plant status', `${TOPIC_ROOT}/plant/status`, broker, { retain: true }), { column: 3, row: 9 });
  b.chain('hb-tick', 'hb-kpi', 'hb-shape', 'hb-out');

  // ---- error trap ---------------------------------------------------------
  b.node('catch-all', n.catchNode('catch flow errors'), { column: 0, row: 12 });
  b.node('catch-log', n.func('log flow error', [
    '// A node that throws stops its own branch. Catching centrally means one',
    '// place to see what broke, and the flow keeps running.',
    'msg.payload = {',
    '  source: msg.error?.source?.type || "unknown",',
    '  nodeId: msg.error?.source?.id || null,',
    '  message: msg.error?.message || "unknown error"',
    '};',
    'node.warn(`flow error in ${msg.payload.source}: ${msg.payload.message}`);',
    'return msg;'
  ].join('\n')), { column: 1, row: 12 });
  b.node('catch-debug', n.debug('flow errors', { tostatus: true, statusVal: 'payload.message' }), { column: 2, row: 12 });
  b.chain('catch-all', 'catch-log', 'catch-debug');
}

// ==========================================================================
// Generic line monitor - used for the Body Shop, and the shape the other
// line tabs specialise.
// ==========================================================================

function lineMonitor(b, broker, lineId, tabName) {
  const line = LINES.find((l) => l.id === lineId);

  b.tab(tabName, {
    info: [
      `# ${line.name}`,
      '',
      line.description,
      '',
      `Takt: **${line.taktSeconds}s** | Stations: **${line.stations.length}**`,
      '',
      'Subscribes to this line\'s station events, tracks state, and publishes a',
      'rolled-up line status every 10 seconds.'
    ].join('\n')
  });

  b.comment('header', `${line.name}\n\n${line.description}`, { column: 0, row: 0 });

  b.node('line-events', n.mqttIn(`${lineId} station events`, `${TOPIC_ROOT}/${lineId.toLowerCase()}/+/event`, broker), { column: 0, row: 1 });

  b.node('classify', n.func('classify event', [
    'const event = msg.payload || {};',
    'msg.eventType = event.type;',
    'msg.stationId = event.stationId;',
    'msg.vin = event.vin;',
    '',
    '// Cycle completions drive the line counter; state changes drive the',
    '// station tiles. Everything else is passed through untouched.',
    'if (event.type === "station.cycle") {',
    '  const count = (flow.get("cycleCount") || 0) + 1;',
    '  flow.set("cycleCount", count);',
    '  msg.cycleCount = count;',
    '}',
    'return msg;'
  ].join('\n')), { column: 1, row: 1 });

  b.node('route', n.switchNode('by event type', 'eventType', [
    { t: 'eq', v: 'station.state', vt: 'str' },
    { t: 'eq', v: 'station.cycle', vt: 'str' },
    { t: 'else' }
  ]), { column: 2, row: 1 });

  b.node('state-debug', n.debug('state changes', { complete: 'payload.payload', tostatus: true, statusVal: 'payload.payload.state' }), { column: 3, row: 0 });
  b.node('cycle-debug', n.debug('cycles', { active: false, complete: 'cycleCount' }), { column: 3, row: 2 });
  b.node('other-debug', n.debug('other', { active: false }), { column: 3, row: 4 });

  b.chain('line-events', 'classify', 'route');
  b.wire('route', 'state-debug', 0);
  b.wire('route', 'cycle-debug', 1);
  b.wire('route', 'other-debug', 2);

  // ---- line status publication -------------------------------------------
  b.node('status-tick', n.inject('every 10s', { repeat: 10, once: true, onceDelay: 3 }), { column: 0, row: 6 });
  b.node('status-oee', { type: 'pc-oee', name: `${lineId} OEE`, scope: 'line', target: lineId, targetType: 'str', shifts: 8, throwErrors: false }, { column: 1, row: 6 });

  b.node('status-shape', n.func('shape line status', [
    'const l = msg.payload;',
    'msg.payload = {',
    '  lineId: l.lineId,',
    '  name: l.lineName,',
    '  oee: l.oee,',
    '  availability: l.availability,',
    '  performance: l.performance,',
    '  quality: l.quality,',
    '  rating: l.rating,',
    '  jph: l.throughput.jph,',
    '  targetJph: l.throughput.targetJph,',
    '  wip: l.wip,',
    '  constraintStation: l.constraintStation,',
    '  stationsDown: l.stations.filter((s) => s.openStop).length',
    '};',
    '',
    '// Surface a degrading line on the node status dot so it is visible in the',
    '// editor without opening the debug sidebar.',
    'node.status({',
    '  fill: l.oee >= 85 ? "green" : l.oee >= 60 ? "yellow" : "red",',
    '  shape: "dot",',
    `  text: \`OEE \${l.oee}% | \${l.throughput.jph} JPH\``,
    '});',
    'return msg;'
  ].join('\n')), { column: 2, row: 6 });

  b.node('status-out', n.mqttOut(`${lineId} status`, `${TOPIC_ROOT}/${lineId.toLowerCase()}/status`, broker, { retain: true }), { column: 3, row: 6 });
  b.chain('status-tick', 'status-oee', 'status-shape', 'status-out');
}

// ==========================================================================
// 20 - Paint Shop
// ==========================================================================

function paintShop(b, broker) {
  b.tab('20 - Paint Shop', {
    info: [
      '# Paint Shop',
      '',
      'Paint quality is dominated by booth conditions. This tab watches humidity',
      'and temperature on the telemetry feed and raises a PROCESS andon before',
      'the defects start, rather than reacting to them afterwards.'
    ].join('\n')
  });

  b.comment('header', [
    'Booth condition monitoring',
    '',
    'Humidity outside 58-70% and temperature outside 22-25C are the two',
    'readings a paint shop alarms on: drift there shows up as dirt inclusion',
    'and orange peel about twenty minutes later.'
  ].join('\n'), { column: 0, row: 0 });

  b.node('telemetry-in', n.mqttIn('paint telemetry', `${TOPIC_ROOT}/paint/+/telemetry`, broker), { column: 0, row: 1 });

  b.node('check-booth', n.func('check booth conditions', [
    'const event = msg.payload || {};',
    'const m = event.payload?.metrics || {};',
    'const stationId = event.stationId;',
    '',
    '// Only the spray booths carry these readings.',
    'if (m.boothHumidityPct === undefined) return null;',
    '',
    'const problems = [];',
    'if (m.boothHumidityPct < 58 || m.boothHumidityPct > 70) {',
    '  problems.push(`humidity ${m.boothHumidityPct}% outside 58-70%`);',
    '}',
    'if (m.boothTempC < 22 || m.boothTempC > 25) {',
    '  problems.push(`temperature ${m.boothTempC}C outside 22-25C`);',
    '}',
    'if (m.filmThicknessUm && (m.filmThicknessUm < 95 || m.filmThicknessUm > 135)) {',
    '  problems.push(`film build ${m.filmThicknessUm}um outside 95-135um`);',
    '}',
    '',
    'if (!problems.length) {',
    '  node.status({ fill: "green", shape: "dot", text: `${stationId} nominal` });',
    '  return null;',
    '}',
    '',
    '// Do not re-alarm the same station every few seconds; a booth drifts',
    '// slowly and a repeated call is noise the operator learns to ignore.',
    'const key = `alarmed:${stationId}`;',
    'const last = flow.get(key) || 0;',
    'if (Date.now() - last < 120000) return null;',
    'flow.set(key, Date.now());',
    '',
    'node.status({ fill: "red", shape: "dot", text: `${stationId}: ${problems[0]}` });',
    'msg.stationId = stationId;',
    'msg.callType = "PROCESS";',
    'msg.raisedBy = "booth-monitor";',
    'msg.note = `Booth condition drift: ${problems.join("; ")}`;',
    'msg.payload = { stationId, problems, metrics: m };',
    'return msg;'
  ].join('\n')), { column: 1, row: 1 });

  b.node('raise-process', { type: 'pc-andon', name: 'raise PROCESS andon', operation: 'raise', station: 'stationId', stationType: 'msg', callType: 'PROCESS', andonId: 'payload.id', andonIdType: 'msg', throwErrors: false }, { column: 2, row: 1 });
  b.node('booth-debug', n.debug('booth alarms', { tostatus: true, statusVal: 'payload.note' }), { column: 3, row: 1 });
  b.chain('telemetry-in', 'check-booth', 'raise-process', 'booth-debug');

  // ---- paint inspection gate ---------------------------------------------
  b.comment('gate-header', [
    'Paint inspection gate (PAINT-60)',
    '',
    'Runs the IP-PAINT-VISUAL plan. A vehicle failing film build, colour',
    'delta-E or orange peel is held here rather than carrying the defect into',
    'general assembly, where the rework cost multiplies.'
  ].join('\n'), { column: 0, row: 4 });

  b.node('gate-in', n.mqttIn('arrivals at PAINT-60', `${TOPIC_ROOT}/plant/event/unit/moved`, broker), { column: 0, row: 5 });

  b.node('gate-filter', n.func('only PAINT-60 arrivals', [
    'const event = msg.payload || {};',
    'if (event.payload?.stationId !== "PAINT-60") return null;',
    '',
    'msg.vin = event.vin;',
    'msg.stationId = "PAINT-60";',
    '',
    '// Measurements the booth instruments would report for this body.',
    '// Mostly in spec, occasionally not - which is the point of having a gate.',
    'const drift = Math.random() < 0.08;',
    'msg.measurements = {',
    '  "FILM-BUILD": drift ? 88 + Math.random() * 6 : 104 + Math.random() * 14,',
    '  "DELTA-E": drift ? 0.85 + Math.random() * 0.4 : Math.random() * 0.6,',
    '  "ORANGE-PEEL": drift ? 15 + Math.random() * 4 : 5 + Math.random() * 7',
    '};',
    'msg.inspector = "paint-line-gauge";',
    'return msg;'
  ].join('\n')), { column: 1, row: 5 });

  b.node('paint-gate', { type: 'pc-quality-gate', name: 'IP-PAINT-VISUAL', mode: 'inspect', vin: 'vin', vinType: 'msg', station: 'PAINT-60', stationType: 'str', holdOnFail: true, raiseAndon: false, throwErrors: false }, { column: 2, row: 5 });

  b.node('gate-pass', n.func('pass to general assembly', [
    'node.status({ fill: "green", shape: "dot", text: `${msg.vin} passed paint` });',
    'return msg;'
  ].join('\n')), { column: 3, row: 4 });

  b.node('gate-hold', n.func('route to paint repair', [
    'const gate = msg.payload;',
    'node.warn(`${msg.vin} held at paint: ${gate.blockingDefects.map(d => d.code).join(", ")}`);',
    'node.status({ fill: "red", shape: "dot", text: `${msg.vin} -> repair` });',
    'msg.payload = {',
    '  vin: msg.vin,',
    '  defects: gate.blockingDefects,',
    '  recommendation: gate.recommendation',
    '};',
    'return msg;'
  ].join('\n')), { column: 3, row: 6 });

  b.node('pass-debug', n.debug('passed', { active: false }), { column: 4, row: 4 });
  b.node('hold-debug', n.debug('paint repair queue', { tostatus: true, statusVal: 'payload.vin' }), { column: 4, row: 6 });

  b.chain('gate-in', 'gate-filter', 'paint-gate');
  b.wire('paint-gate', 'gate-pass', 0);
  b.wire('paint-gate', 'gate-hold', 1);
  b.wire('gate-pass', 'pass-debug');
  b.wire('gate-hold', 'hold-debug');
}

// ==========================================================================
// 30 - Door Line
// ==========================================================================

function doorLine(b, broker) {
  b.tab('30 - Door Line', {
    info: [
      '# Door Line',
      '',
      'Doors are removed from the body after paint, trimmed offline on four',
      'parallel lanes, and re-hung in final assembly. Because the doors',
      'physically belong to their own body, door sets are **broadcast-built**',
      'against a specific VIN and can never be fitted to another vehicle.'
    ].join('\n')
  });

  b.comment('header', [
    'Broadcast build',
    '',
    'A door set carries the VIN it was removed from. The domain layer refuses',
    'to fit it to any other vehicle, so a mis-sequenced door is a hard error',
    'rather than a warranty claim eighteen months later.'
  ].join('\n'), { column: 0, row: 0 });

  b.node('door-events', n.mqttIn('door line events', `${TOPIC_ROOT}/door/+/event`, broker), { column: 0, row: 1 });
  b.node('door-classify', n.func('track door sets', [
    'const event = msg.payload || {};',
    'msg.eventType = event.type;',
    'msg.stationId = event.stationId;',
    '',
    'if (event.type === "subassembly.built" && event.payload?.classCode === "DRS") {',
    '  const built = (flow.get("doorSetsBuilt") || 0) + 1;',
    '  flow.set("doorSetsBuilt", built);',
    '  node.status({ fill: "green", shape: "dot", text: `${built} door sets built` });',
    '  msg.serial = event.payload.serial;',
    '  msg.forVin = event.payload.forVin;',
    '  return msg;',
    '}',
    'return null;'
  ].join('\n')), { column: 1, row: 1 });
  b.node('door-debug', n.debug('door sets', { complete: 'serial', tostatus: true, statusVal: 'forVin' }), { column: 2, row: 1 });
  b.chain('door-events', 'door-classify', 'door-debug');

  b.node('door-tick', n.inject('every 10s', { repeat: 10, once: true, onceDelay: 4 }), { column: 0, row: 4 });
  b.node('door-oee', { type: 'pc-oee', name: 'DOOR OEE', scope: 'line', target: 'DOOR', targetType: 'str', shifts: 8, throwErrors: false }, { column: 1, row: 4 });
  b.node('door-status', n.func('publish door status', [
    'const l = msg.payload;',
    'node.status({',
    '  fill: l.oee >= 85 ? "green" : l.oee >= 60 ? "yellow" : "red",',
    '  shape: "dot",',
    `  text: \`OEE \${l.oee}% | \${l.throughput.jph} sets/h\``,
    '});',
    'msg.payload = { lineId: l.lineId, oee: l.oee, jph: l.throughput.jph, rating: l.rating };',
    'return msg;'
  ].join('\n')), { column: 2, row: 4 });
  b.node('door-out', n.mqttOut('door status', `${TOPIC_ROOT}/door/status`, broker, { retain: true }), { column: 3, row: 4 });
  b.chain('door-tick', 'door-oee', 'door-status', 'door-out');
}

// ==========================================================================
// 40 - Wheel & Tire
// ==========================================================================

function wheelAndTire(b, broker) {
  b.tab('40 - Wheel & Tire', {
    info: [
      '# Wheel & Tire Line',
      '',
      'Five parallel lanes mount, inflate, balance and program TPMS for one',
      'matched wheel set per vehicle (four fitted plus a spare).',
      '',
      'Residual imbalance above 10 g fails the runout gate at TIRE-50, so the',
      'set never reaches final assembly.'
    ].join('\n')
  });

  b.comment('header', 'Balance monitoring\n\nImbalance trends upward as the balancer\'s spindle wears, so a rising\nmean is a maintenance signal well before any individual set fails.', { column: 0, row: 0 });

  b.node('tire-telemetry', n.mqttIn('balancer telemetry', `${TOPIC_ROOT}/tire/tire-30/telemetry`, broker), { column: 0, row: 1 });

  b.node('balance-trend', n.func('track balance trend', [
    'const m = msg.payload?.payload?.metrics || {};',
    'if (m.passRatePct === undefined) return null;',
    '',
    '// Keep a rolling window rather than a single reading: one bad set is',
    '// noise, a falling mean over twenty is a worn spindle.',
    'const window = context.get("window") || [];',
    'window.push(m.passRatePct);',
    'if (window.length > 20) window.shift();',
    'context.set("window", window);',
    '',
    'const mean = window.reduce((a, b) => a + b, 0) / window.length;',
    'const degrading = window.length >= 10 && mean < 95;',
    '',
    'node.status({',
    '  fill: degrading ? "yellow" : "green",',
    '  shape: "dot",',
    `  text: \`pass rate \${mean.toFixed(1)}% (n=\${window.length})\``,
    '});',
    '',
    'if (!degrading) return null;',
    '',
    'const last = context.get("lastWarn") || 0;',
    'if (Date.now() - last < 300000) return null;',
    'context.set("lastWarn", Date.now());',
    '',
    'msg.stationId = "TIRE-30";',
    'msg.callType = "TOOLING";',
    'msg.note = `Balancer pass rate down to ${mean.toFixed(1)}% over ${window.length} sets - check spindle runout`;',
    'msg.payload = { stationId: "TIRE-30", meanPassRate: Number(mean.toFixed(2)), samples: window.length };',
    'return msg;'
  ].join('\n')), { column: 1, row: 1 });

  b.node('tire-andon', { type: 'pc-andon', name: 'raise TOOLING andon', operation: 'raise', station: 'stationId', stationType: 'msg', callType: 'TOOLING', andonId: 'payload.id', andonIdType: 'msg', throwErrors: false }, { column: 2, row: 1 });
  b.node('tire-debug', n.debug('balancer warnings', { tostatus: true, statusVal: 'payload.note' }), { column: 3, row: 1 });
  b.chain('tire-telemetry', 'balance-trend', 'tire-andon', 'tire-debug');

  b.node('tire-tick', n.inject('every 10s', { repeat: 10, once: true, onceDelay: 5 }), { column: 0, row: 4 });
  b.node('tire-oee', { type: 'pc-oee', name: 'TIRE OEE', scope: 'line', target: 'TIRE', targetType: 'str', shifts: 8, throwErrors: false }, { column: 1, row: 4 });
  b.node('tire-status', n.func('publish tire status', [
    'const l = msg.payload;',
    'node.status({',
    '  fill: l.oee >= 85 ? "green" : l.oee >= 60 ? "yellow" : "red",',
    '  shape: "dot",',
    `  text: \`OEE \${l.oee}% | \${l.throughput.jph} sets/h\``,
    '});',
    'msg.payload = { lineId: l.lineId, oee: l.oee, jph: l.throughput.jph, rating: l.rating };',
    'return msg;'
  ].join('\n')), { column: 2, row: 4 });
  b.node('tire-out', n.mqttOut('tire status', `${TOPIC_ROOT}/tire/status`, broker, { retain: true }), { column: 3, row: 4 });
  b.chain('tire-tick', 'tire-oee', 'tire-status', 'tire-out');
}

// ==========================================================================
// 50 - Sub-Assembly
// ==========================================================================

function subAssembly(b, broker) {
  b.tab('50 - Sub-Assembly', {
    info: [
      '# Sub-Assembly Cells',
      '',
      'Powertrain, cockpit, seat set and corner modules, each serialised and',
      'hot-tested before it enters the buffer.',
      '',
      'The flow below watches buffer depth. Final assembly starves within two',
      'takts of a feeder stopping, so the warning has to come from the buffer',
      'level, not from the line stopping.'
    ].join('\n')
  });

  b.comment('header', 'Buffer starvation watch\n\nBelow two units of buffer, a feeder hiccup starves final assembly.\nThat is the point at which someone needs to know - not when the line stops.', { column: 0, row: 0 });

  b.node('buffer-tick', n.inject('every 8s', { repeat: 8, once: true, onceDelay: 2 }), { column: 0, row: 1 });

  b.node('read-buffers', n.func('read buffer levels', [
    '// The plant model and services are exposed to function nodes through',
    '// global context, so a flow can answer a domain question directly rather',
    '// than making an HTTP call back into its own process.',
    'const core = global.get("productionCore");',
    'msg.payload = core.production.bufferLevels();',
    'return msg;'
  ].join('\n')), { column: 1, row: 1 });

  b.node('check-starvation', n.func('check for starvation risk', [
    'const buffers = msg.payload || [];',
    'const atRisk = buffers.filter((b) => b.starvationRisk);',
    '',
    'node.status({',
    '  fill: atRisk.length ? "yellow" : "green",',
    '  shape: "dot",',
    `  text: atRisk.length ? \`\${atRisk.length} classes low\` : "buffers healthy"`,
    '});',
    '',
    'if (!atRisk.length) return [null, msg];',
    '',
    '// One call per class at most every five minutes.',
    'const now = Date.now();',
    'const alerts = atRisk.filter((b) => {',
    '  const key = `alerted:${b.classCode}`;',
    '  if (now - (flow.get(key) || 0) < 300000) return false;',
    '  flow.set(key, now);',
    '  return true;',
    '});',
    'if (!alerts.length) return [null, msg];',
    '',
    'const first = alerts[0];',
    'msg.stationId = first.installsAt;',
    'msg.callType = "MATERIAL";',
    'msg.raisedBy = "buffer-monitor";',
    'msg.note = `${first.classCode} buffer down to ${first.available} - ${first.installsAt} will starve`;',
    'msg.payload = { atRisk: alerts, all: buffers };',
    'return [msg, null];'
  ].join('\n'), { outputs: 2 }), { column: 2, row: 1 });

  b.node('starve-andon', { type: 'pc-andon', name: 'raise MATERIAL andon', operation: 'raise', station: 'stationId', stationType: 'msg', callType: 'MATERIAL', andonId: 'payload.id', andonIdType: 'msg', throwErrors: false }, { column: 3, row: 0 });
  b.node('buffer-out', n.mqttOut('buffer levels', `${TOPIC_ROOT}/subasm/buffers`, broker, { retain: true }), { column: 3, row: 2 });
  b.node('starve-debug', n.debug('starvation alerts', { tostatus: true, statusVal: 'payload.note' }), { column: 4, row: 0 });

  b.chain('buffer-tick', 'read-buffers', 'check-starvation');
  b.wire('check-starvation', 'starve-andon', 0);
  b.wire('check-starvation', 'buffer-out', 1);
  b.wire('starve-andon', 'starve-debug');

  // ---- quarantine watch ---------------------------------------------------
  b.comment('q-header', 'Quarantine watch\n\nA sub-assembly that fails its hot test is quarantined and can never be\nfitted. Tracking the rate is an early warning on an incoming supplier lot.', { column: 0, row: 5 });
  b.node('quarantine-in', n.mqttIn('quarantine events', `${TOPIC_ROOT}/plant/event/subassembly/quarantined`, broker), { column: 0, row: 6 });
  b.node('quarantine-count', n.func('count quarantines', [
    'const event = msg.payload || {};',
    'const classCode = event.payload?.classCode || "unknown";',
    'const counts = flow.get("quarantines") || {};',
    'counts[classCode] = (counts[classCode] || 0) + 1;',
    'flow.set("quarantines", counts);',
    '',
    'const total = Object.values(counts).reduce((a, b) => a + b, 0);',
    'node.status({ fill: "yellow", shape: "dot", text: `${total} quarantined` });',
    '',
    'msg.payload = { serial: event.payload?.serial, classCode, reason: event.payload?.quarantineReason, counts };',
    'return msg;'
  ].join('\n')), { column: 1, row: 6 });
  b.node('quarantine-debug', n.debug('quarantined serials', { tostatus: true, statusVal: 'payload.serial' }), { column: 2, row: 6 });
  b.chain('quarantine-in', 'quarantine-count', 'quarantine-debug');
}

// ==========================================================================
// 60 - Main Assembly
// ==========================================================================

function mainAssembly(b, broker) {
  b.tab('60 - Main Assembly', {
    info: [
      '# Main Assembly',
      '',
      'The production spine: trim, chassis (including powertrain marriage) and',
      'final build.',
      '',
      'This tab carries the torque verification for the critical-to-quality',
      'stations. A fastener outside its window at CHAS-10 is a safety defect,',
      'not a cosmetic one, so it raises a CRITICAL defect that the end-of-line',
      'gate will refuse to release.'
    ].join('\n')
  });

  b.comment('header', [
    'Torque verification - critical to quality',
    '',
    'CHAS-10 (powertrain marriage), CHAS-20 (suspension), FINAL-10 (wheels)',
    'and FINAL-20 (seats) are the fastening operations that hold the vehicle',
    'together. Every one is verified against its specification window.'
  ].join('\n'), { column: 0, row: 0 });

  b.node('torque-in', n.mqttIn('torque telemetry', `${TOPIC_ROOT}/mainasm/+/telemetry`, broker), { column: 0, row: 1 });

  b.node('verify-torque', n.func('verify against spec', [
    'const core = global.get("productionCore");',
    'const plant = global.get("plantModel");',
    'const event = msg.payload || {};',
    'const m = event.payload?.metrics || {};',
    'const stationId = event.stationId;',
    '',
    'if (m.lastTorqueNm === undefined || !m.lastTorqueNm) return null;',
    '',
    'const station = plant.getStation(stationId);',
    'const spec = station?.torqueSpecs?.[0];',
    'if (!spec) return null;',
    '',
    'const low = spec.nm - spec.toleranceNm;',
    'const high = spec.nm + spec.toleranceNm;',
    'const value = m.lastTorqueNm;',
    'const inSpec = value >= low && value <= high;',
    '',
    'node.status({',
    '  fill: inSpec ? "green" : "red",',
    '  shape: "dot",',
    `  text: \`\${stationId} \${value}Nm (\${low}-\${high})\``,
    '});',
    '',
    'if (inSpec) return null;',
    '',
    '// Find the vehicle currently at this station; a torque reading with no',
    '// vehicle behind it cannot be attributed and is dropped rather than',
    '// raised against the wrong VIN.',
    'const state = core.repository.get("stationStates", stationId);',
    'const vin = state?.currentVin;',
    'if (!vin) return null;',
    '',
    'msg.vin = vin;',
    'msg.stationId = stationId;',
    'msg.code = value < low ? "TORQUE_LOW" : "TORQUE_HIGH";',
    'msg.payload = { vin, stationId, specId: spec.id, value, low, high };',
    'return msg;'
  ].join('\n')), { column: 1, row: 1 });

  b.node('raise-torque-defect', n.func('raise torque defect', [
    'const core = global.get("productionCore");',
    'const d = msg.payload;',
    '',
    'const defect = core.quality.raiseDefect({',
    '  code: msg.code,',
    '  vin: d.vin,',
    '  stationId: d.stationId,',
    '  detectedBy: "torque-monitor",',
    '  measurement: { specId: d.specId, value: d.value, limits: [d.low, d.high] }',
    '});',
    '',
    'node.warn(`${msg.code} on ${d.vin} at ${d.stationId}: ${d.value}Nm outside ${d.low}-${d.high}Nm`);',
    'msg.payload = defect;',
    'return msg;'
  ].join('\n')), { column: 2, row: 1 });

  b.node('torque-debug', n.debug('torque defects', { tostatus: true, statusVal: 'payload.code' }), { column: 3, row: 1 });
  b.chain('torque-in', 'verify-torque', 'raise-torque-defect', 'torque-debug');

  // ---- marriage verification ---------------------------------------------
  b.comment('marriage-header', [
    'Powertrain marriage verification (CHAS-10)',
    '',
    'Decking is the point of no return: once the powertrain is bolted to the',
    'body, separating them is hours of work. So the check that the right',
    'serialised powertrain went into the right VIN happens here, immediately.'
  ].join('\n'), { column: 0, row: 4 });

  b.node('marriage-in', n.mqttIn('sub-assembly consumed', `${TOPIC_ROOT}/plant/event/subassembly/consumed`, broker), { column: 0, row: 5 });

  b.node('verify-marriage', n.func('verify genealogy link', [
    'const core = global.get("productionCore");',
    'const event = msg.payload || {};',
    'const p = event.payload || {};',
    '',
    'if (p.stationId !== "CHAS-10") return null;',
    '',
    'const genealogy = core.repository.get("genealogies", p.vin);',
    'const linked = genealogy?.serialIndex?.includes(p.serial);',
    '',
    'node.status({',
    '  fill: linked ? "green" : "red",',
    '  shape: "dot",',
    `  text: linked ? \`\${p.serial} -> \${p.vin}\` : "GENEALOGY LINK MISSING"`,
    '});',
    '',
    'msg.payload = {',
    '  vin: p.vin,',
    '  serial: p.serial,',
    '  classCode: p.classCode,',
    '  genealogyLinked: Boolean(linked),',
    '  componentCount: genealogy?.components?.length || 0',
    '};',
    'msg.vin = p.vin;',
    'return msg;'
  ].join('\n')), { column: 1, row: 5 });

  b.node('marriage-check', n.switchNode('linked?', 'payload.genealogyLinked', [
    { t: 'true' },
    { t: 'false' }
  ]), { column: 2, row: 5 });

  b.node('marriage-ok', n.debug('marriages recorded', { active: false, complete: 'payload' }), { column: 3, row: 4 });
  b.node('marriage-fail', n.func('genealogy break', [
    '// A consumed serial that is not in the vehicle\'s genealogy means the',
    '// traceability chain is broken for that VIN. That is a stop-the-line',
    '// condition: the vehicle cannot be certified as built.',
    'node.error(`Genealogy link missing: ${msg.payload.serial} consumed by ${msg.payload.vin}`, msg);',
    'msg.stationId = "CHAS-10";',
    'msg.callType = "QUALITY";',
    'msg.note = `Genealogy link missing for ${msg.payload.serial}`;',
    'return msg;'
  ].join('\n')), { column: 3, row: 6 });
  b.node('marriage-andon', { type: 'pc-andon', name: 'stop the line', operation: 'raise', station: 'stationId', stationType: 'msg', callType: 'QUALITY', andonId: 'payload.id', andonIdType: 'msg', throwErrors: false }, { column: 4, row: 6 });

  b.chain('marriage-in', 'verify-marriage', 'marriage-check');
  b.wire('marriage-check', 'marriage-ok', 0);
  b.wire('marriage-check', 'marriage-fail', 1);
  b.wire('marriage-fail', 'marriage-andon');

  // ---- line status --------------------------------------------------------
  b.node('ma-tick', n.inject('every 10s', { repeat: 10, once: true, onceDelay: 6 }), { column: 0, row: 9 });
  b.node('ma-oee', { type: 'pc-oee', name: 'MAINASM OEE', scope: 'line', target: 'MAINASM', targetType: 'str', shifts: 8, throwErrors: false }, { column: 1, row: 9 });
  b.node('ma-shape', n.func('shape status', [
    'const l = msg.payload;',
    'node.status({',
    '  fill: l.oee >= 85 ? "green" : l.oee >= 60 ? "yellow" : "red",',
    '  shape: "dot",',
    `  text: \`OEE \${l.oee}% | constraint \${l.constraintStation}\``,
    '});',
    'msg.payload = {',
    '  lineId: l.lineId, oee: l.oee, jph: l.throughput.jph,',
    '  constraintStation: l.constraintStation, wip: l.wip,',
    '  stations: l.stations.map((s) => ({ id: s.stationId, state: s.state, oee: s.oee }))',
    '};',
    'return msg;'
  ].join('\n')), { column: 2, row: 9 });
  b.node('ma-out', n.mqttOut('mainasm status', `${TOPIC_ROOT}/mainasm/status`, broker, { retain: true }), { column: 3, row: 9 });
  b.chain('ma-tick', 'ma-oee', 'ma-shape', 'ma-out');
}

// ==========================================================================
// 70 - Quality & End-of-Line
// ==========================================================================

function qualityAndEol(b, broker) {
  b.tab('70 - Quality & EOL', {
    info: [
      '# Quality & End-of-Line',
      '',
      'Alignment, headlamp aim, roll and brake test, water leak, DTC scan and',
      'final audit.',
      '',
      'EOL-60 is the release gate. A vehicle leaves the plant only when every',
      'defect against it is closed - which is why the flow completes the unit',
      'through the domain service rather than just marking a flag.'
    ].join('\n')
  });

  b.comment('header', [
    'End-of-line release gate (EOL-60)',
    '',
    'The last decision in the plant. Pass releases the vehicle to the yard and',
    'seals its genealogy record; hold sends it to the repair bay.'
  ].join('\n'), { column: 0, row: 0 });

  b.node('eol-in', n.mqttIn('arrivals at EOL-60', `${TOPIC_ROOT}/plant/event/unit/moved`, broker), { column: 0, row: 1 });

  b.node('eol-filter', n.func('only EOL-60 arrivals', [
    'const event = msg.payload || {};',
    'if (event.payload?.stationId !== "EOL-60") return null;',
    'msg.vin = event.vin;',
    'msg.stationId = "EOL-60";',
    'msg.inspector = "final-audit";',
    '',
    '// Audit demerit points: mostly clean, occasionally over the 25-point limit.',
    'msg.measurements = {',
    '  "AUDIT-DEMERITS": Math.random() < 0.06',
    '    ? 26 + Math.floor(Math.random() * 14)',
    '    : Math.floor(Math.random() * 18)',
    '};',
    'return msg;'
  ].join('\n')), { column: 1, row: 1 });

  b.node('eol-gate', { type: 'pc-quality-gate', name: 'final audit gate', mode: 'inspect', vin: 'vin', vinType: 'msg', station: 'EOL-60', stationType: 'str', holdOnFail: true, raiseAndon: true, throwErrors: false }, { column: 2, row: 1 });

  b.node('release-vehicle', { type: 'pc-unit', name: 'release to yard', operation: 'complete', vin: 'vin', vinType: 'msg', station: '', stationType: 'str', reason: '', operator: 'final-audit', force: false, throwErrors: false }, { column: 3, row: 0 });

  b.node('released', n.func('log release', [
    'const unit = msg.payload;',
    'if (!unit) {',
    '  // The domain refused the release; msg.error explains why.',
    '  node.status({ fill: "red", shape: "ring", text: msg.error?.code || "refused" });',
    '  return null;',
    '}',
    '',
    'const shipped = (flow.get("shipped") || 0) + 1;',
    'flow.set("shipped", shipped);',
    'node.status({ fill: "green", shape: "dot", text: `${shipped} released this session` });',
    '',
    'msg.payload = {',
    '  vin: unit.vin,',
    '  model: unit.modelName,',
    '  colour: unit.colour,',
    '  buildMinutes: unit.buildMinutes,',
    '  firstPass: unit.reworkCount === 0,',
    '  releasedAt: unit.releasedAt',
    '};',
    'msg.topic = "vehicle/released";',
    'return msg;'
  ].join('\n')), { column: 4, row: 0 });

  b.node('release-out', n.mqttOut('vehicle released', `${TOPIC_ROOT}/plant/released`, broker), { column: 5, row: 0 });

  b.node('repair-bay', n.func('route to repair bay', [
    'const gate = msg.payload;',
    'const queue = flow.get("repairQueue") || [];',
    'queue.push({ vin: msg.vin, at: new Date().toISOString(), defects: gate.blockingDefects });',
    'if (queue.length > 50) queue.shift();',
    'flow.set("repairQueue", queue);',
    '',
    'node.status({ fill: "yellow", shape: "dot", text: `${queue.length} in repair bay` });',
    'msg.payload = { vin: msg.vin, queueDepth: queue.length, defects: gate.blockingDefects };',
    'return msg;'
  ].join('\n')), { column: 3, row: 3 });

  b.node('repair-debug', n.debug('repair bay', { tostatus: true, statusVal: 'payload.vin' }), { column: 4, row: 3 });

  b.chain('eol-in', 'eol-filter', 'eol-gate');
  b.wire('eol-gate', 'release-vehicle', 0);
  b.wire('eol-gate', 'repair-bay', 1);
  b.chain('release-vehicle', 'released', 'release-out');
  b.wire('repair-bay', 'repair-debug');

  // ---- quality summary ----------------------------------------------------
  b.comment('q-header', 'Quality summary\n\nPareto, first-pass yield and DPMO for the current shift, published for the\nHMI and the morning quality meeting.', { column: 0, row: 6 });
  b.node('q-tick', n.inject('every 30s', { repeat: 30, once: true, onceDelay: 8 }), { column: 0, row: 7 });
  b.node('q-summary', n.func('build quality summary', [
    'const core = global.get("productionCore");',
    'const summary = core.quality.summary();',
    '',
    'node.status({',
    '  fill: summary.bySeverity.CRITICAL > 0 ? "red" : summary.bySeverity.MAJOR > 0 ? "yellow" : "green",',
    '  shape: "dot",',
    `  text: \`FPY \${summary.firstPassYield.fpyPct ?? "-"}% | \${summary.defectCount} defects\``,
    '});',
    '',
    'msg.payload = {',
    '  fpyPct: summary.firstPassYield.fpyPct,',
    '  dpmo: summary.dpmo,',
    '  sigmaLevel: summary.sigmaLevel,',
    '  defectCount: summary.defectCount,',
    '  openDefects: summary.openDefects,',
    '  bySeverity: summary.bySeverity,',
    '  topDefects: summary.paretoByCode.slice(0, 5),',
    '  worstStations: summary.paretoByStation.slice(0, 5)',
    '};',
    'return msg;'
  ].join('\n')), { column: 1, row: 7 });
  b.node('q-out', n.mqttOut('quality summary', `${TOPIC_ROOT}/plant/quality`, broker, { retain: true }), { column: 2, row: 7 });
  b.chain('q-tick', 'q-summary', 'q-out');
}

// ==========================================================================
// 80 - Andon & Downtime
// ==========================================================================

function andonAndDowntime(b, broker) {
  b.tab('80 - Andon & Downtime', {
    info: [
      '# Andon & Downtime',
      '',
      'The andon board. What matters is not how many cords were pulled but how',
      'fast help arrived, so this tab runs the escalation ladder:',
      '',
      '| Tier | Role | After |',
      '| --- | --- | --- |',
      '| 1 | Team leader | immediately |',
      '| 2 | Area supervisor | 5 minutes |',
      '| 3 | Plant manager | 15 minutes |',
      '',
      'A call that blows its SLA is escalated automatically by the sweep below.'
    ].join('\n')
  });

  b.comment('header', 'Escalation sweep\n\nRuns every 30 seconds. Any open call past its SLA moves up the ladder.', { column: 0, row: 0 });

  b.node('sweep-tick', n.inject('every 30s', { repeat: 30, once: true, onceDelay: 10 }), { column: 0, row: 1 });
  b.node('sweep', { type: 'pc-andon', name: 'escalate overdue', operation: 'sweep', station: '', stationType: 'str', callType: 'MAINTENANCE', andonId: '', andonIdType: 'str', throwErrors: false }, { column: 1, row: 1 });

  b.node('sweep-result', n.func('report escalations', [
    'const escalated = msg.payload || [];',
    'if (!escalated.length) {',
    '  node.status({ fill: "green", shape: "dot", text: "no overdue calls" });',
    '  return null;',
    '}',
    '',
    'node.status({ fill: "red", shape: "dot", text: `${escalated.length} escalated` });',
    'node.warn(`Escalated ${escalated.length} andon call(s): ` +',
    '  escalated.map((a) => `${a.id} ${a.stationId} -> ${a.escalatedTo}`).join(", "));',
    '',
    'msg.payload = escalated.map((a) => ({',
    '  id: a.id, stationId: a.stationId, lineId: a.lineId,',
    '  callType: a.callType, tier: a.escalationTier, escalatedTo: a.escalatedTo',
    '}));',
    'return msg;'
  ].join('\n')), { column: 2, row: 1 });

  b.node('escalation-out', n.mqttOut('escalations', `${TOPIC_ROOT}/plant/andon/escalated`, broker), { column: 3, row: 1 });
  b.chain('sweep-tick', 'sweep', 'sweep-result', 'escalation-out');

  // ---- live andon board ---------------------------------------------------
  b.comment('board-header', 'Live andon board\n\nEvery call, as it happens. Red calls stop the line.', { column: 0, row: 4 });
  b.node('andon-in', n.mqttIn('andon events', `${TOPIC_ROOT}/plant/event/andon/#`, broker), { column: 0, row: 5 });

  b.node('board', n.func('update andon board', [
    'const event = msg.payload || {};',
    'const p = event.payload || {};',
    'const board = flow.get("board") || {};',
    '',
    'if (event.type === "andon.raised") {',
    '  board[p.id] = {',
    '    id: p.id, stationId: p.stationId, lineId: p.lineId,',
    '    callType: p.callType, colour: p.colour, stopsLine: p.stopsLine,',
    '    raisedAt: event.timestamp, status: "RAISED"',
    '  };',
    '} else if (event.type === "andon.acknowledged" && board[p.id]) {',
    '  board[p.id].status = "ACKNOWLEDGED";',
    '  board[p.id].responseSeconds = p.responseSeconds;',
    '  board[p.id].slaMet = p.slaMet;',
    '} else if (event.type === "andon.escalated" && board[p.id]) {',
    '  board[p.id].status = "ESCALATED";',
    '  board[p.id].escalatedTo = p.escalatedTo;',
    '} else if (event.type === "andon.resolved") {',
    '  delete board[p.id];',
    '}',
    '',
    'flow.set("board", board);',
    'const open = Object.values(board);',
    'const stopping = open.filter((a) => a.stopsLine).length;',
    '',
    'node.status({',
    '  fill: stopping ? "red" : open.length ? "yellow" : "green",',
    '  shape: "dot",',
    `  text: open.length ? \`\${open.length} open, \${stopping} stopping the line\` : "board clear"`,
    '});',
    '',
    'msg.payload = { open, count: open.length, lineStopping: stopping };',
    'return msg;'
  ].join('\n')), { column: 1, row: 5 });

  b.node('board-out', n.mqttOut('andon board', `${TOPIC_ROOT}/plant/andon/board`, broker, { retain: true }), { column: 2, row: 5 });
  b.chain('andon-in', 'board', 'board-out');

  // ---- downtime tracking --------------------------------------------------
  b.comment('dt-header', 'Downtime tracking\n\nEvery stop, with its ISO 22400 reason code and Six Big Losses category.\nStops shorter than the micro-stop threshold never reach here.', { column: 0, row: 8 });
  b.node('dt-in', n.mqttIn('downtime events', `${TOPIC_ROOT}/plant/event/downtime/#`, broker), { column: 0, row: 9 });

  b.node('dt-track', n.func('track downtime', [
    'const event = msg.payload || {};',
    'const p = event.payload || {};',
    '',
    'if (event.type === "downtime.started") {',
    '  node.status({ fill: "red", shape: "dot", text: `${p.stationId}: ${p.reasonCode}` });',
    '  msg.payload = { action: "started", ...p };',
    '  return msg;',
    '}',
    '',
    'if (event.type === "downtime.ended") {',
    '  const totals = flow.get("totals") || {};',
    '  totals[p.reasonCode] = (totals[p.reasonCode] || 0) + (p.durationSeconds || 0);',
    '  flow.set("totals", totals);',
    '',
    '  const worst = Object.entries(totals).sort((a, b) => b[1] - a[1])[0];',
    '  node.status({',
    '    fill: "green", shape: "dot",',
    `    text: worst ? \`top loss: \${worst[0]} \${Math.round(worst[1] / 60)}min\` : "no losses"`,
    '  });',
    '',
    '  msg.payload = { action: "ended", ...p, totalsByReason: totals };',
    '  return msg;',
    '}',
    'return null;'
  ].join('\n')), { column: 1, row: 9 });

  b.node('dt-debug', n.debug('downtime', { tostatus: true, statusVal: 'payload.reasonCode' }), { column: 2, row: 9 });
  b.chain('dt-in', 'dt-track', 'dt-debug');
}

// ==========================================================================
// 85 - Maintenance
// ==========================================================================

function maintenance(b, broker) {
  b.tab('85 - Maintenance', {
    info: [
      '# Maintenance & Station Control',
      '',
      'Three things live here.',
      '',
      '**Preventive-maintenance scheduling.** Every station carries a count of',
      'cycles since its last service against an interval derived from its MTBF.',
      'This flow watches those counters and publishes which stations are coming',
      'due. Overdue stations fail more often - skipping PM is not free.',
      '',
      '**Station control over MQTT.** A SCADA system or PLC can start, stop and',
      'hand stations to maintenance by publishing to',
      '`' + TOPIC_ROOT + '/<line>/<station>/cmd`:',
      '',
      '```json',
      '{ "command": "stop", "apiKey": "...", "operator": "scada",',
      '  "reasonCode": "SCHEDULED_BREAK", "reason": "Lunch" }',
      '```',
      '',
      'Commands: `start`, `stop`, `maintenance`, `completeMaintenance`. Every',
      'command is answered on `.../cmd/ack`, including the ones the domain',
      'refused - a controller that never hears back cannot tell a rejected',
      'command from a lost one.',
      '',
      'Commands go through exactly the same lockout as the REST API: a station',
      'under maintenance cannot be started over MQTT any more than it can by',
      'clicking a button.'
    ].join('\n')
  });

  // ---- PM due watcher ----------------------------------------------------
  b.comment('pm-header', [
    'Preventive-maintenance watch',
    '',
    'Cycles since last service against the MTBF-derived interval. Alerts once',
    'per station per status change, so a station sitting at DUE does not page',
    'someone every minute.'
  ].join('\n'), { column: 0, row: 0 });

  b.node('pm-tick', n.inject('every 60s', { repeat: 60, once: true, onceDelay: 12 }), { column: 0, row: 1 });
  b.node('pm-status', { type: 'pc-station', name: 'PM status', operation: 'pmStatus', station: '', stationType: 'str', state: 'RUNNING', reasonCode: '', lineFilter: '', maintenanceType: '', throwErrors: false }, { column: 1, row: 1 });

  b.node('pm-evaluate', n.func('evaluate PM due', [
    'const all = msg.payload || [];',
    'const attention = all.filter((s) => s.status !== "OK");',
    '',
    '// Remember the last status alerted per station and only alert on change.',
    'const seen = flow.get("pmAlerted") || {};',
    'const changed = attention.filter((s) => seen[s.stationId] !== s.status);',
    'all.forEach((s) => { if (s.status === "OK") delete seen[s.stationId]; });',
    'changed.forEach((s) => { seen[s.stationId] = s.status; });',
    'flow.set("pmAlerted", seen);',
    '',
    'const overdue = attention.filter((s) => s.status === "OVERDUE").length;',
    'node.status({',
    '  fill: overdue ? "red" : attention.length ? "yellow" : "green",',
    '  shape: "dot",',
    `  text: attention.length ? \`\${attention.length} need PM, \${overdue} overdue\` : "all stations in interval"`,
    '});',
    '',
    'const board = {',
    '  generatedAt: new Date().toISOString(),',
    '  attention: attention.map((s) => ({',
    '    stationId: s.stationId, lineId: s.lineId, status: s.status,',
    '    usedPct: s.usedPct, remainingCycles: s.remainingCycles, controlMode: s.controlMode',
    '  }))',
    '};',
    '',
    'const alerts = changed.length',
    '  ? { payload: changed.map((s) => `${s.stationId} ${s.status} (${s.usedPct}% of interval)`) }',
    '  : null;',
    'return [{ payload: board }, alerts];'
  ].join('\n'), { outputs: 2 }), { column: 2, row: 1 });

  b.node('pm-board', n.mqttOut('PM board', `${TOPIC_ROOT}/plant/maintenance/due`, broker, { retain: true }), { column: 3, row: 0 });
  b.node('pm-alerts', n.debug('PM alerts', { tostatus: true, statusVal: 'payload' }), { column: 3, row: 2 });
  b.chain('pm-tick', 'pm-status', 'pm-evaluate');
  b.wire('pm-evaluate', 'pm-board', 0);
  b.wire('pm-evaluate', 'pm-alerts', 1);

  // ---- MQTT command channel ------------------------------------------------
  b.comment('cmd-header', [
    'Station control over MQTT',
    '',
    'Publish to ' + TOPIC_ROOT + '/<line>/<station>/cmd. The payload must carry',
    'the API key: the WebSocket listener is reachable from the internet on a',
    'hosted demo, and an unauthenticated stop command is a denial of service.'
  ].join('\n'), { column: 0, row: 4 });

  b.node('cmd-in', n.mqttIn('station commands', `${TOPIC_ROOT}/+/+/cmd`, broker), { column: 0, row: 5 });

  b.node('cmd-validate', n.func('validate command', [
    '// Topic: <root>/<site>/<line>/<station>/cmd',
    'const parts = (msg.topic || "").split("/");',
    'const stationId = (parts[3] || "").toUpperCase();',
    'const body = typeof msg.payload === "object" && msg.payload ? msg.payload : {};',
    'const command = String(body.command || "");',
    'const allowed = ["start", "stop", "maintenance", "completeMaintenance"];',
    '',
    'msg.ackTopic = `${msg.topic}/ack`;',
    'msg.stationId = stationId;',
    'msg.command = command;',
    '',
    'const reject = (code, message) => {',
    '  msg.payload = { ok: false, stationId, command, error: { code, message }, at: new Date().toISOString() };',
    '  node.warn(`rejected ${command || "?"} for ${stationId || "?"}: ${message}`);',
    '  return [null, msg];',
    '};',
    '',
    'if (body.apiKey !== env.get("PC_API_KEY")) return reject("UNAUTHORIZED", "apiKey is missing or wrong");',
    'if (!allowed.includes(command)) return reject("VALIDATION_FAILED", `command must be one of ${allowed.join(", ")}`);',
    'if (!global.get("plantModel").getStation(stationId)) return reject("NOT_FOUND", `unknown station ${stationId}`);',
    '',
    '// Carry the command fields where pc-station expects them.',
    'msg.operator = body.operator || "mqtt";',
    'msg.technician = body.technician || body.operator || "mqtt";',
    'msg.reasonCode = body.reasonCode;',
    'msg.reason = body.reason;',
    'msg.note = body.note;',
    'msg.maintenanceType = body.type;',
    'msg.plannedMinutes = body.plannedMinutes;',
    'msg.findings = body.findings;',
    'msg.checklist = body.checklist;',
    'return [msg, null];'
  ].join('\n'), { outputs: 2 }), { column: 1, row: 5 });

  b.node('cmd-route', n.switchNode('by command', 'command', [
    { t: 'eq', v: 'start', vt: 'str' },
    { t: 'eq', v: 'stop', vt: 'str' },
    { t: 'eq', v: 'maintenance', vt: 'str' },
    { t: 'eq', v: 'completeMaintenance', vt: 'str' }
  ], { checkall: false }), { column: 2, row: 5 });

  const control = (operation, label) => ({
    type: 'pc-station', name: label, operation,
    station: 'stationId', stationType: 'msg', state: 'RUNNING',
    reasonCode: '', lineFilter: '', maintenanceType: '', throwErrors: false
  });
  b.node('cmd-start', control('start', 'start'), { column: 3, row: 4 });
  b.node('cmd-stop', control('stop', 'stop'), { column: 3, row: 5 });
  b.node('cmd-maint', control('maintenance', 'start maintenance'), { column: 3, row: 6 });
  b.node('cmd-complete', control('completeMaintenance', 'complete maintenance'), { column: 3, row: 7 });

  b.node('cmd-ack', n.func('build acknowledgement', [
    '// pc-station reports a domain refusal on msg.error rather than throwing,',
    '// so a refused command still produces an answer for the controller.',
    'if (msg.error) {',
    '  msg.payload = {',
    '    ok: false, stationId: msg.stationId, command: msg.command,',
    '    error: { code: msg.error.code, message: msg.error.message },',
    '    at: new Date().toISOString()',
    '  };',
    '  node.status({ fill: "red", shape: "ring", text: `${msg.command} ${msg.stationId}: ${msg.error.code}` });',
    '} else if (msg.payload && msg.payload.ok === undefined) {',
    '  const view = msg.payload;',
    '  msg.payload = {',
    '    ok: true, stationId: msg.stationId, command: msg.command,',
    '    state: view.state, mode: view.control && view.control.mode,',
    '    allowedActions: view.allowedActions,',
    '    maintenanceOrderId: (view.activeMaintenance || view.completedOrder || {}).id || null,',
    '    at: new Date().toISOString()',
    '  };',
    '  node.status({ fill: "green", shape: "dot", text: `${msg.command} ${msg.stationId}: ${view.state}` });',
    '}',
    'msg.topic = msg.ackTopic;',
    'return msg;'
  ].join('\n')), { column: 4, row: 5 });

  b.node('cmd-ack-out', n.mqttOut('command ack', '', broker), { column: 5, row: 5 });

  b.chain('cmd-in', 'cmd-validate');
  b.wire('cmd-validate', 'cmd-route', 0);
  b.wire('cmd-validate', 'cmd-ack', 1);
  b.wire('cmd-route', 'cmd-start', 0);
  b.wire('cmd-route', 'cmd-stop', 1);
  b.wire('cmd-route', 'cmd-maint', 2);
  b.wire('cmd-route', 'cmd-complete', 3);
  ['cmd-start', 'cmd-stop', 'cmd-maint', 'cmd-complete'].forEach((name) => b.wire(name, 'cmd-ack'));
  b.wire('cmd-ack', 'cmd-ack-out');

  // ---- maintenance log -----------------------------------------------------
  b.comment('log-header', 'Maintenance log\n\nEvery order started and completed, with planned vs actual time.\nOverruns are what a maintenance planner reviews each week.', { column: 0, row: 9 });
  b.node('log-in', n.mqttIn('maintenance events', `${TOPIC_ROOT}/plant/event/maintenance/#`, broker), { column: 0, row: 10 });
  b.node('log-track', n.func('track overruns', [
    'const event = msg.payload || {};',
    'const p = event.payload || {};',
    '',
    'if (event.type === "maintenance.started") {',
    '  node.status({ fill: "yellow", shape: "dot", text: `${p.id} ${p.stationId} ${p.type}` });',
    '  msg.payload = { action: "started", id: p.id, stationId: p.stationId, type: p.type, plannedMinutes: p.plannedMinutes };',
    '  return msg;',
    '}',
    '',
    'if (event.type === "maintenance.completed") {',
    '  const stats = flow.get("mstats") || { orders: 0, overruns: 0, minutes: 0 };',
    '  stats.orders += 1;',
    '  stats.minutes += p.actualMinutes || 0;',
    '  if ((p.overrunMinutes || 0) > 0) stats.overruns += 1;',
    '  flow.set("mstats", stats);',
    '  node.status({',
    '    fill: "green", shape: "dot",',
    '    text: `${stats.orders} done, ${stats.overruns} overran, ${Math.round(stats.minutes)} min`',
    '  });',
    '  msg.payload = { action: "completed", ...p, totals: stats };',
    '  return msg;',
    '}',
    'return null;'
  ].join('\n')), { column: 1, row: 10 });
  b.node('log-debug', n.debug('maintenance log', { tostatus: true, statusVal: 'payload.action' }), { column: 2, row: 10 });
  b.chain('log-in', 'log-track', 'log-debug');
}

// ==========================================================================
// 90 - OEE & KPI Engine
// ==========================================================================

function kpiEngine(b, broker) {
  b.tab('90 - OEE & KPI Engine', {
    info: [
      '# OEE & KPI Engine',
      '',
      'ISO 22400-2 calculation for every line, published on MQTT.',
      '',
      '```',
      'Availability = Actual production time / Planned busy time',
      'Performance  = Ideal cycle time x Total count / Actual production time',
      'Quality      = First-pass good count / Total count',
      'OEE          = Availability x Performance x Quality',
      '```',
      '',
      'A line is not the average of its stations: availability and performance',
      'come from the constraint station, while quality compounds along the route.'
    ].join('\n')
  });

  b.comment('header', 'Per-line KPI publication\n\nOne calculation pass every 20 seconds, fanned out to per-line topics.', { column: 0, row: 0 });

  b.node('kpi-tick', n.inject('every 20s', { repeat: 20, once: true, onceDelay: 7 }), { column: 0, row: 1 });
  b.node('kpi-plant', { type: 'pc-oee', name: 'plant OEE', scope: 'plant', target: '', targetType: 'str', shifts: 8, throwErrors: false }, { column: 1, row: 1 });

  b.node('kpi-split', n.func('split per line', [
    'const plant = msg.payload;',
    '',
    '// One message per line, plus one for the plant roll-up. Publishing to',
    '// per-line topics lets a subscriber take just the line it cares about',
    '// instead of filtering a combined payload.',
    'const messages = plant.lines.map((line) => ({',
    '  topic: `' + TOPIC_ROOT + '/${line.lineId.toLowerCase()}/kpi`,',
    '  payload: {',
    '    lineId: line.lineId,',
    '    name: line.lineName,',
    '    kind: line.kind,',
    '    oee: line.oee,',
    '    availability: line.availability,',
    '    performance: line.performance,',
    '    quality: line.quality,',
    '    rating: line.rating,',
    '    jph: line.jph,',
    '    targetJph: line.targetJph,',
    '    constraintStation: line.constraintStation,',
    '    wip: line.wip,',
    '    window: plant.window',
    '  }',
    '}));',
    '',
    'messages.push({',
    '  topic: "' + TOPIC_ROOT + '/plant/kpi",',
    '  payload: {',
    '    oee: plant.oee,',
    '    rating: plant.rating,',
    '    constraintLine: plant.constraintLine,',
    '    jph: plant.throughput.jph,',
    '    targetJph: plant.throughput.targetJph,',
    '    taktAdherencePct: plant.throughput.taktAdherencePct,',
    '    fpy: plant.firstPassYield,',
    '    rolledThroughputYield: plant.rolledThroughputYield,',
    '    wip: plant.wip,',
    '    window: plant.window',
    '  }',
    '});',
    '',
    'node.status({',
    '  fill: plant.oee >= 85 ? "green" : plant.oee >= 60 ? "yellow" : "red",',
    '  shape: "dot",',
    `  text: \`plant OEE \${plant.oee}% | constraint \${plant.constraintLine}\``,
    '});',
    '',
    'return [messages];'
  ].join('\n')), { column: 2, row: 1 });

  b.node('kpi-out', n.mqttOut('publish KPI', '', broker, { retain: true }), { column: 3, row: 1 });
  b.chain('kpi-tick', 'kpi-plant', 'kpi-split', 'kpi-out');

  // ---- constraint alert ---------------------------------------------------
  b.comment('c-header', [
    'Constraint alert',
    '',
    'A line is only as fast as its bottleneck, so the useful alert is not',
    '"OEE is low" but "the constraint has moved". That is the station to go',
    'and look at.'
  ].join('\n'), { column: 0, row: 4 });

  b.node('c-tick', n.inject('every 60s', { repeat: 60, once: true, onceDelay: 20 }), { column: 0, row: 5 });
  b.node('c-oee', { type: 'pc-oee', name: 'plant OEE', scope: 'plant', target: '', targetType: 'str', shifts: 8, throwErrors: false }, { column: 1, row: 5 });

  b.node('c-detect', n.func('detect constraint shift', [
    'const plant = msg.payload;',
    'const previous = flow.get("constraint");',
    'const current = plant.constraintLine;',
    '',
    'flow.set("constraint", current);',
    'node.status({ fill: "blue", shape: "dot", text: `constraint: ${current}` });',
    '',
    'if (!previous || previous === current) return null;',
    '',
    'node.warn(`Plant constraint moved from ${previous} to ${current}`);',
    'msg.payload = {',
    '  previousConstraint: previous,',
    '  currentConstraint: current,',
    '  oee: plant.oee,',
    '  lines: plant.lines.map((l) => ({ id: l.lineId, oee: l.oee, jph: l.jph }))',
    '};',
    'return msg;'
  ].join('\n')), { column: 2, row: 5 });

  b.node('c-out', n.mqttOut('constraint shift', `${TOPIC_ROOT}/plant/constraint`, broker), { column: 3, row: 5 });
  b.node('c-debug', n.debug('constraint shifts', { tostatus: true, statusVal: 'payload.currentConstraint' }), { column: 3, row: 7 });
  b.chain('c-tick', 'c-oee', 'c-detect');
  b.wire('c-detect', ['c-out', 'c-debug']);

  // ---- shift trend --------------------------------------------------------
  b.node('t-tick', n.inject('every 5 min', { repeat: 300, once: true, onceDelay: 30 }), { column: 0, row: 9 });
  b.node('t-trend', { type: 'pc-oee', name: 'shift trend', scope: 'trend', target: '', targetType: 'str', shifts: 8, throwErrors: false }, { column: 1, row: 9 });
  b.node('t-out', n.mqttOut('shift trend', `${TOPIC_ROOT}/plant/trend`, broker, { retain: true }), { column: 2, row: 9 });
  b.chain('t-tick', 't-trend', 't-out');
}

// ==========================================================================
// 95 - Factory API
// ==========================================================================

function factoryApi(b) {
  b.tab('95 - Factory API', {
    info: [
      '# Factory API',
      '',
      'HTTP endpoints served **by the flows themselves**, under `/factory`.',
      '',
      'These sit alongside the Express REST API at `/api/v1` and exist to show',
      'the Node-RED http-in pattern. Both call the same domain services, so',
      'they cannot disagree about what the plant is doing.',
      '',
      '| Endpoint | Purpose |',
      '| --- | --- |',
      '| `GET /factory/status` | Plant status as JSON |',
      '| `GET /factory/board` | Line board, human-readable HTML |',
      '| `GET /factory/line/:id` | One line\'s KPIs |',
      '| `GET /factory/vehicle/:vin` | Full vehicle trace |',
      '| `POST /factory/andon` | Raise an andon call |',
      '| `POST /factory/recall` | Run a recall query |'
    ].join('\n')
  });

  b.comment('header', 'Flow-served HTTP endpoints\n\nhttp in -> domain node -> http response. The classic Node-RED API pattern.', { column: 0, row: 0 });

  // ---- GET /factory/status ------------------------------------------------
  b.node('status-in', n.httpIn('GET /factory/status', '/status', 'get'), { column: 0, row: 1 });
  b.node('status-kpi', { type: 'pc-oee', name: 'dashboard', scope: 'dashboard', target: '', targetType: 'str', shifts: 8, throwErrors: false }, { column: 1, row: 1 });
  b.node('status-shape', n.func('shape response', [
    'const d = msg.payload;',
    'msg.payload = {',
    '  site: "NorthStar Motors - Windsor Assembly Plant",',
    '  generatedAt: d.generatedAt,',
    '  shift: d.window,',
    '  headline: d.headline,',
    '  quality: { fpyPct: d.quality.fpyPct, dpmo: d.quality.dpmo, sigmaLevel: d.quality.sigmaLevel },',
    '  stations: d.stations,',
    '  andon: { open: d.andon.open, escalated: d.andon.escalated },',
    '  lines: d.lines,',
    '  servedBy: "node-red flow: 95 - Factory API"',
    '};',
    'return msg;'
  ].join('\n')), { column: 2, row: 1 });
  b.node('status-res', n.httpResponse('respond', { headers: { 'content-type': 'application/json' } }), { column: 3, row: 1 });
  b.chain('status-in', 'status-kpi', 'status-shape', 'status-res');

  // ---- GET /factory/line/:id ----------------------------------------------
  b.node('line-in', n.httpIn('GET /factory/line/:id', '/line/:id', 'get'), { column: 0, row: 3 });
  b.node('line-prep', n.func('read line id', [
    'msg.lineId = (msg.req.params.id || "").toUpperCase();',
    'return msg;'
  ].join('\n')), { column: 1, row: 3 });
  b.node('line-oee', { type: 'pc-oee', name: 'line OEE', scope: 'line', target: 'lineId', targetType: 'msg', shifts: 8, throwErrors: false }, { column: 2, row: 3 });
  b.node('line-res-prep', n.func('handle not found', [
    'if (msg.error) {',
    '  msg.statusCode = msg.error.status || 404;',
    '  msg.payload = { error: msg.error };',
    '}',
    'return msg;'
  ].join('\n')), { column: 3, row: 3 });
  b.node('line-res', n.httpResponse('respond', { headers: { 'content-type': 'application/json' } }), { column: 4, row: 3 });
  b.chain('line-in', 'line-prep', 'line-oee', 'line-res-prep', 'line-res');

  // ---- GET /factory/vehicle/:vin ------------------------------------------
  b.node('veh-in', n.httpIn('GET /factory/vehicle/:vin', '/vehicle/:vin', 'get'), { column: 0, row: 5 });
  b.node('veh-prep', n.func('read vin', 'msg.vin = (msg.req.params.vin || "").toUpperCase();\nreturn msg;'), { column: 1, row: 5 });
  b.node('veh-trace', { type: 'pc-genealogy', name: 'vehicle trace', operation: 'trace', vin: 'vin', vinType: 'msg', lotCode: '', lotCodeType: 'str', throwErrors: false }, { column: 2, row: 5 });
  b.node('veh-res-prep', n.func('handle not found', [
    'if (msg.error) {',
    '  msg.statusCode = msg.error.status || 404;',
    '  msg.payload = { error: msg.error };',
    '}',
    'return msg;'
  ].join('\n')), { column: 3, row: 5 });
  b.node('veh-res', n.httpResponse('respond', { headers: { 'content-type': 'application/json' } }), { column: 4, row: 5 });
  b.chain('veh-in', 'veh-prep', 'veh-trace', 'veh-res-prep', 'veh-res');

  // ---- POST /factory/andon ------------------------------------------------
  b.node('andon-in', n.httpIn('POST /factory/andon', '/andon', 'post'), { column: 0, row: 7 });
  b.node('andon-prep', n.func('read call details', [
    'const body = msg.payload || {};',
    'if (!body.stationId || !body.callType) {',
    '  msg.statusCode = 400;',
    '  msg.payload = { error: { code: "VALIDATION_FAILED", message: "stationId and callType are required" } };',
    '  return [null, msg];',
    '}',
    'msg.stationId = body.stationId;',
    'msg.callType = body.callType;',
    'msg.raisedBy = body.raisedBy || "factory-api";',
    'msg.note = body.note;',
    'msg.vin = body.vin;',
    'return [msg, null];'
  ].join('\n'), { outputs: 2 }), { column: 1, row: 7 });
  b.node('andon-raise', { type: 'pc-andon', name: 'raise call', operation: 'raise', station: 'stationId', stationType: 'msg', callType: 'MAINTENANCE', andonId: 'payload.id', andonIdType: 'msg', throwErrors: false }, { column: 2, row: 7 });
  b.node('andon-res-prep', n.func('shape response', [
    'if (msg.error) {',
    '  msg.statusCode = msg.error.status || 400;',
    '  msg.payload = { error: msg.error };',
    '  return msg;',
    '}',
    'msg.statusCode = 201;',
    'return msg;'
  ].join('\n')), { column: 3, row: 7 });
  b.node('andon-res', n.httpResponse('respond', { headers: { 'content-type': 'application/json' } }), { column: 4, row: 7 });
  b.chain('andon-in', 'andon-prep');
  b.wire('andon-prep', 'andon-raise', 0);
  b.wire('andon-prep', 'andon-res', 1);
  b.chain('andon-raise', 'andon-res-prep', 'andon-res');

  // ---- POST /factory/recall -----------------------------------------------
  b.node('recall-in', n.httpIn('POST /factory/recall', '/recall', 'post'), { column: 0, row: 9 });
  b.node('recall-prep', n.func('read query', [
    'const body = msg.payload || {};',
    'msg.lotCode = body.lotCode;',
    'msg.serial = body.serial;',
    'msg.partNumber = body.partNumber;',
    'msg.reason = body.reason || "Recall query via factory API";',
    'return msg;'
  ].join('\n')), { column: 1, row: 9 });
  b.node('recall-run', { type: 'pc-genealogy', name: 'recall analysis', operation: 'recall', vin: '', vinType: 'str', lotCode: 'lotCode', lotCodeType: 'msg', throwErrors: false }, { column: 2, row: 9 });
  b.node('recall-res-prep', n.func('shape response', [
    'if (msg.error) {',
    '  msg.statusCode = msg.error.status || 400;',
    '  msg.payload = { error: msg.error };',
    '  return msg;',
    '}',
    'const r = msg.payload;',
    'msg.payload = {',
    '  query: r.query,',
    '  affectedCount: r.affectedCount,',
    '  byContainment: r.byContainment,',
    '  containableNow: r.containableNow,',
    '  supplier: r.supplier,',
    '  safetyCritical: r.safetyCritical,',
    '  estimatedRecallCostCad: r.estimatedRecallCostCad,',
    '  recommendation: r.recommendation,',
    '  // Cap the VIN list: a real recall can touch tens of thousands, and the',
    '  // full list belongs in a file, not an HTTP response body.',
    '  affectedVins: r.affected.slice(0, 100).map((a) => a.vin),',
    '  truncated: r.affected.length > 100',
    '};',
    'return msg;'
  ].join('\n')), { column: 3, row: 9 });
  b.node('recall-res', n.httpResponse('respond', { headers: { 'content-type': 'application/json' } }), { column: 4, row: 9 });
  b.chain('recall-in', 'recall-prep', 'recall-run', 'recall-res-prep', 'recall-res');

  // ---- GET /factory/board (HTML) ------------------------------------------
  b.node('board-in', n.httpIn('GET /factory/board', '/board', 'get'), { column: 0, row: 11 });
  b.node('board-kpi', { type: 'pc-oee', name: 'dashboard', scope: 'dashboard', target: '', targetType: 'str', shifts: 8, throwErrors: false }, { column: 1, row: 11 });
  b.node('board-prep', n.func('prepare view model', [
    'const d = msg.payload;',
    'msg.view = {',
    '  oee: d.headline.oee,',
    '  rating: d.headline.rating,',
    '  jph: d.headline.jph,',
    '  built: d.headline.unitsCompleted,',
    '  fpy: d.headline.fpyPct ?? "-",',
    '  wip: d.headline.wip,',
    '  down: d.stations.downNow,',
    '  andon: d.andon.open,',
    '  shift: d.window.shiftName || d.window.shift,',
    '  lines: d.lines.map((l) => ({',
    '    id: l.lineId, oee: l.oee, jph: l.jph, wip: l.wip,',
    '    colour: l.oee >= 85 ? "#2e7d32" : l.oee >= 60 ? "#ef6c00" : "#c62828"',
    '  }))',
    '};',
    'return msg;'
  ].join('\n')), { column: 2, row: 11 });

  b.node('board-html', n.template('render board', [
    '<!doctype html>',
    '<html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<title>Line Board - Windsor Assembly Plant</title>',
    '<style>',
    ' body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;background:#0f1419;color:#e6edf3;margin:0;padding:24px}',
    ' h1{font-size:20px;margin:0 0 4px} .sub{color:#8b949e;font-size:13px;margin-bottom:20px}',
    ' .tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:24px}',
    ' .tile{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:14px}',
    ' .tile .k{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:#8b949e}',
    ' .tile .v{font-size:26px;font-weight:600;margin-top:4px}',
    ' table{width:100%;border-collapse:collapse;background:#161b22;border-radius:8px;overflow:hidden}',
    ' th,td{padding:10px 14px;text-align:left;border-bottom:1px solid #30363d;font-size:14px}',
    ' th{background:#1c2128;font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:#8b949e}',
    ' .bar{height:6px;border-radius:3px;background:#30363d;overflow:hidden;margin-top:4px}',
    ' .bar span{display:block;height:100%}',
    ' a{color:#58a6ff}',
    '</style></head><body>',
    '<h1>Windsor Assembly Plant &mdash; Line Board</h1>',
    '<div class="sub">{{view.shift}} &middot; served by Node-RED flow <code>95 - Factory API</code></div>',
    '<div class="tiles">',
    ' <div class="tile"><div class="k">Plant OEE</div><div class="v">{{view.oee}}%</div></div>',
    ' <div class="tile"><div class="k">Jobs / hour</div><div class="v">{{view.jph}}</div></div>',
    ' <div class="tile"><div class="k">Built this shift</div><div class="v">{{view.built}}</div></div>',
    ' <div class="tile"><div class="k">First pass yield</div><div class="v">{{view.fpy}}%</div></div>',
    ' <div class="tile"><div class="k">Work in progress</div><div class="v">{{view.wip}}</div></div>',
    ' <div class="tile"><div class="k">Stations down</div><div class="v">{{view.down}}</div></div>',
    ' <div class="tile"><div class="k">Andon open</div><div class="v">{{view.andon}}</div></div>',
    '</div>',
    '<table><thead><tr><th>Line</th><th>OEE</th><th>JPH</th><th>WIP</th></tr></thead><tbody>',
    '{{#view.lines}}',
    '<tr><td>{{id}}</td>',
    '<td>{{oee}}%<div class="bar"><span style="width:{{oee}}%;background:{{colour}}"></span></div></td>',
    '<td>{{jph}}</td><td>{{wip}}</td></tr>',
    '{{/view.lines}}',
    '</tbody></table>',
    '<p style="margin-top:20px"><a href="/">Plant HMI</a> &middot; <a href="/api-docs">API docs</a> &middot; <a href="/red">Flow editor</a></p>',
    '</body></html>'
  ].join('\n'), { output: 'str' }), { column: 3, row: 11 });

  b.node('board-res', n.httpResponse('respond', { headers: { 'content-type': 'text/html; charset=utf-8' } }), { column: 4, row: 11 });
  b.chain('board-in', 'board-kpi', 'board-prep', 'board-html', 'board-res');
}

// ==========================================================================
// 99 - Traceability
// ==========================================================================

function traceability(b, broker) {
  b.tab('99 - Traceability', {
    info: [
      '# Traceability & Recall',
      '',
      'The query an MES exists to answer: a supplier reports a bad batch, and',
      'the plant needs to know which vehicles have it and where they are.',
      '',
      'Inject **Run recall drill** below to see it. The flow picks the most',
      'widely-used supplier lot, runs the recall query against the full build',
      'history, and routes the result by containment - vehicles still in the',
      'plant can be stopped, vehicles that have shipped cannot.'
    ].join('\n')
  });

  b.comment('header', [
    'Recall drill',
    '',
    'Lot lookups run against a maintained index, so this answers in',
    'milliseconds across the whole build history rather than scanning every',
    'vehicle genealogy.'
  ].join('\n'), { column: 0, row: 0 });

  b.node('drill-tick', n.inject('Run recall drill', { once: false }), { column: 0, row: 1 });

  b.node('pick-lot', n.func('pick the worst lot', [
    'const core = global.get("productionCore");',
    '',
    '// Most-used lot first: the widest blast radius is the interesting case.',
    'const lots = core.trace.listLots({ limit: 200 });',
    'if (!lots.items.length) {',
    '  node.status({ fill: "grey", shape: "ring", text: "no lots yet" });',
    '  return null;',
    '}',
    '',
    'const target = lots.items[0];',
    'node.status({ fill: "blue", shape: "dot", text: `${target.lotCode} (${target.vinCount} VINs)` });',
    '',
    'msg.lotCode = target.lotCode;',
    'msg.reason = "Scheduled recall drill";',
    'return msg;'
  ].join('\n')), { column: 1, row: 1 });

  b.node('run-recall', { type: 'pc-genealogy', name: 'recall analysis', operation: 'recall', vin: '', vinType: 'str', lotCode: 'lotCode', lotCodeType: 'msg', throwErrors: false }, { column: 2, row: 1 });

  b.node('assess', n.func('assess containment', [
    'const r = msg.payload;',
    'if (!r || !r.affectedCount) {',
    '  node.status({ fill: "green", shape: "dot", text: "nothing affected" });',
    '  return [null, null, msg];',
    '}',
    '',
    'const c = r.byContainment;',
    'node.status({',
    '  fill: c.SHIPPED > 0 ? "red" : "yellow",',
    '  shape: "dot",',
    `  text: \`\${r.affectedCount} affected, \${r.containableNow} containable\``,
    '});',
    '',
    'msg.payload = {',
    '  lotCode: r.query.lotCode,',
    '  supplier: r.supplier,',
    '  safetyCritical: r.safetyCritical,',
    '  affectedCount: r.affectedCount,',
    '  byContainment: c,',
    '  containableNow: r.containableNow,',
    '  estimatedCostCad: r.estimatedRecallCostCad,',
    '  action: r.recommendation.action,',
    '  rationale: r.recommendation.rationale,',
    '  inPlantVins: r.affected.filter((a) => a.containment === "IN_PLANT").map((a) => a.vin)',
    '};',
    '',
    '// A shipped safety-critical part is a different problem from one still',
    '// inside the fence, so route them separately.',
    'if (r.safetyCritical && c.SHIPPED > 0) return [msg, null, null];',
    'if (r.containableNow > 0) return [null, msg, null];',
    'return [null, null, msg];'
  ].join('\n'), { outputs: 3 }), { column: 3, row: 1 });

  b.node('safety-recall', n.func('SAFETY RECALL', [
    'const r = msg.payload;',
    'node.error(`SAFETY RECALL: ${r.affectedCount} vehicles with ${r.supplier} lot ${r.lotCode}, ` +',
    '  `${r.byContainment.SHIPPED} already shipped. ${r.rationale}`, msg);',
    'node.status({ fill: "red", shape: "dot", text: `${r.byContainment.SHIPPED} shipped` });',
    'return msg;'
  ].join('\n')), { column: 4, row: 0 });

  b.node('contain', n.func('contain in plant', [
    'const r = msg.payload;',
    'node.warn(`Containment: hold ${r.containableNow} vehicle(s) carrying ${r.lotCode} ` +',
    '  `before they ship. Estimated cost CAD ${r.estimatedCostCad.toLocaleString()}.`);',
    'node.status({ fill: "yellow", shape: "dot", text: `hold ${r.containableNow} vehicles` });',
    'return msg;'
  ].join('\n')), { column: 4, row: 2 });

  b.node('clear', n.func('no action', [
    'node.status({ fill: "green", shape: "dot", text: "no action required" });',
    'return msg;'
  ].join('\n')), { column: 4, row: 4 });

  b.node('recall-out', n.mqttOut('recall result', `${TOPIC_ROOT}/plant/recall`, broker), { column: 5, row: 1 });
  b.node('recall-debug', n.debug('recall report', { tostatus: true, statusVal: 'payload.action' }), { column: 5, row: 3 });

  b.chain('drill-tick', 'pick-lot', 'run-recall', 'assess');
  b.wire('assess', 'safety-recall', 0);
  b.wire('assess', 'contain', 1);
  b.wire('assess', 'clear', 2);
  b.wire('safety-recall', ['recall-out', 'recall-debug']);
  b.wire('contain', ['recall-out', 'recall-debug']);
  b.wire('clear', 'recall-debug');

  // ---- vehicle passport ---------------------------------------------------
  b.comment('p-header', [
    'Vehicle passport',
    '',
    'Every released vehicle gets its as-built record published: the full',
    'component tree with supplier lots, sealed and immutable.'
  ].join('\n'), { column: 0, row: 7 });

  b.node('released-in', n.mqttIn('vehicles released', `${TOPIC_ROOT}/plant/event/unit/completed`, broker), { column: 0, row: 8 });
  b.node('passport-prep', n.func('read vin', [
    'const event = msg.payload || {};',
    'msg.vin = event.vin || event.payload?.vin;',
    'if (!msg.vin) return null;',
    'return msg;'
  ].join('\n')), { column: 1, row: 8 });
  b.node('passport', { type: 'pc-genealogy', name: 'as-built record', operation: 'get', vin: 'vin', vinType: 'msg', lotCode: '', lotCodeType: 'str', throwErrors: false }, { column: 2, row: 8 });
  b.node('passport-shape', n.func('shape passport', [
    'const g = msg.payload;',
    'if (!g) return null;',
    '',
    'node.status({ fill: "green", shape: "dot", text: `${msg.vin}: ${g.stats.totalNodes} components` });',
    'msg.payload = {',
    '  vin: g.vin,',
    '  modelCode: g.modelCode,',
    '  sealedAt: g.sealedAt,',
    '  componentCount: g.stats.totalNodes,',
    '  subAssemblies: g.stats.subAssemblies,',
    '  safetyCriticalParts: g.stats.safetyCriticalParts,',
    '  distinctLots: g.stats.distinctLots,',
    '  materialCostCad: g.estimatedMaterialCostCad',
    '};',
    'msg.topic = `' + TOPIC_ROOT + '/plant/passport/${g.vin}`;',
    'return msg;'
  ].join('\n')), { column: 3, row: 8 });
  b.node('passport-out', n.mqttOut('publish passport', '', broker, { retain: false }), { column: 4, row: 8 });
  b.chain('released-in', 'passport-prep', 'passport', 'passport-shape', 'passport-out');
}

module.exports = { buildFlows, TOPIC_ROOT };
