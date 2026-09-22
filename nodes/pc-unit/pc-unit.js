'use strict';

/**
 * pc-unit - vehicle operations.
 *
 * The workhorse node of the main assembly flows. Everything a flow needs to do
 * to a vehicle - move it, advance it along the routing, hold it, complete it -
 * goes through here, which means the flows enforce exactly the same rules the
 * REST API does, because both call the same service.
 */

const { resolve, run, register, STATUS } = require('../lib/shared');

module.exports = function registerNode(RED) {
  register(RED, 'pc-unit', function PcUnit(config) {
    const node = this;
    node.operation = config.operation || 'get';
    node.vin = config.vin || 'payload.vin';
    node.vinType = config.vinType || 'msg';
    node.station = config.station || '';
    node.stationType = config.stationType || 'str';
    node.reason = config.reason || '';
    node.operator = config.operator || 'flow';
    node.force = config.force === true;

    node.on('input', (msg, send, done) => {
      node.status(STATUS.busy());

      run(node, msg, send, done, (ctx) => {
        const production = ctx.production;
        const vin = resolve(node, msg, node.vin, node.vinType, msg.vin);
        const stationId = resolve(node, msg, node.station, node.stationType, msg.stationId);
        const reason = resolve(node, msg, node.reason, 'str', msg.reason);
        const options = { operator: node.operator, force: node.force, source: 'node-red' };

        switch (node.operation) {
          case 'get': {
            const unit = production.getUnit(vin);
            return {
              payload: unit,
              extra: { vin, topic: `unit/${vin}` },
              status: STATUS.ok(`${unit.status} @ ${unit.currentStation || '-'}`)
            };
          }

          case 'move': {
            if (!stationId) {
              throw Object.assign(new Error('A station id is required to move a unit'), {
                code: 'VALIDATION_FAILED', status: 400
              });
            }
            const moved = production.moveUnit(vin, stationId, options);
            return {
              payload: moved,
              extra: { vin, stationId, topic: `unit/${vin}/moved` },
              status: STATUS.ok(`-> ${stationId}`)
            };
          }

          case 'advance': {
            const advanced = production.advanceUnit(vin, options);
            return {
              payload: advanced,
              extra: { vin, stationId: advanced.currentStation, topic: `unit/${vin}/advanced` },
              status: STATUS.ok(advanced.currentStation || advanced.status)
            };
          }

          case 'hold': {
            const held = production.holdUnit(vin, reason || 'Held by flow', options);
            return { payload: held, extra: { vin }, status: STATUS.warn('held') };
          }

          case 'rework': {
            const reworked = production.reworkUnit(vin, reason || 'Rework by flow', options);
            return { payload: reworked, extra: { vin }, status: STATUS.warn(`rework x${reworked.reworkCount}`) };
          }

          case 'release': {
            const released = production.releaseUnit(vin, options);
            return { payload: released, extra: { vin }, status: STATUS.ok('released to line') };
          }

          case 'complete': {
            const completed = production.completeUnit(vin, options);
            return {
              payload: completed,
              extra: { vin, topic: `unit/${vin}/completed` },
              status: STATUS.ok(`built in ${completed.buildMinutes}m`)
            };
          }

          case 'scrap': {
            const scrapped = production.scrapUnit(vin, reason || 'Scrapped by flow', options);
            return { payload: scrapped, extra: { vin }, status: STATUS.error('scrapped') };
          }

          case 'history': {
            const history = production.unitHistory(vin);
            return {
              payload: history,
              extra: { vin },
              status: STATUS.ok(`${history.visits.length} visits`)
            };
          }

          case 'wip': {
            const wip = production.workInProgress();
            return { payload: wip, status: STATUS.ok(`${wip.length} on floor`) };
          }

          case 'list': {
            const result = production.listUnits({
              status: msg.status, lineId: msg.lineId, stationId: msg.stationId,
              limit: msg.limit || 50
            });
            return { payload: result.items, extra: { total: result.total }, status: STATUS.ok(`${result.total} units`) };
          }

          default:
            throw Object.assign(new Error(`Unknown pc-unit operation '${node.operation}'`), {
              code: 'VALIDATION_FAILED', status: 400
            });
        }
      });
    });
  });
};
