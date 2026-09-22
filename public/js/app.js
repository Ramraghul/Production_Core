/* ==========================================================================
   Production Core - plant floor HMI
   --------------------------------------------------------------------------
   Vanilla JS, no build step, no framework. That is a deliberate choice for a
   page whose job is to stay up on a wall for eight hours: nothing to bundle,
   nothing to keep patched, and it loads on the oldest browser on the floor.

   Two data paths:
     - polling for snapshots (KPIs, station states) on a slow timer
     - Server-Sent Events for the live feed, so the event list is immediate
       without hammering the API
   ========================================================================== */

'use strict';

const API = '/api/v1';

/** Poll intervals, in milliseconds. Slow enough to be cheap on a free tier. */
const POLL = {
  dashboard: 5000,
  stations: 6000,
  wip: 8000,
  quality: 12000
};

const state = {
  activePanel: 'overview',
  selectedStation: null,
  selectedVin: null,
  eventCount: 0,
  timers: []
};

// ---- small helpers -------------------------------------------------------

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));

/** Escape text for safe insertion into innerHTML. */
function esc(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

async function getJson(path) {
  const response = await fetch(path, { headers: { accept: 'application/json' } });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body?.error?.message || `${response.status} ${response.statusText}`);
  }
  return response.json();
}

async function postJson(path, body) {
  const response = await fetch(path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      // The demo key is public by design: reads are open and writes are
      // limited to this sandboxed plant.
      'x-api-key': 'production-core-demo-key'
    },
    body: JSON.stringify(body)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload?.error?.message || `${response.status}`);
  return payload;
}

/** Colour band for a 0-100 percentage against the OEE benchmarks. */
function band(value) {
  if (value >= 85) return 'good';
  if (value >= 60) return 'warn';
  return 'bad';
}

function bandColour(value) {
  return value >= 85 ? 'var(--ok)' : value >= 60 ? 'var(--warn)' : 'var(--bad)';
}

const clockTime = (iso) => new Date(iso).toLocaleTimeString('en-CA', { hour12: false });

function relative(iso) {
  const seconds = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  return `${Math.round(seconds / 3600)}h`;
}

// ---- tabs ----------------------------------------------------------------

function initTabs() {
  $$('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      $$('.tab').forEach((t) => t.classList.remove('is-active'));
      $$('.panel').forEach((p) => p.classList.remove('is-active'));
      tab.classList.add('is-active');
      const panel = tab.dataset.panel;
      $(`#panel-${panel}`).classList.add('is-active');
      state.activePanel = panel;

      // Refresh the panel being opened rather than waiting for its next tick.
      if (panel === 'stations') loadStations();
      if (panel === 'vehicles') loadWip();
      if (panel === 'quality') loadQuality();
      if (panel === 'trace') loadLots();
    });
  });
}

// ---- overview ------------------------------------------------------------

async function loadDashboard() {
  let dashboard;
  try {
    dashboard = await getJson(`${API}/kpi/dashboard`);
  } catch (error) {
    setConnection('offline', 'api unreachable');
    return;
  }

  const h = dashboard.headline;

  // Early in a shift the API reports a rolling 8-hour window rather than a
  // near-zero shift total; say so, or the numbers look like a shift figure.
  $('#shift-name').textContent = dashboard.window.rolling
    ? `${dashboard.window.shiftName || dashboard.window.shift || '-'} (last 8h)`
    : (dashboard.window.shiftName || dashboard.window.shift || '-');
  $('#shift-name').title = dashboard.window.rollingReason || '';

  // If the simulator is compressing time, the throughput and performance
  // figures are inflated relative to the plant's real takt. Say so on the page
  // rather than letting a visitor read them as real.
  const compression = dashboard.timeCompression;
  const banner = $('#conn');
  if (compression && compression.active) {
    banner.dataset.state = 'connecting';
    $('#conn-text').textContent = `live · ${compression.speed}\u00d7 compressed`;
    banner.title = compression.note;
  } else {
    banner.title = '';
  }

  const tiles = [
    { k: 'Plant OEE', v: `${h.oee}%`, s: h.rating.replace(/_/g, ' ').toLowerCase(), cls: band(h.oee) },
    { k: 'Jobs / hour', v: h.jph, s: `target ${h.targetJph}`, cls: band(h.taktAdherencePct || 0) },
    { k: 'Built this shift', v: h.unitsCompleted, s: `${h.wip} in progress` },
    { k: 'First pass yield', v: h.fpyPct === null ? '-' : `${h.fpyPct}%`, s: `RTY ${h.rtyPct ?? '-'}%`, cls: h.fpyPct === null ? '' : band(h.fpyPct) },
    { k: 'Stations down', v: dashboard.stations.downNow, s: `${dashboard.stations.total} total`, cls: dashboard.stations.downNow > 3 ? 'bad' : dashboard.stations.downNow ? 'warn' : 'good' },
    { k: 'Andon open', v: dashboard.andon.open, s: dashboard.andon.escalated ? `${dashboard.andon.escalated} escalated` : 'none escalated', cls: dashboard.andon.escalated ? 'bad' : dashboard.andon.open ? 'warn' : 'good' },
    { k: 'Constraint', v: h.constraintLine || '-', s: 'slowest line' }
  ];

  $('#kpi-tiles').innerHTML = tiles.map((t) => `
    <div class="tile ${t.cls || ''}">
      <div class="k">${esc(t.k)}</div>
      <div class="v">${esc(t.v)}</div>
      <div class="s">${esc(t.s || '')}</div>
    </div>`).join('');

  // ---- line board --------------------------------------------------------
  $('#line-board').innerHTML = dashboard.lines.map((line) => `
    <div class="line-row">
      <div class="line-name">${esc(line.lineId)}<small>${esc(line.kind.toLowerCase())}</small></div>
      <div class="bar"><span style="width:${Math.max(2, line.oee)}%;background:${bandColour(line.oee)}"></span></div>
      <div class="line-stats">
        <b>${line.oee}%</b> &middot; ${line.jph} JPH<br>
        <span class="hint">wip ${line.wip}${line.constraintStation ? ` &middot; ${esc(line.constraintStation)}` : ''}</span>
      </div>
    </div>`).join('');

  // ---- andon board -------------------------------------------------------
  const calls = dashboard.andon.calls || [];
  const stops = dashboard.currentStops || [];

  $('#andon-board').innerHTML = (calls.length || stops.length)
    ? [
        ...calls.map((call) => `
          <div class="andon-row ${esc(call.colour)}">
            <span class="who">${esc(call.callType)}</span>
            <span class="hint">${esc(call.stationId)} &middot; ${esc(call.label)}</span>
            <span class="meta">${call.ageSeconds}s${call.ageSeconds > call.slaSeconds ? ' &middot; SLA missed' : ''}</span>
          </div>`),
        ...stops.map((stop) => `
          <div class="andon-row red">
            <span class="who">STOPPED</span>
            <span class="hint">${esc(stop.stationId)} &middot; ${esc(stop.reasonLabel)}</span>
            <span class="meta">${Math.round(stop.elapsedSeconds / 60)}m</span>
          </div>`)
      ].join('')
    : '<div class="empty">No open calls. The line is running.</div>';

  // ---- buffers -----------------------------------------------------------
  $('#buffers').innerHTML = (dashboard.buffers || []).map((buffer) => `
    <div class="buffer ${buffer.starvationRisk ? 'risk' : ''}" title="${esc(buffer.description)} - installed at ${esc(buffer.installsAt || '-')}">
      <div class="c">${esc(buffer.classCode)}</div>
      <div class="n">${buffer.available}</div>
    </div>`).join('');

  setConnection('live', 'live');
}

async function loadTrend() {
  let trend;
  try {
    trend = await getJson(`${API}/kpi/trend?shifts=8`);
  } catch (_error) { return; }

  const items = trend.items || [];
  const max = Math.max(100, ...items.map((i) => i.oee || 0));

  $('#trend').innerHTML = items.map((item) => {
    const height = Math.max(3, ((item.oee || 0) / max) * 100);
    return `
      <div class="trend-bar" title="${esc(item.key)} - OEE ${item.oee}%, ${item.unitsCompleted} units${item.source === 'aggregate' ? ' (rolled up)' : ''}">
        <div class="val">${item.oee || 0}%</div>
        <div class="col ${item.source === 'aggregate' ? 'aggregate' : ''}"
             style="height:${height}%;background:${bandColour(item.oee || 0)}"></div>
        <div class="lbl">${esc((item.key || '').slice(5))}</div>
      </div>`;
  }).join('');
}

// ---- stations ------------------------------------------------------------
//
// Station grid, maintenance boards and the control drawer live in
// js/stations.js: loadStations() and openStation() are defined there.

// ---- vehicles ------------------------------------------------------------

async function loadWip() {
  if (state.activePanel !== 'vehicles') return;
  let wip;
  try {
    wip = await getJson(`${API}/units/wip`);
  } catch (_error) { return; }

  const items = wip.items || [];
  $('#wip-list').innerHTML = items.length
    ? items.map((unit) => `
        <button class="wip" data-vin="${esc(unit.vin)}" type="button">
          <div class="vin">${esc(unit.vin)}</div>
          <div class="meta">${esc(unit.modelName)} &middot; ${esc(unit.colour)}</div>
          <div class="prog"><span style="width:${unit.progressPct}%"></span></div>
          <div class="foot">
            <span>${esc(unit.currentStation || '-')}</span>
            <span>
              ${unit.status !== 'IN_PROCESS' ? `<span class="badge ${unit.status === 'HOLD' ? 'hold' : 'rework'}">${esc(unit.status)}</span> ` : ''}
              ${unit.openDefects ? `<span class="badge bad">${unit.openDefects} defect${unit.openDefects > 1 ? 's' : ''}</span> ` : ''}
              ${unit.progressPct}%
            </span>
          </div>
        </button>`).join('')
    : '<div class="empty">No vehicles on the floor.</div>';

  $$('#wip-list .wip').forEach((element) => {
    element.addEventListener('click', () => showVehicle(element.dataset.vin));
  });
}

async function showVehicle(vin) {
  state.selectedVin = vin;
  const card = $('#vehicle-detail-card');
  card.hidden = false;
  $('#vehicle-title').textContent = vin;
  $('#vehicle-detail').innerHTML = '<div class="empty">Loading&hellip;</div>';

  try {
    const history = await getJson(`${API}/units/${encodeURIComponent(vin)}/history`);
    const visits = (history.visits || []).slice(-10).reverse();

    $('#vehicle-detail').innerHTML = `
      <table class="kv">
        <tr><td>Status</td><td><span class="badge ${history.status === 'IN_PROCESS' ? 'ok' : 'hold'}">${esc(history.status)}</span>
          ${history.currentStation ? ` at ${esc(history.currentStation)}` : ''}</td></tr>
        <tr><td>Route progress</td><td>${history.progressPct}% &middot; ${history.visits.length} stations visited</td></tr>
        <tr><td>First pass</td><td>${history.firstPass ? '<span class="badge ok">yes</span>' : '<span class="badge bad">no &mdash; reworked</span>'}</td></tr>
        <tr><td>Cycle time so far</td><td>${Math.round(history.totalCycleSeconds / 60)} min</td></tr>
        ${history.defects.length ? `<tr><td>Defects</td><td>${history.defects.map((d) => `<span class="badge ${d.status === 'CLOSED' ? '' : 'bad'}">${esc(d.code)}</span>`).join(' ')}</td></tr>` : ''}
      </table>

      <div class="route" title="Route through the plant">
        ${history.route.map((step) => `<i class="${esc(step.state)}" title="${esc(step.stationId)} - ${esc(step.stationName)} (${esc(step.state)})"></i>`).join('')}
      </div>
      <div class="hint">Green = done &middot; blue = current &middot; grey = remaining</div>

      <h3 class="sub-head">Recent station visits</h3>
      <div class="scroller">
        <table class="data">
          <thead><tr><th>Station</th><th>Entered</th><th>Cycle</th><th>vs ideal</th><th>Result</th><th>Operator</th></tr></thead>
          <tbody>
            ${visits.map((v) => `
              <tr>
                <td class="mono">${esc(v.stationId)}</td>
                <td>${clockTime(v.enteredAt)}</td>
                <td>${v.cycleSeconds}s</td>
                <td style="color:${v.cycleVarianceSeconds > 5 ? 'var(--warn)' : 'var(--text-dim)'}">
                  ${v.cycleVarianceSeconds > 0 ? '+' : ''}${v.cycleVarianceSeconds}s</td>
                <td>${v.result === 'PASS' ? '<span class="badge ok">pass</span>' : `<span class="badge bad">${esc(v.result)}</span>`}</td>
                <td class="mono">${esc(v.operator)}</td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>
      <p class="hint" style="margin-top:10px">
        Open this VIN on the <b>Traceability</b> tab to see its as-built genealogy.
      </p>`;
  } catch (error) {
    $('#vehicle-detail').innerHTML = `<div class="empty">${esc(error.message)}</div>`;
  }
}

// ---- quality -------------------------------------------------------------

async function loadQuality() {
  if (state.activePanel !== 'quality') return;
  let summary; let defects;
  try {
    [summary, defects] = await Promise.all([
      getJson(`${API}/quality/summary`),
      getJson(`${API}/quality/defects?open=true&limit=40`)
    ]);
  } catch (_error) { return; }

  const fpy = summary.firstPassYield.fpyPct;
  $('#quality-tiles').innerHTML = [
    { k: 'First pass yield', v: fpy === null ? '-' : `${fpy}%`, s: `${summary.unitsCompleted} completed`, cls: fpy === null ? '' : band(fpy) },
    { k: 'Defects raised', v: summary.defectCount, s: `${summary.openDefects} still open` },
    { k: 'Critical', v: summary.bySeverity.CRITICAL, s: `${summary.bySeverity.MAJOR} major, ${summary.bySeverity.MINOR} minor`, cls: summary.bySeverity.CRITICAL ? 'bad' : 'good' },
    { k: 'DPMO', v: summary.dpmo ?? '-', s: `${summary.sigmaLevel} sigma`, cls: summary.sigmaLevel >= 4 ? 'good' : summary.sigmaLevel >= 3 ? 'warn' : 'bad' }
  ].map((t) => `
    <div class="tile ${t.cls || ''}">
      <div class="k">${esc(t.k)}</div><div class="v">${esc(t.v)}</div><div class="s">${esc(t.s)}</div>
    </div>`).join('');

  const pareto = summary.paretoByCode || [];
  const top = pareto.length ? pareto[0].count : 1;
  $('#pareto').innerHTML = pareto.length
    ? pareto.map((row) => `
        <div class="pareto-row">
          <div class="lbl" title="${esc(row.description)}">${esc(row.key)}</div>
          <div class="bar"><span style="width:${(row.count / top) * 100}%;background:var(--warn)"></span></div>
          <div class="n">${row.count} &middot; ${row.cumulativePct}%</div>
        </div>`).join('')
    : '<div class="empty">No defects this shift.</div>';

  const items = defects.items || [];
  $('#defect-list').innerHTML = items.length
    ? items.map((d) => `
        <div class="defect ${esc(d.severity)}">
          <span class="code">${esc(d.code)}</span>
          <span class="hint">${esc(d.stationId)}${d.vin ? ` &middot; ${esc(d.vin.slice(-6))}` : ''}</span>
          <span class="meta">${esc(d.severity)} &middot; ${esc(d.status)}${d.disposition ? ` &middot; ${esc(d.disposition)}` : ''}</span>
        </div>`).join('')
    : '<div class="empty">No open defects.</div>';
}

// ---- traceability --------------------------------------------------------

async function loadLots() {
  const select = $('#lot-select');
  if (select.dataset.loaded === 'true') return;

  try {
    const lots = await getJson(`${API}/trace/lots?limit=60`);
    const items = (lots.items || []).filter((lot) => lot.vinCount > 0);
    if (!items.length) {
      select.innerHTML = '<option>no lots recorded yet</option>';
      return;
    }
    select.innerHTML = items.map((lot) =>
      `<option value="${esc(lot.lotCode)}">${esc(lot.lotCode)} - ${lot.vinCount} vehicles</option>`).join('');
    select.dataset.loaded = 'true';
  } catch (error) {
    select.innerHTML = `<option>${esc(error.message)}</option>`;
  }
}

async function runRecall() {
  const lotCode = $('#lot-select').value;
  if (!lotCode) return;

  const button = $('#run-recall');
  button.disabled = true;
  button.textContent = 'Running…';
  $('#recall-result').innerHTML = '<div class="empty">Querying the build history&hellip;</div>';

  try {
    const started = performance.now();
    const report = await postJson(`${API}/trace/recall`, {
      lotCode,
      reason: 'Recall drill from the plant HMI'
    });
    const elapsed = Math.max(1, Math.round(performance.now() - started));

    const c = report.byContainment;
    $('#recall-result').innerHTML = `
      <div class="verdict ${esc(report.recommendation.action)}">
        <span class="action">${esc(report.recommendation.action.replace(/_/g, ' '))}</span>
        ${esc(report.recommendation.rationale)}
      </div>
      <div class="containment">
        ${['IN_PLANT', 'FINISHED_GOODS', 'SHIPPED', 'SCRAPPED'].map((zone) => `
          <div class="cz ${esc(zone)}">
            <div class="n">${c[zone] || 0}</div>
            <div class="k">${esc(zone.replace(/_/g, ' '))}</div>
          </div>`).join('')}
      </div>
      <table class="kv">
        <tr><td>Lot</td><td class="mono">${esc(report.query.lotCode)}</td></tr>
        <tr><td>Supplier</td><td>${esc(report.supplier || 'unknown')}
          ${report.safetyCritical ? ' <span class="badge bad">safety critical</span>' : ''}</td></tr>
        <tr><td>Vehicles affected</td><td><b>${report.affectedCount}</b></td></tr>
        <tr><td>Still containable</td><td><b style="color:var(--ok)">${report.containableNow}</b>
          &mdash; can be held before they leave the plant</td></tr>
        <tr><td>Estimated containment cost</td><td>CAD ${report.estimatedRecallCostCad.toLocaleString('en-CA')}</td></tr>
        <tr><td>Query time</td><td>${elapsed} ms across ${report.affectedCount} genealogy records</td></tr>
      </table>
      ${report.affected.length ? `
        <h3 class="sub-head">Affected vehicles (first 12)</h3>
        <div class="scroller">
          <table class="data">
            <thead><tr><th>VIN</th><th>Model</th><th>Status</th><th>Where</th><th>Fitted at</th></tr></thead>
            <tbody>
              ${report.affected.slice(0, 12).map((a) => `
                <tr>
                  <td class="mono">${esc(a.vin)}</td>
                  <td>${esc(a.modelName || a.modelCode)}</td>
                  <td>${esc(a.status)}</td>
                  <td>${esc(a.containment.replace(/_/g, ' '))}</td>
                  <td class="mono">${esc(a.matches[0]?.installedAt || '-')}</td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>` : ''}`;
  } catch (error) {
    $('#recall-result').innerHTML = `<div class="empty">${esc(error.message)}</div>`;
  } finally {
    button.disabled = false;
    button.textContent = 'Run recall query';
  }
}

async function lookupVin() {
  const vin = $('#vin-input').value.trim().toUpperCase();
  if (!vin) return;

  $('#genealogy-result').innerHTML = '<div class="empty">Loading&hellip;</div>';
  try {
    const report = await getJson(`${API}/units/${encodeURIComponent(vin)}/genealogy`);
    const rows = report.flattened || [];

    $('#genealogy-result').innerHTML = `
      <table class="kv">
        <tr><td>Vehicle</td><td class="mono">${esc(report.vin)}</td></tr>
        <tr><td>Components</td><td>${report.stats.totalNodes}
          (${report.stats.parts} parts, ${report.stats.subAssemblies} sub-assemblies)</td></tr>
        <tr><td>Safety critical</td><td>${report.stats.safetyCriticalParts} parts</td></tr>
        <tr><td>Supplier lots</td><td>${report.stats.distinctLots}</td></tr>
        <tr><td>Material cost</td><td>CAD ${report.estimatedMaterialCostCad.toLocaleString('en-CA')}</td></tr>
        <tr><td>Record</td><td>${report.sealedAt
          ? `<span class="badge ok">sealed</span> ${clockTime(report.sealedAt)} &mdash; immutable`
          : '<span class="badge">open</span> &mdash; still being built'}</td></tr>
      </table>
      <h3 class="sub-head">As-built tree</h3>
      <div class="tree">
        ${rows.map((row) => `
          <div class="lvl${row.level}">
            ${row.type === 'SUBASSEMBLY'
              ? `<span class="sub">&#9660; ${esc(row.id)}</span> <span class="lot">${esc(row.description || '')}</span>`
              : `&bull; ${esc(row.id)} <span class="lot">${esc(row.lotCode || 'no lot')}</span>` +
                `${row.safetyCritical ? ' <span class="crit">[safety]</span>' : ''}` +
                ` <span class="lot">@${esc(row.installedAt)}</span>`}
          </div>`).join('')}
      </div>`;
  } catch (error) {
    $('#genealogy-result').innerHTML = `<div class="empty">${esc(error.message)}</div>`;
  }
}

// ---- live event stream ---------------------------------------------------

function setConnection(stateName, text) {
  const element = $('#conn');
  element.dataset.state = stateName;
  $('#conn-text').textContent = text;
}

function initStream() {
  if (typeof EventSource === 'undefined') {
    setConnection('offline', 'no SSE support');
    return;
  }

  const stream = new EventSource(`${API}/events/stream`);
  const feed = $('#feed');

  stream.addEventListener('open', () => setConnection('live', 'live'));
  stream.addEventListener('error', () => setConnection('connecting', 'reconnecting'));

  // One handler for everything, filtered client-side. Subscribing to the
  // firehose and filtering here keeps the server from tracking per-client
  // interest, which for a handful of viewers is the cheaper trade.
  const handler = (event) => {
    let envelope;
    try {
      envelope = JSON.parse(event.data);
    } catch (_error) { return; }

    // Telemetry and cycle events are far too frequent for a human-readable
    // feed; they would push everything interesting off the screen in seconds.
    if (envelope.type === 'station.telemetry' || envelope.type === 'station.cycle') return;

    state.eventCount += 1;
    $('#event-count').textContent = `${state.eventCount} events`;

    const item = document.createElement('li');
    item.innerHTML =
      `<span class="t">${clockTime(envelope.timestamp)}</span>` +
      `<span class="sev ${esc(envelope.severity)}"></span>` +
      `<span class="msg"><span class="ty">${esc(envelope.type)}</span> ` +
      `<span class="de">${esc(describe(envelope))}</span></span>`;

    feed.prepend(item);
    while (feed.children.length > 60) feed.lastChild.remove();
  };

  [
    'unit.created', 'unit.moved', 'unit.completed', 'unit.held', 'unit.scrapped', 'unit.rework',
    'quality.defect.raised', 'quality.gate.blocked', 'quality.inspection',
    'andon.raised', 'andon.acknowledged', 'andon.escalated', 'andon.resolved',
    'downtime.started', 'downtime.ended', 'station.state',
    'subassembly.built', 'subassembly.consumed', 'subassembly.quarantined',
    'workorder.created', 'workorder.released', 'workorder.completed', 'system.recall',
    'station.started', 'station.stopped', 'maintenance.started', 'maintenance.completed'
  ].forEach((type) => stream.addEventListener(type, handler));

  window.addEventListener('beforeunload', () => stream.close());
}

/** A short human-readable description of an event. */
function describe(envelope) {
  const p = envelope.payload || {};
  switch (envelope.type) {
    case 'unit.moved': return `${p.vin} -> ${p.stationId} (${p.progressPct}%)`;
    case 'unit.completed': return `${p.vin} released after ${p.buildMinutes} min${p.firstPass ? ', first pass' : ''}`;
    case 'unit.created': return `${p.vin} ${p.modelName || ''}`;
    case 'unit.held': return `${p.vin} held at ${p.stationId}`;
    case 'unit.scrapped': return `${p.vin} scrapped: ${p.reason}`;
    case 'quality.defect.raised': return `${p.code} (${p.severity}) at ${p.stationId}`;
    case 'quality.gate.blocked': return `${p.vin} blocked at ${p.stationId}`;
    case 'andon.raised': return `${p.callType} at ${p.stationId}${p.stopsLine ? ' - line stop' : ''}`;
    case 'andon.acknowledged': return `${p.id} answered in ${p.responseSeconds}s${p.slaMet ? '' : ' (SLA missed)'}`;
    case 'andon.escalated': return `${p.id} -> ${p.escalatedTo}`;
    case 'andon.resolved': return `${p.id} resolved in ${Math.round((p.resolutionSeconds || 0) / 60)}m`;
    case 'downtime.started': return `${p.stationId}: ${p.reasonLabel}`;
    case 'downtime.ended': return `${p.stationId} back up after ${Math.round((p.durationSeconds || 0) / 60)}m`;
    case 'station.state': return `${p.stationId} ${p.previousState} -> ${p.state}`;
    case 'subassembly.built': return `${p.serial} (${p.classCode})`;
    case 'subassembly.consumed': return `${p.serial} fitted to ${p.vin}`;
    case 'subassembly.quarantined': return `${p.serial} quarantined`;
    case 'workorder.released': return `${p.id} released, ${p.unitsCreated} units`;
    case 'workorder.completed': return `${p.id} fulfilled`;
    case 'system.recall': return `recall query: ${p.affectedCount} vehicles affected`;
    case 'station.stopped': return `${p.stationId} stopped by ${p.by} (${p.reasonCode})`;
    case 'station.started': return `${p.stationId} started by ${p.by}`;
    case 'maintenance.started': return `${p.id} ${p.type} on ${p.stationId} (${p.technician}, ${p.plannedMinutes} min planned)`;
    case 'maintenance.completed': return `${p.id} on ${p.stationId} done in ${p.actualMinutes} min${p.overrunMinutes > 0 ? `, ${p.overrunMinutes} over` : ''}`;
    default: return p.vin || p.stationId || p.id || '';
  }
}

// ---- boot ----------------------------------------------------------------

function poll(fn, intervalMs) {
  fn();
  const timer = setInterval(fn, intervalMs);
  state.timers.push(timer);
}

async function showVersion() {
  try {
    const health = await getJson(`${API}/health`);
    $('#about-version').textContent =
      `v${health.version} · ${health.environment} · ` +
      `${health.store.collections.units} vehicles, ` +
      `${health.store.indexes.lots} supplier lots in memory · ` +
      `uptime ${Math.round(health.uptimeSeconds / 60)} min`;
  } catch (_error) { /* the badge is cosmetic */ }
}

function init() {
  initTabs();
  initStream();

  $('#run-recall').addEventListener('click', runRecall);
  $('#lookup-vin').addEventListener('click', lookupVin);
  $('#vin-input').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') lookupVin();
  });

  poll(loadDashboard, POLL.dashboard);
  poll(loadTrend, 60000);
  poll(loadStations, POLL.stations);
  poll(loadWip, POLL.wip);
  poll(loadQuality, POLL.quality);

  showVersion();

  // Pause polling while the tab is hidden; a wall display left open overnight
  // should not keep a free-tier instance awake doing nothing.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      loadDashboard();
      if (state.activePanel === 'stations') loadStations();
    }
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
