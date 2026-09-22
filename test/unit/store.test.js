'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { Repository } = require('../../src/store/repository');
const { seedPlant } = require('../../src/store/seed');
const { makeContext } = require('../helpers/factory');

describe('repository', () => {
  let repo;
  beforeEach(() => { repo = new Repository({ driver: 'memory' }); });

  it('stores and retrieves by the collection key field', () => {
    repo.put('units', { vin: 'V1', status: 'IN_PROCESS' });

    expect(repo.get('units', 'V1').status).toBe('IN_PROCESS');
    expect(repo.has('units', 'V1')).toBe(true);
    expect(repo.get('units', 'nope')).toBeNull();
  });

  it('refuses a document missing its key', () => {
    expect(() => repo.put('units', { status: 'IN_PROCESS' }))
      .toThrow(/missing key field 'vin'/);
  });

  it('names the valid collections when given a bad one', () => {
    expect(() => repo.get('nope', 'x')).toThrow(/Unknown keyed collection 'nope'\. Known: /);
    expect(() => repo.append('nope', {})).toThrow(/Unknown series collection 'nope'/);
  });

  it('filters, sorts and pages', () => {
    for (let i = 0; i < 10; i += 1) {
      repo.put('units', { vin: `V${i}`, buildNumber: i, status: i % 2 ? 'HOLD' : 'IN_PROCESS' });
    }

    const held = repo.find('units', { where: (u) => u.status === 'HOLD' });
    expect(held.items).toHaveLength(5);
    expect(held.total).toBe(5);

    const page = repo.find('units', { sort: 'buildNumber', order: 'asc', limit: 3, offset: 2 });
    expect(page.items.map((u) => u.buildNumber)).toEqual([2, 3, 4]);
    expect(page.total).toBe(10);
  });

  it('sorts undefined values last regardless of direction', () => {
    repo.put('units', { vin: 'A', completedAt: '2026-01-01' });
    repo.put('units', { vin: 'B' });
    repo.put('units', { vin: 'C', completedAt: '2026-02-01' });

    const sorted = repo.find('units', { sort: 'completedAt', order: 'desc' });
    expect(sorted.items.at(-1).vin).toBe('B');
  });

  it('counts without materialising', () => {
    repo.put('units', { vin: 'V1', status: 'HOLD' });
    repo.put('units', { vin: 'V2', status: 'IN_PROCESS' });

    expect(repo.count('units')).toBe(2);
    expect(repo.count('units', (u) => u.status === 'HOLD')).toBe(1);
  });

  it('caps series collections so memory stays flat', () => {
    for (let i = 0; i < 25000; i += 1) {
      repo.append('events', { id: i, timestamp: new Date().toISOString() });
    }

    const raw = repo.seriesRaw('events');
    expect(raw).toHaveLength(20000);
    // The oldest entries are the ones dropped.
    expect(raw[0].id).toBe(5000);
    expect(raw.at(-1).id).toBe(24999);
  });

  it('reads series newest first', () => {
    ['a', 'b', 'c'].forEach((id, i) => repo.append('events', {
      id, timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString()
    }));

    expect(repo.series_('events').items.map((e) => e.id)).toEqual(['c', 'b', 'a']);
  });

  it('filters a series by timestamp', () => {
    repo.append('events', { id: 'old', timestamp: '2026-01-01T00:00:00Z' });
    repo.append('events', { id: 'new', timestamp: '2026-06-01T00:00:00Z' });

    const recent = repo.series_('events', { since: '2026-03-01T00:00:00Z' });
    expect(recent.items.map((e) => e.id)).toEqual(['new']);
  });

  it('issues monotonic sequences', () => {
    expect(repo.nextSequence('vin', 1000)).toBe(1000);
    expect(repo.nextSequence('vin')).toBe(1001);
    expect(repo.peekSequence('vin')).toBe(1001);
    expect(repo.peekSequence('never-used')).toBe(0);
  });

  it('indexes lots many-to-many and serials one-to-one', () => {
    repo.indexLot('LOT-A', 'V1');
    repo.indexLot('LOT-A', 'V2');
    repo.indexLot('LOT-A', 'V1'); // idempotent
    repo.indexSerial('PWT-1', 'V1');

    expect(repo.vinsForLot('LOT-A').sort()).toEqual(['V1', 'V2']);
    expect(repo.vinForSerial('PWT-1')).toBe('V1');
    expect(repo.vinForSerial('nope')).toBeNull();
    expect(repo.knownLots()).toEqual(['LOT-A']);
  });

  it('ignores an empty lot or serial', () => {
    repo.indexLot(null, 'V1');
    repo.indexSerial(undefined, 'V1');
    expect(repo.knownLots()).toEqual([]);
  });

  it('rebuilds its indexes from genealogy documents', () => {
    repo.put('genealogies', { vin: 'V1', lotIndex: ['LOT-A', 'LOT-B'], serialIndex: ['PWT-1'] });
    repo.put('genealogies', { vin: 'V2', lotIndex: ['LOT-A'], serialIndex: [] });

    repo.rebuildIndexes();

    expect(repo.vinsForLot('LOT-A').sort()).toEqual(['V1', 'V2']);
    expect(repo.vinForSerial('PWT-1')).toBe('V1');
  });

  it('round-trips a snapshot in memory', () => {
    repo.put('units', { vin: 'V1', status: 'COMPLETED' });
    repo.append('events', { id: 'e1', timestamp: new Date().toISOString() });
    repo.put('genealogies', { vin: 'V1', lotIndex: ['LOT-A'], serialIndex: [] });

    const restored = new Repository({ driver: 'memory' });
    restored.fromSnapshot(repo.toSnapshot());

    expect(restored.get('units', 'V1').status).toBe('COMPLETED');
    expect(restored.seriesRaw('events')).toHaveLength(1);
    expect(restored.vinsForLot('LOT-A')).toEqual(['V1']);
  });

  it('refuses a snapshot from an unsupported version', () => {
    expect(() => repo.fromSnapshot({ version: 99 })).toThrow(/Unsupported snapshot version/);
    expect(() => repo.fromSnapshot(null)).toThrow(/Unsupported snapshot version/);
  });

  it('reports collection sizes and IO counters', () => {
    repo.put('units', { vin: 'V1' });
    repo.get('units', 'V1');

    const diagnostics = repo.diagnostics();
    expect(diagnostics.collections.units).toBe(1);
    expect(diagnostics.stats.writes).toBeGreaterThan(0);
    expect(diagnostics.stats.reads).toBeGreaterThan(0);
  });

  it('clears everything on reset', () => {
    repo.put('units', { vin: 'V1' });
    repo.indexLot('LOT-A', 'V1');
    repo.reset();

    expect(repo.count('units')).toBe(0);
    expect(repo.knownLots()).toEqual([]);
  });
});

describe('repository file persistence', () => {
  let dataDir;
  let repo;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'production-core-test-'));
    repo = new Repository({ driver: 'file', dataDir });
  });

  afterEach(() => {
    repo.stopAutoSnapshot();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('writes and restores a snapshot on disk', () => {
    repo.put('units', { vin: 'V1', status: 'COMPLETED' });
    expect(repo.saveSnapshot()).toBe(true);
    expect(fs.existsSync(path.join(dataDir, 'production-core.snapshot.json'))).toBe(true);

    const restored = new Repository({ driver: 'file', dataDir });
    expect(restored.loadSnapshot()).toBe(true);
    expect(restored.get('units', 'V1').status).toBe('COMPLETED');
  });

  it('returns false rather than throwing when there is nothing to restore', () => {
    expect(repo.loadSnapshot()).toBe(false);
  });

  it('starts empty rather than crashing on a corrupt snapshot', () => {
    // A truncated snapshot must never block a boot - the seeder will refill.
    fs.writeFileSync(path.join(dataDir, 'production-core.snapshot.json'), '{ truncated');

    expect(repo.loadSnapshot()).toBe(false);
    expect(repo.count('units')).toBe(0);
  });

  it('does nothing for the memory driver', () => {
    const memory = new Repository({ driver: 'memory', dataDir });
    expect(memory.saveSnapshot()).toBe(false);
    expect(memory.loadSnapshot()).toBe(false);
  });
});

/**
 * The seeder backfills the CURRENT shift from its start up to `now`, so the
 * chosen instant has to be some way into a shift. 21:30 UTC is 17:30 in
 * Windsor - three and a half hours into the afternoon shift - which is enough
 * elapsed time for vehicles to have been launched and completed.
 */
describe('demo data seeder', () => {
  it('produces a coherent plant in a reasonable time', () => {
    const ctx = makeContext();
    const now = new Date('2026-09-16T21:30:00Z');

    const started = Date.now();
    const counts = seedPlant(ctx, { detailShifts: 1, days: 2, now, seed: 20260916 });
    const elapsed = Date.now() - started;

    expect(counts.units).toBeGreaterThan(50);
    expect(counts.completed).toBeGreaterThan(0);
    expect(counts.workOrders).toBeGreaterThan(0);
    expect(counts.shiftMetrics).toBeGreaterThan(0);
    // Must stay fast enough for a free-tier cold start.
    expect(elapsed).toBeLessThan(15000);
  });

  it('is deterministic for a given seed', () => {
    const now = new Date('2026-09-16T21:30:00Z');
    const options = { detailShifts: 1, days: 1, now, seed: 4242 };

    const a = makeContext();
    const b = makeContext();
    const countsA = seedPlant(a, options);
    const countsB = seedPlant(b, options);

    expect(countsA).toEqual(countsB);
    expect(a.repository.all('units').map((u) => u.vin))
      .toEqual(b.repository.all('units').map((u) => u.vin));
  });

  it('produces different plants for different seeds', () => {
    const now = new Date('2026-09-16T21:30:00Z');
    const a = makeContext();
    const b = makeContext();

    seedPlant(a, { detailShifts: 1, days: 1, now, seed: 1 });
    seedPlant(b, { detailShifts: 1, days: 1, now, seed: 2 });

    expect(a.repository.count('defects')).not.toBe(b.repository.count('defects'));
  });

  it('seeds vehicles that satisfy their own domain rules', () => {
    const ctx = makeContext();
    seedPlant(ctx, { detailShifts: 1, days: 1, now: new Date('2026-09-16T21:30:00Z') });

    const unitCore = require('../../src/core/unit');
    for (const unit of ctx.repository.all('units')) {
      expect(require('../../src/core/ids').isValidVin(unit.vin)).toBe(true);
      expect(Object.keys(unitCore.UNIT_STATES)).toContain(unit.status);
      // A completed vehicle must have cleared every defect against it.
      if (unit.status === 'COMPLETED') expect(unit.openDefectIds).toHaveLength(0);
    }
  });

  it('keeps every work order within its quantity, with counters that match its vehicles', () => {
    // Regression: in-process history and the live WIP were added without
    // bumping quantityStarted, and the WIP could overfill an order. The
    // simulator then picked an order the release refused - on every tick -
    // and the line stopped launching vehicles.
    for (const [shifts, now] of [[1, '2026-09-16T21:30:00Z'], [3, '2026-09-17T06:05:00Z']]) {
      const ctx = makeContext();
      seedPlant(ctx, { detailShifts: shifts, days: 2, now: new Date(now), seed: 20260916 });

      for (const order of ctx.repository.all('workOrders')) {
        const units = ctx.repository.all('units').filter((u) => u.workOrderId === order.id);
        expect(units.length).toBeLessThanOrEqual(order.quantity);
        expect(order.quantityStarted).toBe(units.filter((u) => u.startedAt).length);
        expect(order.quantityCompleted).toBe(units.filter((u) => u.status === 'COMPLETED').length);
      }
    }
  });

  it('seals the genealogy of every completed vehicle', () => {
    const ctx = makeContext();
    seedPlant(ctx, { detailShifts: 1, days: 1, now: new Date('2026-09-16T21:30:00Z') });

    const completed = ctx.repository.all('units').filter((u) => u.status === 'COMPLETED');
    expect(completed.length).toBeGreaterThan(0);

    for (const unit of completed.slice(0, 25)) {
      expect(ctx.repository.get('genealogies', unit.vin).sealedAt).toBeTruthy();
    }
  });

  it('never leaves a station reporting DOWN with no downtime record', () => {
    const ctx = makeContext();
    seedPlant(ctx, { detailShifts: 1, days: 1, now: new Date('2026-09-16T21:30:00Z') });

    const stopped = ctx.repository
      .all('stationStates')
      .filter((s) => s.state === 'DOWN' || s.state === 'MAINTENANCE');

    for (const state of stopped) {
      expect(state.openDowntimeId).toBeTruthy();
      expect(ctx.repository.get('downtimes', state.openDowntimeId)).toBeTruthy();
    }
  });

  it('builds a lot index that recall queries can use', () => {
    const ctx = makeContext();
    seedPlant(ctx, { detailShifts: 1, days: 1, now: new Date('2026-09-16T21:30:00Z') });

    const lots = ctx.repository.knownLots();
    expect(lots.length).toBeGreaterThan(20);

    const report = ctx.trace.recall({ lotCode: lots[0] });
    expect(report.affectedCount).toBeGreaterThan(0);
  });

  it('produces KPIs inside plausible bounds', () => {
    const ctx = makeContext();
    seedPlant(ctx, { detailShifts: 2, days: 2, now: new Date('2026-09-16T21:30:00Z') });

    const dashboard = ctx.kpi.dashboard({}, new Date('2026-09-16T21:30:00Z'));
    expect(dashboard.headline.oee).toBeGreaterThan(20);
    expect(dashboard.headline.oee).toBeLessThanOrEqual(100);
    expect(dashboard.headline.fpyPct).toBeGreaterThan(50);
    expect(dashboard.headline.fpyPct).toBeLessThanOrEqual(100);
    expect(dashboard.lines).toHaveLength(7);
  });
});
