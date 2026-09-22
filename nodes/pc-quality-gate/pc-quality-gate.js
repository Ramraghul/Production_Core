'use strict';

/**
 * pc-quality-gate - the control point of the whole quality system.
 *
 * Two outputs: PASS and HOLD. This is the one node where the routing decision
 * is the product, so it is modelled as a branch rather than as an error. A
 * flow reads left to right: gate -> pass -> next station, gate -> hold ->
 * repair bay.
 *
 * It can also run a full inspection plan first, which raises defects for any
 * out-of-spec characteristic and then evaluates the gate against them.
 */

const { resolve, run, register, STATUS } = require('../lib/shared');

module.exports = function registerNode(RED) {
  register(RED, 'pc-quality-gate', function PcQualityGate(config) {
    const node = this;
    node.mode = config.mode || 'evaluate'; // evaluate | inspect
    node.vin = config.vin || 'payload.vin';
    node.vinType = config.vinType || 'msg';
    node.station = config.station || '';
    node.stationType = config.stationType || 'str';
    node.holdOnFail = config.holdOnFail !== false;
    node.raiseAndon = config.raiseAndon === true;

    node.on('input', (msg, send, done) => {
      node.status(STATUS.busy('gating'));

      run(node, msg, send, done, (ctx) => {
        const vin = resolve(node, msg, node.vin, node.vinType, msg.vin);
        const stationId = resolve(node, msg, node.station, node.stationType, msg.stationId);

        let inspection = null;
        let raisedDefects = [];

        // Optionally measure first. An inspection that fails raises defects,
        // which the gate evaluation below will then see.
        if (node.mode === 'inspect') {
          const measurements = msg.measurements || msg.payload?.measurements || msg.payload;
          const result = ctx.quality.recordInspection({
            stationId, vin, measurements, inspector: msg.inspector || 'flow'
          });
          inspection = result.inspection;
          raisedDefects = result.defects;
        }

        const gate = ctx.quality.evaluateGate(vin, stationId);

        if (gate.pass) {
          return {
            payload: { ...gate, inspection, defectsRaised: raisedDefects.map((d) => d.id) },
            extra: { vin, stationId, topic: `gate/${stationId}/pass` },
            output: 0,
            status: STATUS.ok(`pass ${stationId}`)
          };
        }

        // Failed: optionally take the vehicle off-line and call for help before
        // routing it out of output 2.
        if (node.holdOnFail) {
          const unit = ctx.repository.get('units', vin);
          if (unit && unit.status === 'IN_PROCESS') {
            ctx.production.holdUnit(
              vin,
              `Gate ${stationId}: ${gate.blockingDefects.length} blocking defect(s)`,
              { operator: msg.operator || 'flow' }
            );
          }
        }

        if (node.raiseAndon) {
          try {
            ctx.operations.raiseAndon({
              stationId, callType: 'QUALITY', raisedBy: msg.operator || 'flow', vin,
              note: `Gate hold: ${gate.blockingDefects.map((d) => d.code).join(', ')}`
            });
          } catch (_error) { /* andon is advisory here, never fatal */ }
        }

        return {
          payload: { ...gate, inspection, defectsRaised: raisedDefects.map((d) => d.id) },
          extra: { vin, stationId, topic: `gate/${stationId}/hold` },
          output: 1,
          status: STATUS.warn(`hold: ${gate.worstSeverity || 'defects'}`)
        };
      });
    });
  });
};
