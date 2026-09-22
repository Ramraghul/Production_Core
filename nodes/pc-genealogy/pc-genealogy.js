'use strict';

/**
 * pc-genealogy - traceability and recall analysis.
 *
 * The recall operation is the one to demonstrate: given a supplier lot code it
 * returns every affected VIN, where each vehicle is now, and what containment
 * would cost. Lot lookups are O(1) against a maintained index, so this answers
 * in milliseconds over the whole build history.
 */

const { resolve, run, register, STATUS } = require('../lib/shared');

module.exports = function registerNode(RED) {
  register(RED, 'pc-genealogy', function PcGenealogy(config) {
    const node = this;
    node.operation = config.operation || 'get';
    node.vin = config.vin || 'payload.vin';
    node.vinType = config.vinType || 'msg';
    node.lotCode = config.lotCode || '';
    node.lotCodeType = config.lotCodeType || 'msg';

    node.on('input', (msg, send, done) => {
      node.status(STATUS.busy());

      run(node, msg, send, done, (ctx) => {
        const vin = resolve(node, msg, node.vin, node.vinType, msg.vin);
        const lotCode = resolve(node, msg, node.lotCode, node.lotCodeType, msg.lotCode);

        switch (node.operation) {
          case 'get': {
            const report = ctx.production.genealogyReport(vin);
            return {
              payload: report,
              extra: { vin },
              status: STATUS.ok(`${report.stats.totalNodes} components`)
            };
          }

          case 'trace': {
            const trace = ctx.trace.vehicleTrace(vin);
            return {
              payload: trace,
              extra: { vin },
              status: STATUS.ok(`${trace.lotCodes.length} lots`)
            };
          }

          case 'recall': {
            const report = ctx.trace.recall({
              lotCode,
              serial: msg.serial,
              partNumber: msg.partNumber,
              reason: msg.reason || 'Recall query from flow'
            });
            return {
              payload: report,
              extra: { affectedVins: report.affected.map((a) => a.vin) },
              status: report.affectedCount
                ? STATUS.warn(`${report.affectedCount} affected`)
                : STATUS.ok('none affected')
            };
          }

          case 'lotUsage': {
            const usage = ctx.trace.lotUsage(lotCode);
            return {
              payload: usage,
              status: STATUS.ok(`${usage.vinCount} vehicles`)
            };
          }

          case 'lots': {
            const lots = ctx.trace.listLots({ supplier: msg.supplier, limit: msg.limit || 100 });
            return { payload: lots.items, extra: { total: lots.total }, status: STATUS.ok(`${lots.total} lots`) };
          }

          default:
            throw Object.assign(new Error(`Unknown pc-genealogy operation '${node.operation}'`), {
              code: 'VALIDATION_FAILED', status: 400
            });
        }
      });
    });
  });
};
