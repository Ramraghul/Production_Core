'use strict';

/**
 * pc-oee - ISO 22400 KPI calculation.
 *
 * Scope is station, line or plant. The default window is the current shift,
 * which is what every operator screen in a plant is scoped to; pass `msg.since`
 * to widen it.
 */

const { resolve, run, register, STATUS } = require('../lib/shared');

module.exports = function registerNode(RED) {
  register(RED, 'pc-oee', function PcOee(config) {
    const node = this;
    node.scope = config.scope || 'plant'; // station | line | plant | dashboard | trend
    node.target = config.target || '';
    node.targetType = config.targetType || 'str';
    node.shifts = Number(config.shifts) || 8;

    node.on('input', (msg, send, done) => {
      node.status(STATUS.busy('calculating'));

      run(node, msg, send, done, (ctx) => {
        const target = resolve(node, msg, node.target, node.targetType,
          msg.stationId || msg.lineId);
        const window = { since: msg.since, until: msg.until };

        const rate = (value) =>
          (value >= 85 ? STATUS.ok : value >= 60 ? STATUS.warn : STATUS.error)(`OEE ${value}%`);

        switch (node.scope) {
          case 'station': {
            const result = ctx.kpi.stationOee(target, window);
            return { payload: result, extra: { stationId: target }, status: rate(result.oee) };
          }

          case 'line': {
            const result = ctx.kpi.lineOee(target, window);
            return { payload: result, extra: { lineId: target }, status: rate(result.oee) };
          }

          case 'dashboard': {
            const result = ctx.kpi.dashboard(window);
            return {
              payload: result,
              extra: { topic: 'kpi/dashboard' },
              status: rate(result.headline.oee)
            };
          }

          case 'trend': {
            const items = ctx.kpi.shiftTrend(msg.shifts || node.shifts);
            return { payload: items, extra: { total: items.length }, status: STATUS.ok(`${items.length} shifts`) };
          }

          case 'plant':
          default: {
            const result = ctx.kpi.plantOee(window);
            return { payload: result, extra: { topic: 'kpi/plant' }, status: rate(result.oee) };
          }
        }
      });
    });
  });
};
