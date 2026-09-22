'use strict';

const bom = require('../../src/core/bom');
const genealogy = require('../../src/core/genealogy');
const quality = require('../../src/core/quality');
const downtime = require('../../src/core/downtime');
const andon = require('../../src/core/andon');
const shift = require('../../src/core/shift');
const plantModel = require('../../src/core/plantModel');
const subAssembly = require('../../src/core/subAssembly');

describe('plant model', () => {
  it('passes its own integrity check', () => {
    expect(() => plantModel.assertPlantModelIntegrity()).not.toThrow();
  });

  it('has 7 lines and 43 stations', () => {
    expect(plantModel.LINES).toHaveLength(7);
    expect(plantModel.ALL_STATIONS).toHaveLength(43);
  });

  it('routes a vehicle through every main-line station in order', () => {
    expect(plantModel.MAIN_STATION_ROUTE[0]).toBe('BODY-10');
    expect(plantModel.MAIN_STATION_ROUTE.at(-1)).toBe('EOL-60');
    expect(plantModel.nextMainStation('BODY-50')).toBe('PAINT-10');
    expect(plantModel.nextMainStation('PAINT-60')).toBe('TRIM-10');
    expect(plantModel.nextMainStation('EOL-60')).toBeNull();
    expect(plantModel.previousMainStation('BODY-10')).toBeNull();
  });

  it('never routes a vehicle through a feeder line', () => {
    const feederStations = plantModel.LINES
      .filter((l) => l.kind === 'FEEDER')
      .flatMap((l) => l.stations.map((s) => s.id));

    for (const stationId of feederStations) {
      expect(plantModel.MAIN_STATION_ROUTE).not.toContain(stationId);
    }
  });

  it('identifies the bottleneck as the slowest station, not the average', () => {
    const bottleneck = plantModel.bottleneckStation('MAINASM');
    const slowest = Math.max(...plantModel.listStations('MAINASM').map((s) => s.cycleSeconds));

    expect(bottleneck.cycleSeconds).toBe(slowest);
    expect(bottleneck.id).toBe('CHAS-10');
  });

  it('derives line capacity from the bottleneck', () => {
    const capacity = plantModel.lineCapacityJph('MAINASM');
    expect(capacity).toBeCloseTo(3600 / 60, 1);
  });

  it('walks a feeder line in sequence', () => {
    expect(plantModel.feederRoute('TIRE')).toEqual([
      'TIRE-10', 'TIRE-20', 'TIRE-30', 'TIRE-40', 'TIRE-50'
    ]);
    expect(plantModel.nextFeederStation('TIRE-10')).toBe('TIRE-20');
    expect(plantModel.nextFeederStation('TIRE-50')).toBeNull();
    expect(plantModel.feederRoute('MAINASM')).toEqual([]);
  });

  it('installs every serialised class at a station that consumes it', () => {
    for (const [classCode, spec] of Object.entries(plantModel.SERIAL_COMPONENTS)) {
      expect(spec.installedAt).toBeTruthy();
      const station = plantModel.getStation(spec.installedAt);
      expect(station).toBeTruthy();
      expect(station.consumesSerial).toContain(classCode);
    }
  });

  it('exposes the hierarchy as a serialisable tree', () => {
    const tree = plantModel.hierarchy({
      enterprise: 'Test Co', id: 'X', name: 'Plant', location: 'Nowhere', timezone: 'UTC'
    });
    expect(tree.areas).toHaveLength(5);
    expect(JSON.stringify(tree)).toContain('CHAS-10');
  });
});

describe('bill of materials', () => {
  it('derives the BOM from the routing, so it cannot drift', () => {
    const result = bom.bomForModel('NS-AURORA-EV');
    const consumedByRouting = plantModel.ALL_STATIONS.flatMap((s) => s.consumes);

    expect(result.lineCount).toBe(consumedByRouting.length);
    expect(result.materialCostCad).toBeGreaterThan(10000);
  });

  it('applies per-vehicle quantity overrides', () => {
    expect(bom.quantityPer('PN-TIRE-235')).toBe(5);   // four fitted plus a spare
    expect(bom.quantityPer('PN-DR-GLASS')).toBe(4);
    expect(bom.quantityPer('PN-WINDSHIELD')).toBe(1); // no override
  });

  it('knows which parts are lot-controlled and safety-critical', () => {
    expect(bom.isLotControlled('PN-BRAKE-FRONT')).toBe(true);
    expect(bom.isSafetyCritical('PN-BRAKE-FRONT')).toBe(true);
    expect(bom.isLotControlled('PN-DR-SHIELD')).toBe(false);
  });

  it('404s an unknown part or model', () => {
    expect(() => bom.getPart('PN-NOT-REAL')).toThrow(/Part 'PN-NOT-REAL' was not found/);
    expect(() => bom.bomForModel('NOPE')).toThrow(/Model 'NOPE' was not found/);
  });

  it('resolves the parts consumed at a station with quantities', () => {
    const parts = bom.partsConsumedAt('CHAS-30');
    expect(parts.map((p) => p.partNumber)).toEqual(['PN-BRAKE-LINE', 'PN-FUEL-LINE']);
    expect(parts.every((p) => p.safetyCritical)).toBe(true);
  });

  it('rejects an unknown station', () => {
    expect(() => bom.partsConsumedAt('NOPE-99')).toThrow(/Station 'NOPE-99' was not found/);
  });
});

describe('genealogy', () => {
  const makeRecord = () => genealogy.createGenealogy('2NSAURE1XTW000001', {
    workOrderId: 'WO-1', modelCode: 'NS-AURORA-EV'
  });

  it('requires a VIN', () => {
    expect(() => genealogy.createGenealogy(null)).toThrow(/vin is required/);
  });

  it('indexes lot codes as parts are recorded', () => {
    let record = makeRecord();
    record = genealogy.recordPart(record, {
      partNumber: 'PN-WINDSHIELD', lotCode: 'AGC-X-2637A', supplier: 'AGC'
    }, 'TRIM-30');

    expect(record.lotIndex).toEqual(['AGC-X-2637A']);
    expect(genealogy.matchesLot(record, 'AGC-X-2637A')).toBe(true);
    expect(genealogy.matchesLot(record, 'OTHER')).toBe(false);
  });

  it('does not duplicate a lot code recorded twice', () => {
    let record = makeRecord();
    const part = { partNumber: 'PN-COOLANT', lotCode: 'SHELL-X-2637A' };
    record = genealogy.recordPart(record, part, 'FINAL-40');
    record = genealogy.recordPart(record, part, 'FINAL-40');

    expect(record.lotIndex).toHaveLength(1);
    expect(record.components).toHaveLength(2);
  });

  it('folds a sub-assembly and its own parts into the tree', () => {
    let module = subAssembly.createSubAssembly({ serial: 'PWT-1', classCode: 'PWT' });
    module = subAssembly.addComponent(module, {
      partNumber: 'PN-ENGINE-BLOCK', lotCode: 'NS-PT-2636B', safetyCritical: true
    });
    module = subAssembly.completeBuild(module);

    const record = genealogy.recordSubAssembly(makeRecord(), module, 'CHAS-10');
    const rows = genealogy.flatten(record);

    expect(rows[0].type).toBe('SUBASSEMBLY');
    expect(rows[0].level).toBe(1);
    expect(rows[1].type).toBe('PART');
    expect(rows[1].level).toBe(2);
    expect(rows[1].parentId).toBe('PWT-1');
    expect(record.lotIndex).toContain('NS-PT-2636B');
    expect(genealogy.containsSerial(record, 'PWT-1')).toBe(true);
  });

  it('is append-only once sealed', () => {
    const sealed = genealogy.seal(makeRecord());

    expect(sealed.sealedAt).toBeTruthy();
    expect(() => genealogy.seal(sealed)).toThrow(/sealed/);
    expect(() => genealogy.recordPart(sealed, { partNumber: 'PN-HOOD' }, 'BODY-40'))
      .toThrow(/immutable/);
  });

  it('requires a part number', () => {
    expect(() => genealogy.recordPart(makeRecord(), {}, 'BODY-10'))
      .toThrow(/partNumber is required/);
  });

  it('locates a part, lot or serial in the tree', () => {
    let record = makeRecord();
    record = genealogy.recordPart(record, {
      partNumber: 'PN-WINDSHIELD', lotCode: 'AGC-X-2637A'
    }, 'TRIM-30');

    expect(genealogy.locate(record, { lotCode: 'AGC-X-2637A' })).toHaveLength(1);
    expect(genealogy.locate(record, { partNumber: 'PN-WINDSHIELD' })).toHaveLength(1);
    expect(genealogy.locate(record, { partNumber: 'PN-HOOD' })).toHaveLength(0);
    // Nothing to search on returns nothing rather than everything.
    expect(genealogy.locate(record, {})).toHaveLength(0);
  });

  it('lists distinct part numbers across all levels', () => {
    let module = subAssembly.createSubAssembly({ serial: 'PWT-1', classCode: 'PWT' });
    module = subAssembly.addComponent(module, { partNumber: 'PN-ENGINE-BLOCK' });
    module = subAssembly.completeBuild(module);

    let record = genealogy.recordSubAssembly(makeRecord(), module, 'CHAS-10');
    record = genealogy.recordPart(record, { partNumber: 'PN-WINDSHIELD' }, 'TRIM-30');

    expect(genealogy.partNumbers(record).sort())
      .toEqual(['PN-ENGINE-BLOCK', 'PN-WINDSHIELD']);
  });
});

describe('quality catalogue', () => {
  it('has a defect code for every family', () => {
    const families = new Set(quality.DEFECT_CODES.map((d) => d.family));
    expect([...families].sort())
      .toEqual(['ASSEMBLY', 'BODY', 'ELECTRICAL', 'FUNCTIONAL', 'PAINT', 'TRIM']);
  });

  it('points every inspection plan at a station that runs it', () => {
    for (const plan of Object.values(quality.INSPECTION_PLANS)) {
      const station = plantModel.getStation(plan.stationId);
      expect(station).toBeTruthy();
      expect(station.inspectionPlan).toBe(plan.id);
      expect(plan.characteristics.length).toBeGreaterThan(0);
    }
  });

  it('gives every characteristic a sane spec window and a defect code', () => {
    for (const plan of Object.values(quality.INSPECTION_PLANS)) {
      for (const characteristic of plan.characteristics) {
        expect(characteristic.lowerLimit).toBeLessThanOrEqual(characteristic.upperLimit);
        expect(quality.getDefectCode(characteristic.defectCode)).toBeTruthy();
      }
    }
  });

  it('measures deviation from the nearest limit, signed', () => {
    const characteristic = {
      id: 'X', name: 'x', uom: 'mm', nominal: 0, lowerLimit: -1, upperLimit: 1, defectCode: 'SCRATCH'
    };

    expect(quality.evaluateCharacteristic(characteristic, 0).deviation).toBe(0);
    expect(quality.evaluateCharacteristic(characteristic, 1.5).deviation).toBe(0.5);
    expect(quality.evaluateCharacteristic(characteristic, -1.4).deviation).toBe(-0.4);
    expect(quality.evaluateCharacteristic(characteristic, 1.5).inSpec).toBe(false);
  });

  it('rejects a non-numeric measurement', () => {
    const characteristic = { id: 'X', lowerLimit: 0, upperLimit: 1, defectCode: 'SCRATCH' };
    expect(() => quality.evaluateCharacteristic(characteristic, 'banana'))
      .toThrow(/must be numeric/);
  });

  it('rejects an unknown inspection plan or defect code', () => {
    expect(() => quality.runInspection('IP-NOPE', {}, {})).toThrow(/Unknown inspection plan/);
    expect(() => quality.createDefect({ id: 'D', code: 'NOPE', vin: 'V', stationId: 'BODY-10' }))
      .toThrow(/failed validation/);
  });

  it('finds the plan for a station', () => {
    expect(quality.planForStation('BODY-50').id).toBe('IP-BIW-CMM');
    expect(quality.planForStation('BODY-10')).toBeNull();
  });

  it('blocks a gate on critical, and on undispositioned major', () => {
    expect(quality.blocksGate([{ severity: 'MINOR' }])).toBe(false);
    expect(quality.blocksGate([{ severity: 'MAJOR', disposition: 'REWORK' }])).toBe(false);
    expect(quality.blocksGate([{ severity: 'MAJOR' }])).toBe(true);
    expect(quality.blocksGate([{ severity: 'CRITICAL', disposition: 'REWORK' }])).toBe(true);
  });

  it('reports the worst severity in a set', () => {
    expect(quality.worstSeverity([])).toBeNull();
    expect(quality.worstSeverity([{ severity: 'MINOR' }, { severity: 'CRITICAL' }]))
      .toBe('CRITICAL');
  });

  it('builds a Pareto with running cumulative share', () => {
    const defects = [
      ...Array(7).fill({ code: 'DIRT_INCLUSION', family: 'PAINT' }),
      ...Array(2).fill({ code: 'ORANGE_PEEL', family: 'PAINT' }),
      { code: 'SCRATCH', family: 'TRIM' }
    ];
    const pareto = quality.pareto(defects);

    expect(pareto[0].key).toBe('DIRT_INCLUSION');
    expect(pareto[0].sharePct).toBe(70);
    expect(pareto.at(-1).cumulativePct).toBe(100);
    expect(quality.pareto(defects, { groupBy: 'family' })[0].key).toBe('PAINT');
  });

  it('refuses to reopen a closed defect', () => {
    const defect = quality.createDefect({
      id: 'D1', code: 'SCRATCH', vin: 'V', stationId: 'EOL-60'
    });
    const closed = quality.transitionDefect(defect, 'CLOSED');

    expect(() => quality.transitionDefect(closed, 'OPEN')).toThrow(/cannot be reopened/);
    expect(() => quality.disposition(closed, 'REWORK')).toThrow(/already closed/);
  });

  it('rejects an unknown disposition', () => {
    const defect = quality.createDefect({
      id: 'D1', code: 'SCRATCH', vin: 'V', stationId: 'EOL-60'
    });
    expect(() => quality.disposition(defect, 'MAKE_IT_GO_AWAY')).toThrow(/must be one of/);
  });
});

describe('downtime', () => {
  const at = new Date('2026-09-16T08:00:00Z');

  it('maps every reason code to a category and a loss class', () => {
    for (const reason of downtime.REASON_CODES) {
      expect(['PLANNED', 'UNPLANNED']).toContain(reason.category);
      if (reason.bigLoss) expect(downtime.BIG_LOSSES[reason.bigLoss]).toBeTruthy();
    }
  });

  it('excludes planned stops outside busy time from OEE', () => {
    expect(downtime.getReasonCode('PREVENTIVE_MAINT').countsAgainstOee).toBe(false);
    expect(downtime.getReasonCode('EQUIP_FAILURE').countsAgainstOee).toBe(true);
    // A changeover is planned but still comes out of available time.
    expect(downtime.getReasonCode('CHANGEOVER').countsAgainstOee).toBe(true);
  });

  it('freezes the duration when the record is closed', () => {
    const open = downtime.createDowntime({
      id: 'DT-1', stationId: 'PAINT-40', reasonCode: 'ROBOT_FAULT'
    }, at);

    expect(downtime.isOpen(open)).toBe(true);
    const closed = downtime.endDowntime(open, {}, new Date(at.getTime() + 600000));

    expect(closed.durationSeconds).toBe(600);
    expect(downtime.elapsedSeconds(closed)).toBe(600);
    expect(() => downtime.endDowntime(closed, {})).toThrow(/already closed/);
  });

  it('counts only breakdowns as reliability failures', () => {
    const breakdown = downtime.endDowntime(
      downtime.createDowntime({ id: 'A', stationId: 'PAINT-40', reasonCode: 'ROBOT_FAULT' }, at),
      {}, new Date(at.getTime() + 1800000)
    );
    const shortage = downtime.endDowntime(
      downtime.createDowntime({ id: 'B', stationId: 'TRIM-10', reasonCode: 'MATERIAL_SHORTAGE' }, at),
      {}, new Date(at.getTime() + 600000)
    );

    const reliability = downtime.reliability([breakdown, shortage], 8 * 3600);

    // A material shortage is not an equipment reliability event; folding it in
    // would make MTBF meaningless.
    expect(reliability.failureCount).toBe(1);
    expect(reliability.mttrMinutes).toBe(30);
    expect(reliability.mtbfHours).toBe(8);
  });

  it('returns null reliability figures when nothing has failed', () => {
    const reliability = downtime.reliability([], 8 * 3600);
    expect(reliability.mtbfHours).toBeNull();
    expect(reliability.mttrMinutes).toBeNull();
  });

  it('ranks the Pareto by minutes lost, not by occurrence count', () => {
    const records = [
      downtime.endDowntime(
        downtime.createDowntime({ id: 'A', stationId: 'PAINT-40', reasonCode: 'ROBOT_FAULT' }, at),
        {}, new Date(at.getTime() + 5400000) // one 90-minute breakdown
      ),
      ...Array.from({ length: 30 }, (_, i) => downtime.endDowntime(
        downtime.createDowntime({ id: `J${i}`, stationId: 'TRIM-10', reasonCode: 'CONVEYOR_JAM' }, at),
        {}, new Date(at.getTime() + 30000) // thirty 30-second jams
      ))
    ];

    const pareto = downtime.pareto(records);
    expect(pareto[0].reasonCode).toBe('ROBOT_FAULT');
    expect(pareto[0].occurrences).toBe(1);
    expect(pareto[1].occurrences).toBe(30);
  });

  it('rejects an unknown station or reason code', () => {
    expect(() => downtime.createDowntime({ id: 'X', stationId: 'NOPE', reasonCode: 'ROBOT_FAULT' }))
      .toThrow(/failed validation/);
    expect(() => downtime.createDowntime({ id: 'X', stationId: 'PAINT-40', reasonCode: 'NOPE' }))
      .toThrow(/failed validation/);
  });
});

describe('andon', () => {
  const at = new Date('2026-09-16T08:00:00Z');
  const make = (callType = 'MAINTENANCE') => andon.createAndon({
    id: 'AND-1', stationId: 'CHAS-10', callType
  }, at);

  it('knows which call types stop the line', () => {
    expect(andon.CALL_TYPES.SAFETY.stopsLine).toBe(true);
    expect(andon.CALL_TYPES.QUALITY.stopsLine).toBe(true);
    expect(andon.CALL_TYPES.MATERIAL.stopsLine).toBe(false);
    // Safety has the tightest SLA of all.
    const slas = Object.values(andon.CALL_TYPES).map((c) => c.slaSeconds);
    expect(andon.CALL_TYPES.SAFETY.slaSeconds).toBe(Math.min(...slas));
  });

  it('stops the response clock on acknowledge and decides SLA attainment', () => {
    const met = andon.acknowledge(make(), 'tech', new Date(at.getTime() + 60000));
    expect(met.responseSeconds).toBe(60);
    expect(met.slaMet).toBe(true);

    const missed = andon.acknowledge(make(), 'tech', new Date(at.getTime() + 600000));
    expect(missed.slaMet).toBe(false);
  });

  it('escalates up the ladder as the call ages', () => {
    expect(andon.escalate(make(), new Date(at.getTime() + 60000)).escalationTier).toBe(1);
    expect(andon.escalate(make(), new Date(at.getTime() + 400000)).escalatedTo).toBe('AREA_SUPERVISOR');
    expect(andon.escalate(make(), new Date(at.getTime() + 1000000)).escalatedTo).toBe('PLANT_MANAGER');
  });

  it('only escalates a RAISED call past its SLA', () => {
    const call = make();
    expect(andon.shouldEscalate(call, new Date(at.getTime() + 60000))).toBe(false);
    expect(andon.shouldEscalate(call, new Date(at.getTime() + 300000))).toBe(true);

    const acknowledged = andon.acknowledge(call, 'tech', new Date(at.getTime() + 60000));
    expect(andon.shouldEscalate(acknowledged, new Date(at.getTime() + 900000))).toBe(false);
  });

  it('derives a response time even when resolved without acknowledgement', () => {
    const resolved = andon.resolve(make(), 'fixed', 'tech', new Date(at.getTime() + 120000));
    expect(resolved.responseSeconds).toBe(120);
    expect(resolved.resolutionSeconds).toBe(120);
  });

  it('is closed once resolved or cancelled', () => {
    const resolved = andon.resolve(make(), 'fixed', 'tech', new Date(at.getTime() + 60000));
    expect(andon.isOpen(resolved)).toBe(false);
    expect(() => andon.acknowledge(resolved, 'tech')).toThrow(/is RESOLVED and is closed/);

    const cancelled = andon.cancel(make(), 'pulled by mistake');
    expect(andon.isOpen(cancelled)).toBe(false);
  });

  it('summarises volume, response time, SLA attainment and line-stop minutes', () => {
    const fast = andon.resolve(
      andon.acknowledge(make('MATERIAL'), 'lead', new Date(at.getTime() + 60000)),
      'restocked', 'lead', new Date(at.getTime() + 120000)
    );
    const slow = andon.resolve(
      andon.acknowledge(make('MAINTENANCE'), 'tech', new Date(at.getTime() + 600000)),
      'repaired', 'tech', new Date(at.getTime() + 1200000)
    );

    const summary = andon.summarise([fast, slow]);
    expect(summary.total).toBe(2);
    expect(summary.resolved).toBe(2);
    expect(summary.slaAttainmentPct).toBe(50);
    // Only the line-stopping call contributes to line-stop minutes.
    expect(summary.lineStopMinutes).toBe(20);
    expect(summary.byType).toEqual({ MATERIAL: 1, MAINTENANCE: 1 });
  });

  it('rejects an unknown station or call type', () => {
    expect(() => andon.createAndon({ id: 'X', stationId: 'NOPE', callType: 'SAFETY' }))
      .toThrow(/failed validation/);
    expect(() => andon.createAndon({ id: 'X', stationId: 'CHAS-10', callType: 'PANIC' }))
      .toThrow(/failed validation/);
  });
});

describe('shift calendar', () => {
  it('covers all 24 hours with no gap', () => {
    const covered = new Set();
    for (let hour = 0; hour < 24; hour += 1) {
      for (const definition of shift.SHIFTS) {
        const wraps = definition.endHour <= definition.startHour;
        const inside = wraps
          ? hour >= definition.startHour || hour < definition.endHour
          : hour >= definition.startHour && hour < definition.endHour;
        if (inside) covered.add(hour);
      }
    }
    expect(covered.size).toBe(24);
  });

  it('picks the right shift in the site timezone', () => {
    // Windsor is UTC-4 in September.
    expect(shift.shiftAt(new Date('2026-09-16T11:00:00Z')).id).toBe('A'); // 07:00 local
    expect(shift.shiftAt(new Date('2026-09-16T19:00:00Z')).id).toBe('B'); // 15:00 local
    expect(shift.shiftAt(new Date('2026-09-17T03:00:00Z')).id).toBe('C'); // 23:00 local
  });

  it('builds an 8-hour window even for the shift that wraps midnight', () => {
    for (const iso of ['2026-09-16T11:00:00Z', '2026-09-16T19:00:00Z', '2026-09-17T03:00:00Z']) {
      const window = shift.shiftWindow(new Date(iso));
      expect(window.lengthHours).toBe(8);
      expect(window.end.getTime() - window.start.getTime()).toBe(8 * 3600 * 1000);
      expect(new Date(iso).getTime()).toBeGreaterThanOrEqual(window.start.getTime());
      expect(new Date(iso).getTime()).toBeLessThan(window.end.getTime());
    }
  });

  it('subtracts scheduled breaks from planned busy time', () => {
    const dayShift = shift.getShift('A');
    expect(shift.plannedBusySeconds(dayShift, 8)).toBe(8 * 3600 - 40 * 60);
  });

  it('returns recent shifts newest first, including the current one', () => {
    const windows = shift.recentShifts(4, new Date('2026-09-16T11:00:00Z'));
    expect(windows.map(shift.shiftKey)).toEqual([
      '2026-09-16-A', '2026-09-15-C', '2026-09-15-B', '2026-09-15-A'
    ]);
  });

  it('can exclude the current shift', () => {
    const windows = shift.recentShifts(2, new Date('2026-09-16T11:00:00Z'), { includeCurrent: false });
    expect(windows.map(shift.shiftKey)).toEqual(['2026-09-15-C', '2026-09-15-B']);
  });

  it('clamps elapsed time to the shift length', () => {
    const elapsed = shift.elapsedInShift(new Date('2026-09-16T11:00:00Z'));
    expect(elapsed).toBeGreaterThanOrEqual(0);
    expect(elapsed).toBeLessThanOrEqual(8 * 3600);
  });

  it('flags the night shift as the maintenance window', () => {
    expect(shift.isMaintenanceWindow(new Date('2026-09-17T03:00:00Z'))).toBe(true);
    expect(shift.isMaintenanceWindow(new Date('2026-09-16T11:00:00Z'))).toBe(false);
  });
});
