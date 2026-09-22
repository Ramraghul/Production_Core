'use strict';

/**
 * pc-andon - line-stop calls.
 *
 * Raising a line-stopping call also puts the station DOWN and opens a linked
 * downtime record; resolving it reverses both. Keeping those coupled inside one
 * operation is what stops the andon log and the downtime log disagreeing.
 */

const { resolve, run, register, STATUS } = require('../lib/shared');

module.exports = function registerNode(RED) {
  register(RED, 'pc-andon', function PcAndon(config) {
    const node = this;
    node.operation = config.operation || 'raise';
    node.station = config.station || 'payload.stationId';
    node.stationType = config.stationType || 'msg';
    node.callType = config.callType || 'MAINTENANCE';
    node.andonId = config.andonId || 'payload.id';
    node.andonIdType = config.andonIdType || 'msg';

    node.on('input', (msg, send, done) => {
      node.status(STATUS.busy());

      run(node, msg, send, done, (ctx) => {
        const operations = ctx.operations;
        const stationId = resolve(node, msg, node.station, node.stationType, msg.stationId);
        const id = resolve(node, msg, node.andonId, node.andonIdType, msg.andonId);

        switch (node.operation) {
          case 'raise': {
            const andon = operations.raiseAndon({
              stationId,
              callType: msg.callType || node.callType,
              raisedBy: msg.raisedBy || 'flow',
              vin: msg.vin,
              note: msg.note
            });
            return {
              payload: andon,
              extra: { andonId: andon.id, stationId, topic: `andon/${andon.id}/raised` },
              status: andon.stopsLine ? STATUS.error(`${andon.callType} (line stop)`) : STATUS.warn(andon.callType)
            };
          }

          case 'acknowledge': {
            const andon = operations.acknowledgeAndon(id, msg.responder || 'flow');
            return {
              payload: andon,
              extra: { andonId: id },
              status: andon.slaMet ? STATUS.ok(`ack ${andon.responseSeconds}s`) : STATUS.warn(`ack ${andon.responseSeconds}s (SLA missed)`)
            };
          }

          case 'escalate': {
            const andon = operations.escalateAndon(id);
            return {
              payload: andon,
              extra: { andonId: id },
              status: STATUS.error(`tier ${andon.escalationTier} -> ${andon.escalatedTo}`)
            };
          }

          case 'resolve': {
            const andon = operations.resolveAndon(id, msg.resolution || 'Resolved by flow', msg.resolver || 'flow');
            return {
              payload: andon,
              extra: { andonId: id, topic: `andon/${id}/resolved` },
              status: STATUS.ok(`resolved in ${andon.resolutionSeconds}s`)
            };
          }

          case 'sweep': {
            // Escalate every open call that has blown its SLA. Wire an inject
            // node to this on a timer.
            const escalated = operations.sweepEscalations();
            return {
              payload: escalated,
              extra: { total: escalated.length },
              status: escalated.length ? STATUS.error(`escalated ${escalated.length}`) : STATUS.ok('none overdue')
            };
          }

          case 'list':
          default: {
            const result = operations.listAndons({
              open: msg.open, lineId: msg.lineId, stationId: msg.stationId, limit: msg.limit || 50
            });
            return {
              payload: result.items,
              extra: { total: result.total },
              status: STATUS.ok(`${result.total} calls`)
            };
          }
        }
      });
    });
  });
};
