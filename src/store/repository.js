'use strict';

/**
 * In-memory repository with an optional JSON snapshot on disk.
 *
 * Why not SQLite or Postgres? Three reasons, in order of weight:
 *
 *  1. The free hosting tiers this project targets give you an ephemeral disk
 *     and no managed database. A native module that fails to build on a cold
 *     start takes the whole demo down.
 *  2. A plant's hot data set - one shift of vehicles, events and telemetry -
 *     is small enough to hold in RAM, and this is exactly how a real MES edge
 *     tier caches state before it flushes to a historian.
 *  3. Everything below goes through a narrow, documented interface, so swapping
 *     in Postgres or TimescaleDB is one adapter, not a rewrite. See
 *     docs/ARCHITECTURE.md for the adapter contract.
 *
 * Time-series collections (events, telemetry) are ring buffers with a hard cap
 * so memory stays flat on a 512 MB instance no matter how long it runs.
 */

const fs = require('fs');
const path = require('path');
const config = require('../config');
const { createLogger } = require('../logger');

const log = createLogger('store');

/** Collections that behave as capped ring buffers rather than keyed maps. */
const SERIES_COLLECTIONS = Object.freeze({
  events: config.store.maxEvents,
  telemetry: config.store.maxTelemetry
});

/** Keyed collections and the field that identifies a document. */
const KEYED_COLLECTIONS = Object.freeze({
  workOrders: 'id',
  units: 'vin',
  subAssemblies: 'serial',
  genealogies: 'vin',
  defects: 'id',
  inspections: 'id',
  andons: 'id',
  downtimes: 'id',
  stationStates: 'stationId',
  counters: 'id',
  shiftMetrics: 'key',
  maintenanceOrders: 'id'
});

class Repository {
  constructor(options = {}) {
    this.driver = options.driver || config.store.driver;
    this.dataDir = options.dataDir || config.store.dataDir;
    this.snapshotPath = path.join(this.dataDir, 'production-core.snapshot.json');

    /** @type {Map<string, Map<string, object>>} */
    this.keyed = new Map();
    /** @type {Map<string, Array<object>>} */
    this.series = new Map();
    /** Secondary indexes, rebuilt on load. */
    this.indexes = { lotToVins: new Map(), serialToVin: new Map() };

    this.dirty = false;
    this.snapshotTimer = null;
    this.stats = { writes: 0, reads: 0, snapshots: 0 };

    this.reset();
  }

  /** Clear every collection. Used by tests and by the reseed endpoint. */
  reset() {
    this.keyed = new Map(Object.keys(KEYED_COLLECTIONS).map((name) => [name, new Map()]));
    this.series = new Map(Object.keys(SERIES_COLLECTIONS).map((name) => [name, []]));
    this.indexes = { lotToVins: new Map(), serialToVin: new Map() };
    this.dirty = true;
  }

  // ---- keyed collections -------------------------------------------------

  /**
   * Insert or replace a document.
   * @param {string} collection
   * @param {object} document must carry the collection's key field
   */
  put(collection, document) {
    const map = this.#keyedMap(collection);
    const keyField = KEYED_COLLECTIONS[collection];
    const key = document?.[keyField];
    if (key === undefined || key === null) {
      throw new Error(`Document for '${collection}' is missing key field '${keyField}'`);
    }
    map.set(String(key), document);
    this.stats.writes += 1;
    this.dirty = true;
    return document;
  }

  /** Insert or replace many documents in one pass. */
  putMany(collection, documents) {
    documents.forEach((document) => this.put(collection, document));
    return documents.length;
  }

  /** @returns {object|null} */
  get(collection, key) {
    this.stats.reads += 1;
    return this.#keyedMap(collection).get(String(key)) || null;
  }

  has(collection, key) {
    return this.#keyedMap(collection).has(String(key));
  }

  delete(collection, key) {
    this.dirty = true;
    return this.#keyedMap(collection).delete(String(key));
  }

  /**
   * Query a keyed collection.
   *
   * @param {string} collection
   * @param {object} [options]
   * @param {function(object):boolean} [options.where]
   * @param {string} [options.sort]  field name
   * @param {'asc'|'desc'} [options.order]
   * @param {number} [options.limit]
   * @param {number} [options.offset]
   * @returns {{items: object[], total: number, limit: number, offset: number}}
   */
  find(collection, options = {}) {
    this.stats.reads += 1;
    let items = [...this.#keyedMap(collection).values()];

    if (typeof options.where === 'function') items = items.filter(options.where);

    const total = items.length;

    if (options.sort) {
      const direction = options.order === 'asc' ? 1 : -1;
      items.sort((a, b) => {
        const left = a?.[options.sort];
        const right = b?.[options.sort];
        if (left === right) return 0;
        if (left === undefined || left === null) return 1;
        if (right === undefined || right === null) return -1;
        return left > right ? direction : -direction;
      });
    }

    const offset = Math.max(0, options.offset || 0);
    const limit = options.limit ?? total;
    return { items: items.slice(offset, offset + limit), total, limit, offset };
  }

  /** Count matching documents without materialising them. */
  count(collection, where) {
    const map = this.#keyedMap(collection);
    if (!where) return map.size;
    let total = 0;
    for (const document of map.values()) if (where(document)) total += 1;
    return total;
  }

  /** All documents in a keyed collection. */
  all(collection) {
    return [...this.#keyedMap(collection).values()];
  }

  // ---- series collections ------------------------------------------------

  /**
   * Append to a capped series. Oldest entries are dropped once the cap is hit.
   * @returns {object} the appended record
   */
  append(collection, record) {
    const list = this.#seriesList(collection);
    list.push(record);
    const cap = SERIES_COLLECTIONS[collection];
    if (list.length > cap) list.splice(0, list.length - cap);
    this.stats.writes += 1;
    this.dirty = true;
    return record;
  }

  /**
   * Read back a series, newest first.
   * @param {object} [options] {where, limit, since}
   */
  series_(collection, options = {}) {
    this.stats.reads += 1;
    let items = this.#seriesList(collection);

    if (options.since) {
      const cutoff = Date.parse(options.since);
      items = items.filter((r) => Date.parse(r.timestamp || r.at || 0) >= cutoff);
    }
    if (typeof options.where === 'function') items = items.filter(options.where);

    const total = items.length;
    const limit = options.limit ?? 100;
    // Newest first is what every operator screen wants.
    return { items: items.slice(-limit).reverse(), total };
  }

  /** Raw series array, oldest first. Used by the KPI aggregator. */
  seriesRaw(collection) {
    return this.#seriesList(collection);
  }

  // ---- counters ----------------------------------------------------------

  /**
   * Atomically increment a named counter and return the new value.
   * Backs VIN sequences, work-order numbers and andon ids.
   */
  nextSequence(name, start = 1) {
    const existing = this.get('counters', name);
    const value = existing ? existing.value + 1 : start;
    this.put('counters', { id: name, value, updatedAt: new Date().toISOString() });
    return value;
  }

  /** Read a counter without advancing it. */
  peekSequence(name) {
    return this.get('counters', name)?.value ?? 0;
  }

  // ---- secondary indexes -------------------------------------------------

  /** Index a supplier lot against a VIN so recall lookups are O(1). */
  indexLot(lotCode, vin) {
    if (!lotCode) return;
    if (!this.indexes.lotToVins.has(lotCode)) this.indexes.lotToVins.set(lotCode, new Set());
    this.indexes.lotToVins.get(lotCode).add(vin);
    this.dirty = true;
  }

  /** VINs containing a supplier lot. */
  vinsForLot(lotCode) {
    return [...(this.indexes.lotToVins.get(lotCode) || [])];
  }

  /** Every lot code the plant has consumed. */
  knownLots() {
    return [...this.indexes.lotToVins.keys()];
  }

  indexSerial(serial, vin) {
    if (!serial) return;
    this.indexes.serialToVin.set(serial, vin);
    this.dirty = true;
  }

  vinForSerial(serial) {
    return this.indexes.serialToVin.get(serial) || null;
  }

  /** Rebuild both indexes from genealogy documents (after a snapshot load). */
  rebuildIndexes() {
    this.indexes = { lotToVins: new Map(), serialToVin: new Map() };
    for (const genealogy of this.all('genealogies')) {
      (genealogy.lotIndex || []).forEach((lot) => this.indexLot(lot, genealogy.vin));
      (genealogy.serialIndex || []).forEach((serial) => this.indexSerial(serial, genealogy.vin));
    }
  }

  // ---- persistence -------------------------------------------------------

  /** Serialisable view of every collection. */
  toSnapshot() {
    return {
      version: 1,
      savedAt: new Date().toISOString(),
      keyed: Object.fromEntries(
        [...this.keyed.entries()].map(([name, map]) => [name, [...map.values()]])
      ),
      series: Object.fromEntries([...this.series.entries()])
    };
  }

  /** Replace all state from a snapshot object. */
  fromSnapshot(snapshot) {
    if (!snapshot || snapshot.version !== 1) {
      throw new Error(`Unsupported snapshot version: ${snapshot?.version}`);
    }
    this.reset();
    for (const [name, documents] of Object.entries(snapshot.keyed || {})) {
      if (!KEYED_COLLECTIONS[name]) continue;
      documents.forEach((document) => this.put(name, document));
    }
    for (const [name, records] of Object.entries(snapshot.series || {})) {
      if (!SERIES_COLLECTIONS[name]) continue;
      this.series.set(name, records.slice(-SERIES_COLLECTIONS[name]));
    }
    this.rebuildIndexes();
    this.dirty = false;
  }

  /** Write a snapshot to disk. No-op unless the file driver is selected. */
  saveSnapshot() {
    if (this.driver !== 'file') return false;
    try {
      fs.mkdirSync(this.dataDir, { recursive: true });
      // Write to a temp file then rename, so a crash mid-write cannot leave a
      // truncated snapshot that fails to parse on the next boot.
      const temporary = `${this.snapshotPath}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify(this.toSnapshot()), 'utf8');
      fs.renameSync(temporary, this.snapshotPath);
      this.dirty = false;
      this.stats.snapshots += 1;
      log.debug('snapshot written', { path: this.snapshotPath });
      return true;
    } catch (error) {
      log.error('snapshot write failed', { error: error.message });
      return false;
    }
  }

  /** Load a snapshot from disk if one exists and parses. */
  loadSnapshot() {
    if (this.driver !== 'file') return false;
    try {
      if (!fs.existsSync(this.snapshotPath)) return false;
      const raw = fs.readFileSync(this.snapshotPath, 'utf8');
      this.fromSnapshot(JSON.parse(raw));
      log.info('snapshot restored', {
        path: this.snapshotPath,
        units: this.count('units'),
        workOrders: this.count('workOrders')
      });
      return true;
    } catch (error) {
      // A corrupt snapshot must never block a boot - the seeder will refill.
      log.warn('snapshot load failed, starting empty', { error: error.message });
      this.reset();
      return false;
    }
  }

  /** Start periodic background snapshots. */
  startAutoSnapshot(intervalMs = config.store.snapshotIntervalMs) {
    if (this.driver !== 'file' || this.snapshotTimer) return;
    this.snapshotTimer = setInterval(() => {
      if (this.dirty) this.saveSnapshot();
    }, intervalMs);
    // Do not hold the process open just for snapshots.
    this.snapshotTimer.unref?.();
    log.info('auto-snapshot enabled', { intervalMs, path: this.snapshotPath });
  }

  stopAutoSnapshot() {
    if (this.snapshotTimer) {
      clearInterval(this.snapshotTimer);
      this.snapshotTimer = null;
    }
  }

  /** Collection sizes plus IO counters, for GET /api/v1/health. */
  diagnostics() {
    return {
      driver: this.driver,
      collections: {
        ...Object.fromEntries([...this.keyed.entries()].map(([name, map]) => [name, map.size])),
        ...Object.fromEntries([...this.series.entries()].map(([name, list]) => [name, list.length]))
      },
      indexes: {
        lots: this.indexes.lotToVins.size,
        serials: this.indexes.serialToVin.size
      },
      stats: { ...this.stats },
      dirty: this.dirty
    };
  }

  #keyedMap(collection) {
    const map = this.keyed.get(collection);
    if (!map) {
      throw new Error(
        `Unknown keyed collection '${collection}'. Known: ${Object.keys(KEYED_COLLECTIONS).join(', ')}`
      );
    }
    return map;
  }

  #seriesList(collection) {
    const list = this.series.get(collection);
    if (!list) {
      throw new Error(
        `Unknown series collection '${collection}'. Known: ${Object.keys(SERIES_COLLECTIONS).join(', ')}`
      );
    }
    return list;
  }
}

module.exports = { Repository, KEYED_COLLECTIONS, SERIES_COLLECTIONS };
