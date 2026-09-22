'use strict';

/**
 * REST API v1.
 *
 * Route modules are thin: validate input, call a service, shape the response.
 * Every rule lives in core/ or services/, which is what lets the Node-RED flows
 * and the HTTP API enforce exactly the same behaviour.
 */

const express = require('express');
const { asyncHandler, pagination } = require('../middleware');
const { ValidationError, NotFoundError } = require('../../core/errors');
const workOrderCore = require('../../core/workOrder');
const { version: VERSION } = require('../../../package.json');
const plantModel = require('../../core/plantModel');
const bom = require('../../core/bom');
const quality = require('../../core/quality');
const downtime = require('../../core/downtime');
const andon = require('../../core/andon');
const shift = require('../../core/shift');
const stationControl = require('../../core/stationControl');
const { allStateMachines } = require('../../core/stateMachines');
const oeeCore = require('../../core/oee');
const config = require('../../config');

/**
 * @param {object} ctx application context from services/index.js
 * @returns {import('express').Router}
 */
function buildRoutes(ctx) {
  const router = express.Router();
  const { production, quality: qa, operations, kpi, trace, repository } = ctx;

  const requireBody = (req) => {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      throw new ValidationError('A JSON object body is required');
    }
    return req.body;
  };

  // ======================================================================
  // System
  // ======================================================================

  router.get('/health', (_req, res) => {
    const memory = process.memoryUsage();
    res.json({
      status: 'ok',
      service: 'production-core',
      version: VERSION,
      environment: config.env,
      runtime: {
        mode: config.runtime.serverless ? 'serverless' : 'server',
        nodeRed: Boolean(ctx.nodeRed),
        fullRuntimeUrl: config.runtime.fullRuntimeUrl || null
      },
      site: config.site,
      uptimeSeconds: Math.round(process.uptime()),
      memory: {
        rssMb: Number((memory.rss / 1048576).toFixed(1)),
        heapUsedMb: Number((memory.heapUsed / 1048576).toFixed(1))
      },
      store: repository.diagnostics(),
      simulator: ctx.simulator ? ctx.simulator.status() : { enabled: false },
      mqtt: ctx.broker ? ctx.broker.status() : { enabled: false },
      timestamp: new Date().toISOString()
    });
  });

  // Liveness/readiness split so a PaaS health check can distinguish
  // "process is up" from "plant data is loaded".
  router.get('/live', (_req, res) => res.json({ status: 'alive' }));
  router.get('/ready', (_req, res) => {
    const ready = repository.count('stationStates') > 0;
    res.status(ready ? 200 : 503).json({
      status: ready ? 'ready' : 'starting',
      stations: repository.count('stationStates'),
      units: repository.count('units')
    });
  });

  // ======================================================================
  // Plant model (reference data)
  // ======================================================================

  router.get('/plant', (_req, res) => res.json(plantModel.hierarchy(config.site)));

  router.get('/lines', (_req, res) => {
    res.json({
      items: plantModel.LINES.map((line) => ({
        id: line.id,
        name: line.name,
        kind: line.kind,
        areaId: line.area,
        sequence: line.sequence,
        taktSeconds: line.taktSeconds,
        description: line.description,
        feeds: line.feeds || null,
        stationCount: line.stations.length,
        capacityJph: plantModel.lineCapacityJph(line.id),
        bottleneck: plantModel.bottleneckStation(line.id)?.id || null
      })),
      total: plantModel.LINES.length
    });
  });

  router.get('/lines/:lineId', asyncHandler((req, res) => {
    const line = plantModel.getLine(req.params.lineId);
    if (!line) throw new NotFoundError('Line', req.params.lineId);
    res.json({
      ...line,
      capacityJph: plantModel.lineCapacityJph(line.id),
      bottleneck: plantModel.bottleneckStation(line.id)?.id || null,
      stations: plantModel.listStations(line.id)
    });
  }));

  router.get('/lines/:lineId/oee', asyncHandler((req, res) => {
    res.json(kpi.lineOee(req.params.lineId, {
      since: req.query.since, until: req.query.until
    }));
  }));

  router.get('/stations', (req, res) => {
    const states = operations.listStationStates(req.query.lineId);
    res.json({
      items: states.map((state) => {
        const station = plantModel.getStation(state.stationId);
        return {
          ...state,
          capability: station?.capability,
          sequence: station?.sequence,
          qualityGate: Boolean(station?.qualityGate),
          criticalToQuality: Boolean(station?.criticalToQuality),
          robots: station?.robots || 0,
          controlMode: stationControl.controlOf(state).mode,
          pmStatus: stationControl.pmStatus(state).status
        };
      }),
      total: states.length
    });
  });

  router.get('/stations/:stationId', asyncHandler((req, res) => {
    const station = plantModel.getStation(req.params.stationId);
    if (!station) throw new NotFoundError('Station', req.params.stationId);
    res.json({
      ...station,
      state: operations.getStationState(station.id),
      control: operations.stationControl(station.id),
      partsConsumed: bom.partsConsumedAt(station.id),
      inspectionPlan: station.inspectionPlan
        ? quality.getInspectionPlan(station.inspectionPlan)
        : null
    });
  }));

  router.post('/stations/:stationId/state', asyncHandler((req, res) => {
    const body = requireBody(req);
    if (!body.state) throw new ValidationError('state is required', { field: 'state' });
    res.json(operations.setStationState(req.params.stationId, body.state, {
      reason: body.reason,
      reasonCode: body.reasonCode,
      operator: body.operator,
      vin: body.vin,
      source: 'api'
    }));
  }));

  // ---- operator control -------------------------------------------------
  //
  // Every action returns the station's full control view - state, mode, the
  // actions now legal, PM status and any open order - so a control panel can
  // redraw itself from the response without a second request.

  router.get('/stations/:stationId/control', asyncHandler((req, res) => {
    res.json(operations.stationControl(req.params.stationId));
  }));

  router.post('/stations/:stationId/start', asyncHandler((req, res) => {
    const body = req.body || {};
    res.json(operations.startStation(req.params.stationId, {
      operator: body.operator, note: body.note, source: 'api'
    }));
  }));

  router.post('/stations/:stationId/stop', asyncHandler((req, res) => {
    const body = req.body || {};
    res.json(operations.stopStation(req.params.stationId, {
      operator: body.operator, reasonCode: body.reasonCode, reason: body.reason, source: 'api'
    }));
  }));

  router.post('/stations/:stationId/maintenance', asyncHandler((req, res) => {
    const body = req.body || {};
    res.status(201).json(operations.startMaintenance(req.params.stationId, {
      type: body.type,
      technician: body.technician,
      plannedMinutes: body.plannedMinutes,
      note: body.note,
      source: 'api'
    }));
  }));

  router.post('/stations/:stationId/maintenance/complete', asyncHandler((req, res) => {
    const body = req.body || {};
    res.json(operations.completeMaintenance(req.params.stationId, {
      technician: body.technician,
      findings: body.findings,
      partsReplaced: body.partsReplaced,
      checklist: body.checklist,
      source: 'api'
    }));
  }));

  router.get('/stations/:stationId/maintenance', asyncHandler((req, res) => {
    const control = operations.stationControl(req.params.stationId);
    const history = operations.listMaintenance({
      stationId: req.params.stationId, limit: Math.min(Number(req.query.limit) || 20, 200)
    });
    res.json({
      stationId: control.stationId,
      pm: control.pm,
      active: control.activeMaintenance,
      checklist: stationControl.checklistFor(plantModel.getStation(control.stationId)),
      history: history.items,
      total: history.total
    });
  }));

  router.get('/stations/:stationId/oee', asyncHandler((req, res) => {
    res.json(kpi.stationOee(req.params.stationId, {
      since: req.query.since, until: req.query.until
    }));
  }));

  router.get('/models', (_req, res) => {
    res.json({ items: production.listModels(), total: plantModel.MODELS.length });
  });

  router.get('/parts', (req, res) => {
    const items = bom.listParts().filter((p) =>
      (!req.query.supplier || p.supplier === req.query.supplier)
      && (req.query.lotControlled === undefined
        || p.lotControlled === (req.query.lotControlled === 'true'))
      && (req.query.safetyCritical === undefined
        || Boolean(p.safetyCritical) === (req.query.safetyCritical === 'true')));
    res.json({ items, total: items.length });
  });

  router.get('/boms/:modelCode', asyncHandler((req, res) => {
    res.json(bom.bomForModel(req.params.modelCode));
  }));

  router.get('/shifts', (_req, res) => {
    const window = shift.shiftWindow();
    res.json({
      current: {
        ...window.shift,
        key: shift.shiftKey(window),
        start: window.start.toISOString(),
        end: window.end.toISOString(),
        elapsedSeconds: shift.elapsedInShift(),
        plannedBusySeconds: shift.plannedBusySeconds(window.shift, window.lengthHours)
      },
      definitions: shift.listShifts(),
      timezone: config.site.timezone
    });
  });

  // Reference code tables - useful for populating dropdowns in any client.
  router.get('/reference/defect-codes', (req, res) => {
    const items = quality.listDefectCodes(req.query.family);
    res.json({ items, total: items.length });
  });
  router.get('/reference/downtime-reasons', (req, res) => {
    const items = downtime.listReasonCodes(req.query.category);
    res.json({ items, total: items.length });
  });
  router.get('/reference/andon-types', (_req, res) => {
    res.json({
      items: Object.values(andon.CALL_TYPES),
      escalationTiers: andon.ESCALATION_TIERS
    });
  });
  router.get('/reference/maintenance-types', (_req, res) => {
    res.json({
      items: Object.values(stationControl.MAINTENANCE_TYPES),
      controlModes: Object.keys(stationControl.CONTROL_MODES),
      actions: Object.values(stationControl.ACTIONS)
    });
  });

  router.get('/reference/state-machines', (_req, res) => {
    res.json(allStateMachines());
  });

  router.get('/reference/inspection-plans', (_req, res) => {
    res.json({
      items: Object.values(quality.INSPECTION_PLANS),
      total: Object.keys(quality.INSPECTION_PLANS).length
    });
  });

  // ======================================================================
  // Work orders
  // ======================================================================

  router.get('/work-orders', pagination, (req, res) => {
    res.json(production.listWorkOrders({ ...req.query, ...req.page }));
  });

  router.post('/work-orders', asyncHandler((req, res) => {
    res.status(201).json(production.createWorkOrder(requireBody(req)));
  }));

  router.get('/work-orders/:id', asyncHandler((req, res) => {
    const workOrder = production.getWorkOrder(req.params.id);
    res.json({
      ...workOrder,
      progress: workOrderCore.progress(workOrder),
      units: production.listUnits({ workOrderId: workOrder.id, limit: 500 }).items
    });
  }));

  router.post('/work-orders/:id/release', asyncHandler((req, res) => {
    res.json(production.releaseWorkOrder(req.params.id, req.body || {}));
  }));

  router.post('/work-orders/:id/transition', asyncHandler((req, res) => {
    const body = requireBody(req);
    if (!body.status) throw new ValidationError('status is required', { field: 'status' });
    res.json(production.transitionWorkOrder(req.params.id, body.status, { reason: body.reason }));
  }));

  // ======================================================================
  // Units (vehicles)
  // ======================================================================

  router.get('/units', pagination, (req, res) => {
    res.json(production.listUnits({ ...req.query, ...req.page }));
  });

  router.get('/units/wip', (_req, res) => {
    const items = production.workInProgress();
    res.json({ items, total: items.length });
  });

  router.get('/units/:vin', asyncHandler((req, res) => {
    res.json(production.getUnit(req.params.vin));
  }));

  router.get('/units/:vin/history', asyncHandler((req, res) => {
    res.json(production.unitHistory(req.params.vin));
  }));

  router.get('/units/:vin/genealogy', asyncHandler((req, res) => {
    res.json(production.genealogyReport(req.params.vin));
  }));

  router.post('/units/:vin/move', asyncHandler((req, res) => {
    const body = requireBody(req);
    if (!body.stationId) throw new ValidationError('stationId is required', { field: 'stationId' });
    res.json(production.moveUnit(req.params.vin, body.stationId, {
      operator: body.operator, force: body.force, result: body.result, source: 'api'
    }));
  }));

  router.post('/units/:vin/advance', asyncHandler((req, res) => {
    res.json(production.advanceUnit(req.params.vin, { ...(req.body || {}), source: 'api' }));
  }));

  router.post('/units/:vin/hold', asyncHandler((req, res) => {
    const body = requireBody(req);
    res.json(production.holdUnit(req.params.vin, body.reason, { operator: body.operator }));
  }));

  router.post('/units/:vin/rework', asyncHandler((req, res) => {
    const body = requireBody(req);
    res.json(production.reworkUnit(req.params.vin, body.reason, { operator: body.operator }));
  }));

  router.post('/units/:vin/release', asyncHandler((req, res) => {
    res.json(production.releaseUnit(req.params.vin, req.body || {}));
  }));

  router.post('/units/:vin/complete', asyncHandler((req, res) => {
    res.json(production.completeUnit(req.params.vin, { ...(req.body || {}), source: 'api' }));
  }));

  router.post('/units/:vin/scrap', asyncHandler((req, res) => {
    const body = requireBody(req);
    if (!body.reason) throw new ValidationError('reason is required to scrap a unit', { field: 'reason' });
    res.json(production.scrapUnit(req.params.vin, body.reason, { operator: body.operator }));
  }));

  // ======================================================================
  // Sub-assemblies
  // ======================================================================

  router.get('/sub-assemblies', pagination, (req, res) => {
    res.json(production.listSubAssemblies({ ...req.query, ...req.page }));
  });

  router.get('/sub-assemblies/buffers', (_req, res) => {
    const items = production.bufferLevels();
    res.json({ items, total: items.length, atRisk: items.filter((b) => b.starvationRisk).length });
  });

  router.get('/sub-assemblies/:serial', asyncHandler((req, res) => {
    res.json(production.getSubAssembly(req.params.serial));
  }));

  router.post('/sub-assemblies', asyncHandler((req, res) => {
    const body = requireBody(req);
    if (!body.classCode) throw new ValidationError('classCode is required', { field: 'classCode' });
    res.status(201).json(production.buildSubAssembly(body.classCode, {
      forVin: body.forVin, passed: body.passed, measurements: body.measurements
    }));
  }));

  // ======================================================================
  // Quality
  // ======================================================================

  router.get('/quality/summary', (req, res) => {
    res.json(qa.summary({ since: req.query.since, lineId: req.query.lineId }));
  });

  router.get('/quality/inspections', pagination, (req, res) => {
    res.json(qa.listInspections({
      ...req.query, ...req.page,
      passed: req.query.passed === undefined ? undefined : req.query.passed === 'true'
    }));
  });

  router.post('/quality/inspections', asyncHandler((req, res) => {
    const body = requireBody(req);
    if (!body.measurements) {
      throw new ValidationError('measurements is required', { field: 'measurements' });
    }
    res.status(201).json(qa.recordInspection(body));
  }));

  router.get('/quality/defects', pagination, (req, res) => {
    res.json(qa.listDefects({
      ...req.query, ...req.page,
      open: req.query.open === undefined ? undefined : req.query.open === 'true'
    }));
  });

  router.post('/quality/defects', asyncHandler((req, res) => {
    const body = requireBody(req);
    if (!body.code) throw new ValidationError('code is required', { field: 'code' });
    res.status(201).json(qa.raiseDefect(body));
  }));

  router.get('/quality/defects/:id', asyncHandler((req, res) => {
    res.json(qa.getDefect(req.params.id));
  }));

  router.post('/quality/defects/:id/disposition', asyncHandler((req, res) => {
    const body = requireBody(req);
    if (!body.disposition) {
      throw new ValidationError('disposition is required', { field: 'disposition' });
    }
    res.json(qa.dispositionDefect(req.params.id, body.disposition, {
      operator: body.operator, note: body.note, repairMinutes: body.repairMinutes
    }));
  }));

  router.post('/quality/defects/:id/close', asyncHandler((req, res) => {
    res.json(qa.closeDefect(req.params.id, { operator: (req.body || {}).operator }));
  }));

  router.get('/quality/gate/:vin/:stationId', asyncHandler((req, res) => {
    res.json(qa.evaluateGate(req.params.vin, req.params.stationId));
  }));

  // ======================================================================
  // Maintenance
  // ======================================================================

  router.get('/maintenance', pagination, (req, res) => {
    res.json(operations.listMaintenance({ ...req.query, ...req.page }));
  });

  router.get('/maintenance/due', (req, res) => {
    const items = operations.maintenanceDue({
      lineId: req.query.lineId, dueOnly: req.query.dueOnly === 'true'
    });
    res.json({
      items,
      total: items.length,
      summary: items.reduce((acc, item) => {
        acc[item.status] = (acc[item.status] || 0) + 1;
        return acc;
      }, {})
    });
  });

  router.get('/maintenance/:id', asyncHandler((req, res) => {
    res.json(operations.getMaintenanceOrder(req.params.id));
  }));

  // ======================================================================
  // Andon
  // ======================================================================

  router.get('/andon', pagination, (req, res) => {
    res.json(operations.listAndons({
      ...req.query, ...req.page,
      open: req.query.open === undefined ? undefined : req.query.open === 'true'
    }));
  });

  router.post('/andon', asyncHandler((req, res) => {
    const body = requireBody(req);
    res.status(201).json(operations.raiseAndon(body));
  }));

  router.get('/andon/:id', asyncHandler((req, res) => {
    res.json(operations.getAndon(req.params.id));
  }));

  router.post('/andon/:id/acknowledge', asyncHandler((req, res) => {
    res.json(operations.acknowledgeAndon(req.params.id, (req.body || {}).responder));
  }));

  router.post('/andon/:id/escalate', asyncHandler((req, res) => {
    res.json(operations.escalateAndon(req.params.id));
  }));

  router.post('/andon/:id/resolve', asyncHandler((req, res) => {
    const body = requireBody(req);
    res.json(operations.resolveAndon(req.params.id, body.resolution, body.resolver));
  }));

  // ======================================================================
  // Downtime
  // ======================================================================

  router.get('/downtime', pagination, (req, res) => {
    res.json(operations.listDowntimes({
      ...req.query, ...req.page,
      open: req.query.open === undefined ? undefined : req.query.open === 'true'
    }));
  });

  router.get('/downtime/current', (_req, res) => {
    const items = operations.currentStops();
    res.json({ items, total: items.length });
  });

  router.post('/downtime', asyncHandler((req, res) => {
    const body = requireBody(req);
    res.status(201).json(operations.startDowntime(body));
  }));

  router.post('/downtime/:id/end', asyncHandler((req, res) => {
    res.json(operations.endDowntime(req.params.id, req.body || {}));
  }));

  router.get('/operations/summary', (req, res) => {
    res.json(operations.summary({ since: req.query.since, lineId: req.query.lineId }));
  });

  // ======================================================================
  // KPI
  // ======================================================================

  router.get('/kpi/dashboard', (req, res) => {
    res.json(kpi.dashboard({ since: req.query.since, until: req.query.until }));
  });

  router.get('/kpi/oee', (req, res) => {
    res.json(kpi.plantOee({ since: req.query.since, until: req.query.until }));
  });

  // Pure calculation, no plant state: the same ISO 22400 engine the plant
  // uses, exposed so a calculator (the docs have one) runs the real formula
  // instead of a copy of it.
  router.get('/kpi/calculate', asyncHandler((req, res) => {
    const number = (name, fallback) => {
      if (req.query[name] === undefined) return fallback;
      const value = Number(req.query[name]);
      if (!Number.isFinite(value)) {
        throw new ValidationError(`${name} must be a number`, { field: name });
      }
      return value;
    };
    res.json(oeeCore.calculateOee({
      plannedBusySeconds: number('plannedBusySeconds', 26400),
      plannedDowntimeSeconds: number('plannedDowntimeSeconds', 0),
      downtimeSeconds: number('downtimeSeconds', 0),
      totalCount: number('totalCount', 0),
      goodCount: number('goodCount', 0),
      idealCycleSeconds: number('idealCycleSeconds', 60)
    }));
  }));

  router.get('/kpi/trend', (req, res) => {
    const count = Math.min(Math.max(Number.parseInt(req.query.shifts, 10) || 8, 1), 30);
    res.json({ items: kpi.shiftTrend(count), total: count });
  });

  // ======================================================================
  // Traceability
  // ======================================================================

  router.post('/trace/recall', asyncHandler((req, res) => {
    res.json(trace.recall(requireBody(req)));
  }));

  router.get('/trace/lots', (req, res) => {
    res.json(trace.listLots({
      supplier: req.query.supplier,
      partNumber: req.query.partNumber,
      limit: req.page?.limit
    }));
  });

  router.get('/trace/lots/:lotCode', asyncHandler((req, res) => {
    res.json(trace.lotUsage(req.params.lotCode));
  }));

  router.get('/trace/vehicle/:vin', asyncHandler((req, res) => {
    res.json(trace.vehicleTrace(req.params.vin));
  }));

  // ======================================================================
  // Events
  // ======================================================================

  router.get('/events', (req, res) => {
    res.json(repository.series_('events', {
      where: (event) =>
        (!req.query.type || event.type === req.query.type)
        && (!req.query.lineId || event.lineId === req.query.lineId)
        && (!req.query.stationId || event.stationId === req.query.stationId)
        && (!req.query.vin || event.vin === req.query.vin)
        && (!req.query.severity || event.severity === req.query.severity),
      since: req.query.since,
      limit: Math.min(Number.parseInt(req.query.limit, 10) || 100, 1000)
    }));
  });

  /**
   * Server-sent events stream.
   *
   * Chosen over WebSocket deliberately: SSE is plain HTTP, so it survives every
   * PaaS proxy and needs no extra port, and the plant feed is one-directional.
   */
  router.get('/events/stream', (req, res) => {
    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no' // stops nginx-style proxies buffering the stream
    });
    res.flushHeaders?.();

    const typeFilter = req.query.type ? String(req.query.type).split(',') : null;
    res.write(`event: connected\ndata: ${JSON.stringify({
      at: new Date().toISOString(), filter: typeFilter
    })}\n\n`);

    const unsubscribe = ctx.eventBus.onAny((envelope) => {
      if (typeFilter && !typeFilter.some((t) => envelope.type.startsWith(t))) return;
      res.write(`event: ${envelope.type}\ndata: ${JSON.stringify(envelope)}\n\n`);
    });

    // Comment frames keep idle proxies from closing the connection.
    const heartbeat = setInterval(() => res.write(': keep-alive\n\n'), 20000);
    heartbeat.unref?.();

    // On a serverless host the function has a maximum duration. Ending the
    // stream first, with a retry hint, turns the platform's hard cut into an
    // ordinary EventSource reconnect.
    let limit = null;
    if (config.http.sseMaxSeconds > 0) {
      res.write('retry: 2000\n\n');
      limit = setTimeout(() => res.end(), config.http.sseMaxSeconds * 1000);
    }

    req.on('close', () => {
      clearInterval(heartbeat);
      clearTimeout(limit);
      unsubscribe();
    });
  });

  // ======================================================================
  // Simulator control
  // ======================================================================

  router.get('/simulator', (_req, res) => {
    res.json(ctx.simulator ? ctx.simulator.status() : { enabled: false });
  });

  router.post('/simulator/:action', asyncHandler((req, res) => {
    if (!ctx.simulator) throw new ValidationError('The simulator is not enabled on this instance');
    const { action } = req.params;
    const body = req.body || {};

    switch (action) {
      case 'start': ctx.simulator.start(); break;
      case 'stop': ctx.simulator.stop(); break;
      case 'speed': {
        const speed = Number(body.speed);
        if (!Number.isFinite(speed) || speed < 1 || speed > 200) {
          throw new ValidationError('speed must be a number between 1 and 200', { field: 'speed' });
        }
        ctx.simulator.setSpeed(speed);
        break;
      }
      case 'inject-fault':
        return res.json(ctx.simulator.injectFault(body.stationId, body.reasonCode, body.durationSeconds));
      case 'inject-defect':
        return res.json(ctx.simulator.injectDefect(body.vin, body.code, body.stationId));
      default:
        throw new ValidationError(
          `Unknown simulator action '${action}'. Valid: start, stop, speed, inject-fault, inject-defect`
        );
    }
    return res.json(ctx.simulator.status());
  }));

  return router;
}

module.exports = { buildRoutes };
