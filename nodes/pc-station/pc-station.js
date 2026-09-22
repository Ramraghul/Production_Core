'use strict';

/**
 * pc-station - station state and cycle recording.
 *
 * Changing a station into a stopped state opens a downtime record, and moving
 * it back out closes it (or discards it as a micro-stop). A flow therefore gets
 * correct ISO 22400 downtime accounting for free, just by reporting state.
 */

const { resolve, run, register, STATUS } = require('../lib/shared');

module.exports = function registerNode(RED) {
  register(RED, 'pc-station', function PcStation(config) {
    const node = this;
    node.operation = config.operation || 'get';
    node.station = config.station || 'payload.stationId';
    node.stationType = config.stationType || 'msg';
    node.state = config.state || 'RUNNING';
    node.reasonCode = config.reasonCode || '';
    node.lineFilter = config.lineFilter || '';
    node.maintenanceType = config.maintenanceType || '';

    node.on('input', (msg, send, done) => {
      node.status(STATUS.busy());

      run(node, msg, send, done, (ctx) => {
        const operations = ctx.operations;
        const stationId = resolve(node, msg, node.station, node.stationType, msg.stationId);

        switch (node.operation) {
          case 'get': {
            const state = operations.getStationState(stationId);
            return {
              payload: state,
              extra: { stationId, topic: `station/${stationId}/state` },
              status: STATUS.ok(`${stationId}: ${state.state}`)
            };
          }

          case 'setState': {
            const target = msg.state || node.state;
            const state = operations.setStationState(stationId, target, {
              reasonCode: msg.reasonCode || node.reasonCode || undefined,
              reason: msg.reason,
              operator: msg.operator || 'flow',
              vin: msg.vin,
              source: 'node-red'
            });
            return {
              payload: state,
              extra: { stationId, topic: `station/${stationId}/state` },
              status: state.state === 'DOWN' ? STATUS.error(target) : STATUS.ok(target)
            };
          }

          case 'cycle': {
            const state = operations.recordCycle(stationId, {
              vin: msg.vin,
              cycleSeconds: msg.cycleSeconds ?? msg.payload?.cycleSeconds,
              good: msg.good !== false
            });
            return {
              payload: state,
              extra: { stationId },
              status: STATUS.ok(`cycle ${state.cycleCount}`)
            };
          }

          case 'telemetry': {
            const record = operations.recordTelemetry({
              stationId,
              metrics: msg.payload?.metrics || msg.payload || {},
              timestamp: msg.timestamp
            });
            return { payload: record, extra: { stationId }, status: STATUS.ok('telemetry') };
          }

          // ---- operator control --------------------------------------------
          // Each returns the station's control view, so the next node can see
          // the new mode and which actions are now legal.

          case 'control': {
            const view = operations.stationControl(stationId);
            return {
              payload: view,
              extra: { stationId },
              status: view.locked ? STATUS.warn(`${view.control.mode}`) : STATUS.ok(`${view.state} (AUTO)`)
            };
          }

          case 'start': {
            const view = operations.startStation(stationId, {
              operator: msg.operator || 'flow', note: msg.note, source: 'node-red'
            });
            return {
              payload: view,
              extra: { stationId, topic: `station/${stationId}/started` },
              status: STATUS.ok(`started ${stationId}`)
            };
          }

          case 'stop': {
            const view = operations.stopStation(stationId, {
              operator: msg.operator || 'flow',
              reasonCode: msg.reasonCode || node.reasonCode || undefined,
              reason: msg.reason,
              source: 'node-red'
            });
            return {
              payload: view,
              extra: { stationId, topic: `station/${stationId}/stopped` },
              status: STATUS.warn(`stopped ${stationId}`)
            };
          }

          case 'maintenance': {
            const view = operations.startMaintenance(stationId, {
              type: msg.maintenanceType || node.maintenanceType || undefined,
              technician: msg.technician || 'flow',
              plannedMinutes: msg.plannedMinutes,
              note: msg.note,
              source: 'node-red'
            });
            return {
              payload: view,
              extra: { stationId, maintenanceOrderId: view.activeMaintenance?.id },
              status: STATUS.warn(`${view.activeMaintenance?.id} ${view.activeMaintenance?.type}`)
            };
          }

          case 'completeMaintenance': {
            const view = operations.completeMaintenance(stationId, {
              technician: msg.technician,
              findings: msg.findings,
              partsReplaced: msg.partsReplaced,
              checklist: msg.checklist,
              source: 'node-red'
            });
            return {
              payload: view,
              extra: { stationId, maintenanceOrderId: view.completedOrder?.id },
              status: STATUS.ok(`${view.completedOrder?.id} done in ${view.completedOrder?.actualMinutes}m`)
            };
          }

          case 'pmStatus': {
            const due = operations.maintenanceDue({ lineId: msg.lineId || node.lineFilter || undefined });
            const attention = due.filter((d) => d.status !== 'OK').length;
            return {
              payload: due,
              extra: { total: due.length, attention },
              status: attention ? STATUS.warn(`${attention} need PM`) : STATUS.ok('PM up to date')
            };
          }

          case 'list': {
            const lineId = msg.lineId || node.lineFilter || undefined;
            const states = operations.listStationStates(lineId);
            const down = states.filter((s) => s.state === 'DOWN').length;
            return {
              payload: states,
              extra: { total: states.length },
              status: down ? STATUS.warn(`${states.length} stations, ${down} down`) : STATUS.ok(`${states.length} stations`)
            };
          }

          default:
            throw Object.assign(new Error(`Unknown pc-station operation '${node.operation}'`), {
              code: 'VALIDATION_FAILED', status: 400
            });
        }
      });
    });
  });
};
