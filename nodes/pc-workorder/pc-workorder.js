'use strict';

/**
 * pc-workorder - production scheduling.
 *
 * Releasing an order is what mints vehicles and their VINs, so this node is
 * usually the first thing in a plant start-up flow.
 */

const { resolve, run, register, STATUS } = require('../lib/shared');
const { progress } = require('../../src/core/workOrder');

module.exports = function registerNode(RED) {
  register(RED, 'pc-workorder', function PcWorkOrder(config) {
    const node = this;
    node.operation = config.operation || 'list';
    node.orderId = config.orderId || 'payload.id';
    node.orderIdType = config.orderIdType || 'msg';
    node.modelCode = config.modelCode || '';
    node.quantity = config.quantity || 0;
    node.createUnits = config.createUnits || 0;

    node.on('input', (msg, send, done) => {
      node.status(STATUS.busy());

      run(node, msg, send, done, (ctx) => {
        const production = ctx.production;
        const id = resolve(node, msg, node.orderId, node.orderIdType, msg.workOrderId);

        switch (node.operation) {
          case 'create': {
            const created = production.createWorkOrder({
              modelCode: msg.modelCode || node.modelCode,
              quantity: msg.quantity || Number(node.quantity) || 1,
              colour: msg.colour,
              priority: msg.priority,
              dueDate: msg.dueDate,
              customerRef: msg.customerRef
            });
            return {
              payload: created,
              extra: { workOrderId: created.id },
              status: STATUS.ok(`${created.id} (${created.quantity})`)
            };
          }

          case 'release': {
            const count = msg.createUnits ?? (Number(node.createUnits) || undefined);
            const result = production.releaseWorkOrder(id, { createUnits: count });
            return {
              payload: result,
              extra: { workOrderId: id, vins: result.units.map((u) => u.vin) },
              status: STATUS.ok(`released ${result.units.length}`)
            };
          }

          case 'get': {
            const order = production.getWorkOrder(id);
            const p = progress(order);
            return {
              payload: { ...order, progress: p },
              extra: { workOrderId: id },
              status: STATUS.ok(`${p.completed}/${p.quantity} (${p.completionPct}%)`)
            };
          }

          case 'transition': {
            const next = production.transitionWorkOrder(id, msg.status, { reason: msg.reason });
            return { payload: next, extra: { workOrderId: id }, status: STATUS.ok(next.status) };
          }

          case 'list':
          default: {
            const result = production.listWorkOrders({
              status: msg.status, modelCode: msg.modelCode, limit: msg.limit || 50
            });
            return {
              payload: result.items,
              extra: { total: result.total },
              status: STATUS.ok(`${result.total} orders`)
            };
          }
        }
      });
    });
  });
};
