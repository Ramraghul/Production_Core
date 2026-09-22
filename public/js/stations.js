/* ==========================================================================
   Production Core - stations, maintenance and the control drawer
   --------------------------------------------------------------------------
   The control panel never decides for itself which buttons are legal. Every
   station response carries `allowedActions` and `blockedActions` from the
   domain layer, and the drawer renders from those - so the buttons and the API
   cannot disagree, and a disabled button always says why it is disabled.

   Shares helpers ($, esc, getJson, relative, bandColour, API) with app.js,
   which is loaded after this file; they are only called at runtime.
   ========================================================================== */

'use strict';

const CONTROL = {
  open: null,          // station id shown in the drawer
  view: null,          // last control view for it
  form: null,          // 'stop' | 'maintenance' | null
  reasons: null,       // downtime reason codes, cached
  types: null,         // maintenance types, cached
  timer: null,
  // Set as soon as the operator touches a form or the checklist. A background
  // refresh must never redraw over half-entered input - a technician who has
  // ticked four checklist items should not see them untick themselves.
  dirty: false,
  // Monotonic request token. Only the newest refresh may render, so a poll
  // that set off before a button press cannot land after it and repaint the
  // old state.
  seq: 0
};

const OPERATOR_KEY = 'pc.operator';

function operatorName() {
  try {
    return localStorage.getItem(OPERATOR_KEY) || 'hmi-operator';
  } catch (_error) {
    return 'hmi-operator';
  }
}

function saveOperator(name) {
  try { localStorage.setItem(OPERATOR_KEY, name); } catch (_error) { /* private mode */ }
}

// ---- API -----------------------------------------------------------------

/** POST that returns the parsed body and a domain error code on failure. */
async function control(path, body) {
  const response = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      // Public demo key - reads are open and writes only touch this plant.
      'x-api-key': 'production-core-demo-key'
    },
    body: JSON.stringify(body || {})
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload?.error?.message || `${response.status}`);
    error.code = payload?.error?.code;
    throw error;
  }
  return payload;
}

async function referenceData() {
  if (!CONTROL.reasons) {
    const [reasons, types] = await Promise.all([
      getJson(`${API}/reference/downtime-reasons`),
      getJson(`${API}/reference/maintenance-types`)
    ]);
    CONTROL.reasons = reasons.items;
    CONTROL.types = types.items;
  }
}

// ---- toasts --------------------------------------------------------------

function toast(message, kind = 'ok', detail = '') {
  const host = $('#toasts');
  if (!host) return;
  const item = document.createElement('div');
  item.className = `toast ${kind}`;
  item.innerHTML = `<b>${esc(message)}</b>${detail ? `<span>${esc(detail)}</span>` : ''}`;
  host.appendChild(item);
  requestAnimationFrame(() => item.classList.add('in'));
  setTimeout(() => {
    item.classList.remove('in');
    setTimeout(() => item.remove(), 300);
  }, kind === 'err' ? 6500 : 3800);
}

// ---- grid and boards -----------------------------------------------------

const PM_LABEL = { OK: 'ok', DUE_SOON: 'due soon', DUE: 'due', OVERDUE: 'overdue' };

async function loadStations() {
  if (state.activePanel !== 'stations' && !CONTROL.open) return;

  let stations; let due; let active;
  try {
    [stations, due, active] = await Promise.all([
      getJson(`${API}/stations`),
      getJson(`${API}/maintenance/due?dueOnly=true`),
      getJson(`${API}/maintenance?status=IN_PROGRESS&limit=50`)
    ]);
  } catch (_error) {
    return;
  }

  if (state.activePanel === 'stations') {
    renderGrid(stations.items);
    renderActiveMaintenance(active.items);
    renderPmDue(due.items);
  }

  if (CONTROL.open) refreshDrawer();
}

function renderGrid(items) {
  $('#station-grid').innerHTML = items.map((s) => {
    const locked = s.controlMode && s.controlMode !== 'AUTO';
    const pm = s.pmStatus && s.pmStatus !== 'OK'
      ? `<span class="pm-chip ${esc(s.pmStatus)}" title="Preventive maintenance ${esc(PM_LABEL[s.pmStatus])}">PM</span>`
      : '';
    return `
      <button class="station s-${esc(s.state)}${locked ? ' is-locked' : ''}${CONTROL.open === s.stationId ? ' is-open' : ''}"
              data-station="${esc(s.stationId)}" type="button">
        <div class="id">${esc(s.stationId)}${locked ? ' <span class="lock-glyph" title="Locked">&#128274;</span>' : ''}${pm}</div>
        <div class="nm">${esc(s.stationName)}</div>
        <div class="st">${esc(s.state)}</div>
      </button>`;
  }).join('');

  $$('#station-grid .station').forEach((element) => {
    element.addEventListener('click', () => openStation(element.dataset.station));
  });
}

function renderActiveMaintenance(orders) {
  $('#maint-count').textContent = orders.length ? `${orders.length} open` : 'none open';
  $('#maint-active').innerHTML = orders.length
    ? orders.map((o) => {
        const elapsed = (Date.now() - Date.parse(o.startedAt)) / 60000;
        const pct = Math.min(100, (elapsed / o.plannedMinutes) * 100);
        const over = elapsed > o.plannedMinutes;
        return `
          <button class="maint-row" type="button" data-station="${esc(o.stationId)}">
            <div class="maint-main">
              <span class="type-chip ${esc(o.type)}">${esc(o.type)}</span>
              <b>${esc(o.stationId)}</b>
              <span class="hint">${esc(o.stationName)} &middot; ${esc(o.technician)}</span>
            </div>
            <div class="maint-bar"><span class="${over ? 'over' : ''}" style="width:${pct}%"></span></div>
            <div class="maint-meta">${esc(o.id)} &middot; ${Math.round(elapsed)} / ${o.plannedMinutes} min${over ? ' &middot; <b class="t-bad">overrun</b>' : ''}</div>
          </button>`;
      }).join('')
    : '<div class="empty">No maintenance in progress. Open a station to start some.</div>';

  $$('#maint-active .maint-row').forEach((element) => {
    element.addEventListener('click', () => openStation(element.dataset.station));
  });
}

function renderPmDue(items) {
  $('#pm-due').innerHTML = items.length
    ? items.slice(0, 10).map((pm) => `
        <button class="pm-row" type="button" data-station="${esc(pm.stationId)}">
          <span class="pm-id">${esc(pm.stationId)}</span>
          <span class="pm-bar"><span class="${esc(pm.status)}" style="width:${Math.min(100, pm.usedPct / 1.3)}%"></span>
            <i class="pm-mark" title="100% of interval"></i></span>
          <span class="pm-val">${pm.usedPct}%</span>
          <span class="pm-chip ${esc(pm.status)}">${esc(PM_LABEL[pm.status])}</span>
        </button>`).join('')
    : '<div class="empty">Every station is inside its maintenance interval.</div>';

  $$('#pm-due .pm-row').forEach((element) => {
    element.addEventListener('click', () => openStation(element.dataset.station));
  });
}

// ---- drawer --------------------------------------------------------------

async function openStation(stationId) {
  CONTROL.open = stationId;
  CONTROL.form = null;
  CONTROL.dirty = false;
  $('#station-drawer').classList.add('open');
  $('#station-drawer').setAttribute('aria-hidden', 'false');
  $('#drawer-scrim').hidden = false;
  $('#drawer-title').textContent = stationId;
  $('#drawer-body').innerHTML = '<div class="empty">Loading&hellip;</div>';
  $$('#station-grid .station').forEach((el) =>
    el.classList.toggle('is-open', el.dataset.station === stationId));

  await referenceData().catch(() => {});
  await refreshDrawer();

  clearInterval(CONTROL.timer);
  CONTROL.timer = setInterval(tickTimers, 1000);
}

function closeStation() {
  CONTROL.open = null;
  CONTROL.view = null;
  CONTROL.form = null;
  clearInterval(CONTROL.timer);
  $('#station-drawer').classList.remove('open');
  $('#station-drawer').setAttribute('aria-hidden', 'true');
  $('#drawer-scrim').hidden = true;
  $$('#station-grid .station').forEach((el) => el.classList.remove('is-open'));
}

/**
 * @param {{force?: boolean}} [options] force re-renders even over a pending
 *   form; used after the operator's own action, never by the poll.
 */
async function refreshDrawer(options = {}) {
  const stationId = CONTROL.open;
  if (!stationId) return;
  if (!options.force && (CONTROL.dirty || CONTROL.form)) return;

  const token = ++CONTROL.seq;

  let station; let oee; let maintenance;
  try {
    [station, oee, maintenance] = await Promise.all([
      getJson(`${API}/stations/${encodeURIComponent(stationId)}`),
      getJson(`${API}/stations/${encodeURIComponent(stationId)}/oee`),
      getJson(`${API}/stations/${encodeURIComponent(stationId)}/maintenance?limit=6`)
    ]);
  } catch (error) {
    $('#drawer-body').innerHTML = `<div class="empty">${esc(error.message)}</div>`;
    return;
  }
  // Closed, switched station, or overtaken by a newer refresh while loading.
  if (CONTROL.open !== stationId || token !== CONTROL.seq) return;
  if (!options.force && (CONTROL.dirty || CONTROL.form)) return;

  CONTROL.view = station.control;
  renderDrawer(station, oee, maintenance);
}

function renderDrawer(station, oee, maintenance) {
  const view = station.control;
  const mode = view.control.mode;
  const allowed = new Set(view.allowedActions);
  const blocked = view.blockedActions || {};
  const active = view.activeMaintenance;
  const pm = view.pm;

  $('#drawer-kicker').textContent = `${station.lineName} · ${station.capability}`;
  $('#drawer-title').textContent = `${station.id} — ${station.name}`;

  const button = (action, label, icon, kind) => `
    <button class="ctl-btn ${kind}" data-action="${action}" type="button"
      ${allowed.has(action) ? '' : `disabled title="${esc(blocked[action] || '')}"`}>
      <span class="ctl-icon" aria-hidden="true">${icon}</span>${label}
    </button>`;

  const lockLine = mode === 'AUTO'
    ? '<span class="mode-chip auto">AUTO &middot; line controlled</span>'
    : `<span class="mode-chip locked">&#128274; ${esc(mode)} &middot; ${esc(view.control.by)} &middot; <span data-since="${esc(view.control.since)}">${relative(view.control.since)}</span></span>`;

  $('#drawer-body').innerHTML = `
    <section class="status-strip s-${esc(view.state)}">
      <div>
        <div class="big-state">${esc(view.state)}</div>
        <div class="hint">for <span data-since="${esc(station.state.since)}">${relative(station.state.since)}</span>
          ${station.state.currentVin ? ` &middot; holding <code>${esc(station.state.currentVin)}</code>` : ''}</div>
      </div>
      ${lockLine}
    </section>
    ${view.control.reason && mode !== 'AUTO' ? `<div class="reason-line">${esc(view.control.reason)}${view.control.reasonCode ? ` <code>${esc(view.control.reasonCode)}</code>` : ''}</div>` : ''}
    ${view.openAndonId ? `<div class="reason-line warn">${view.state === 'DOWN'
      ? `Andon call <code>${esc(view.openAndonId)}</code> is holding this station down &mdash; resolve it to restart.`
      : `Open andon call <code>${esc(view.openAndonId)}</code> raised at this station (line still running).`}</div>` : ''}

    <section class="ctl">
      <label class="operator">Acting as
        <input id="ctl-operator" type="text" value="${esc(operatorName())}" spellcheck="false" autocomplete="off">
      </label>
      <div class="ctl-buttons">
        ${button('start', 'Start', '&#9654;', 'go')}
        ${button('stop', 'Stop', '&#9632;', 'stop')}
        ${button('maintenance', 'Maintenance', '&#128295;', 'maint')}
        ${button('completeMaintenance', 'Complete', '&#10003;', 'done')}
      </div>
      <div id="ctl-form"></div>
    </section>

    ${active ? activeMaintenanceHtml(active) : ''}

    <section class="drawer-section">
      <h3>Preventive maintenance</h3>
      <div class="pm-gauge">
        <div class="pm-track"><span class="${esc(pm.status)}" style="width:${Math.min(100, pm.usedPct / 1.5)}%"></span>
          <i style="left:${100 / 1.5}%" title="Interval"></i></div>
        <div class="pm-legend">
          <b>${pm.cyclesSinceMaintenance}</b> of ${pm.intervalCycles} cycles
          (${pm.usedPct}%) <span class="pm-chip ${esc(pm.status)}">${esc(PM_LABEL[pm.status])}</span>
        </div>
        <div class="hint">${pm.status === 'OK' || pm.status === 'DUE_SOON'
          ? `${pm.remainingCycles} cycles until due`
          : 'Past its interval - this station now fails more often than its MTBF'}
          ${pm.lastMaintenanceAt ? ` &middot; last serviced ${relative(pm.lastMaintenanceAt)} ago` : ''}</div>
      </div>
    </section>

    <section class="drawer-section">
      <h3>This shift</h3>
      <div class="mini-tiles">
        <div class="mini"><span>OEE</span><b style="color:${bandColour(oee.oee)}">${oee.oee}%</b></div>
        <div class="mini"><span>Availability</span><b>${oee.availability}%</b></div>
        <div class="mini"><span>Performance</span><b>${oee.performance}%</b></div>
        <div class="mini"><span>Quality</span><b>${oee.quality}%</b></div>
      </div>
      <div class="hint" style="margin-top:8px">
        ${oee.inputs.totalCount} units &middot; ideal ${station.cycleSeconds}s
        ${oee.avgCycleSeconds ? `&middot; actual ${oee.avgCycleSeconds}s` : ''}
        &middot; MTBF ${station.mtbfMinutes} min &middot; MTTR ${station.mttrMinutes} min
      </div>
    </section>

    <section class="drawer-section">
      <h3>Maintenance history</h3>
      ${maintenance.history.length ? `
        <div class="history">
          ${maintenance.history.map((o) => `
            <div class="hist-row">
              <span class="type-chip ${esc(o.type)}">${esc(o.type)}</span>
              <span class="hist-main"><b>${esc(o.id)}</b> ${esc(o.findings || o.note || o.typeLabel)}</span>
              <span class="hist-meta">${o.status === 'COMPLETED'
                ? `${o.actualMinutes} min${o.overrunMinutes > 0 ? ` <b class="t-warn">+${o.overrunMinutes}</b>` : ''}${o.checklistComplete === false ? ' <b class="t-warn" title="Checklist not complete">&#9888;</b>' : ''} &middot; ${relative(o.completedAt)} ago`
                : '<b class="t-accent">in progress</b>'}</span>
            </div>`).join('')}
        </div>` : '<div class="empty">No maintenance recorded for this station yet.</div>'}
    </section>

    <details class="drawer-section more">
      <summary>Station details</summary>
      <table class="kv">
        <tr><td>Quality gate</td><td>${station.qualityGate ? `yes &mdash; <code>${esc(station.inspectionPlan?.id || '')}</code>` : 'no'}</td></tr>
        <tr><td>Critical to quality</td><td>${station.criticalToQuality ? 'yes &mdash; torque verified' : 'no'}</td></tr>
        ${station.robots ? `<tr><td>Robots</td><td>${station.robots}</td></tr>` : ''}
        ${(station.partsConsumed || []).length ? `<tr><td>Parts consumed</td><td>${station.partsConsumed.map((p) => `${esc(p.partNumber)} &times;${p.quantity}`).join('<br>')}</td></tr>` : ''}
        ${station.producesSerial ? `<tr><td>Produces</td><td><code>${esc(station.producesSerial)}</code></td></tr>` : ''}
      </table>
    </details>`;

  $$('#drawer-body .ctl-btn').forEach((element) => {
    element.addEventListener('click', () => onAction(element.dataset.action));
  });
  $('#ctl-operator').addEventListener('change', (event) => saveOperator(event.target.value.trim() || 'hmi-operator'));

  if (active) bindChecklist();
  if (CONTROL.form) renderForm(CONTROL.form);

  $$('#drawer-body .checklist input, #drawer-body textarea, #maint-parts').forEach((el) => {
    el.addEventListener('input', () => { CONTROL.dirty = true; });
    el.addEventListener('change', () => { CONTROL.dirty = true; });
  });
}

function activeMaintenanceHtml(order) {
  return `
    <section class="drawer-section active-maint">
      <h3>
        <span class="type-chip ${esc(order.type)}">${esc(order.type)}</span>
        ${esc(order.id)} <span class="hint">&middot; ${esc(order.technician)}</span>
      </h3>
      <div class="maint-bar big"><span id="maint-progress" data-start="${esc(order.startedAt)}" data-planned="${order.plannedMinutes}"></span></div>
      <div class="maint-meta"><span id="maint-elapsed">&mdash;</span> of ${order.plannedMinutes} min planned</div>
      ${order.note ? `<div class="hint" style="margin-top:4px">${esc(order.note)}</div>` : ''}
      <ul class="checklist">
        ${order.checklist.map((item, index) => `
          <li><label><input type="checkbox" data-task="${esc(item.task)}" id="task-${index}">
            <span>${esc(item.task)}</span></label></li>`).join('')}
      </ul>
      <div class="check-progress" id="check-progress">0 of ${order.checklist.length} tasks done</div>
      <label class="field">Findings
        <textarea id="maint-findings" rows="2" placeholder="What was found and done"></textarea>
      </label>
      <label class="field">Parts replaced <span class="hint">(comma separated)</span>
        <input id="maint-parts" type="text" placeholder="e.g. PN-BELL-CUP, PN-FILTER-01">
      </label>
    </section>`;
}

function bindChecklist() {
  const boxes = $$('.checklist input[type=checkbox]');
  const update = () => {
    const done = boxes.filter((b) => b.checked).length;
    $('#check-progress').textContent = `${done} of ${boxes.length} tasks done` +
      (done < boxes.length ? ' — anything unticked is recorded as not done' : ' — checklist complete');
    $('#check-progress').classList.toggle('complete', done === boxes.length);
  };
  boxes.forEach((box) => box.addEventListener('change', update));
  update();
}

function tickTimers() {
  $$('#drawer-body [data-since]').forEach((el) => { el.textContent = relative(el.dataset.since); });

  const bar = $('#maint-progress');
  if (bar) {
    const minutes = (Date.now() - Date.parse(bar.dataset.start)) / 60000;
    const planned = Number(bar.dataset.planned);
    bar.style.width = `${Math.min(100, (minutes / planned) * 100)}%`;
    bar.classList.toggle('over', minutes > planned);
    const whole = Math.floor(minutes);
    const seconds = Math.floor((minutes - whole) * 60);
    $('#maint-elapsed').textContent = `${whole}:${String(seconds).padStart(2, '0')} elapsed` +
      (minutes > planned ? ` — ${Math.round(minutes - planned)} min over` : '');
  }
}

// ---- actions -------------------------------------------------------------

function onAction(action) {
  if (action === 'stop' || action === 'maintenance') {
    CONTROL.form = CONTROL.form === action ? null : action;
    renderForm(CONTROL.form);
    return;
  }
  if (action === 'start') return submit('start', {});
  if (action === 'completeMaintenance') {
    const checklist = $$('.checklist input[type=checkbox]').filter((b) => b.checked).map((b) => b.dataset.task);
    const parts = ($('#maint-parts')?.value || '').split(',').map((p) => p.trim()).filter(Boolean);
    return submit('maintenance/complete', {
      technician: operator(),
      findings: $('#maint-findings')?.value.trim() || undefined,
      partsReplaced: parts,
      checklist
    });
  }
}

function operator() {
  const value = ($('#ctl-operator')?.value || '').trim() || 'hmi-operator';
  saveOperator(value);
  return value;
}

function renderForm(kind) {
  const host = $('#ctl-form');
  if (!host) return;
  $$('.ctl-btn').forEach((b) => b.classList.toggle('is-active', b.dataset.action === kind));

  if (!kind) {
    host.innerHTML = '';
    return;
  }

  if (kind === 'stop') {
    const reasons = CONTROL.reasons || [];
    const group = (category) => reasons
      .filter((r) => r.category === category)
      .map((r) => `<option value="${esc(r.code)}"${r.code === 'OPERATOR_STOP' ? ' selected' : ''}>${esc(r.label)}</option>`)
      .join('');
    host.innerHTML = `
      <div class="ctl-form">
        <label class="field">Reason
          <select id="stop-reason">
            <optgroup label="Unplanned - counts against availability">${group('UNPLANNED')}</optgroup>
            <optgroup label="Planned - excluded from planned busy time">${group('PLANNED')}</optgroup>
          </select>
        </label>
        <div class="hint" id="stop-impact"></div>
        <label class="field">Note <input id="stop-note" type="text" placeholder="Optional"></label>
        <div class="form-actions">
          <button class="ctl-btn stop solid" id="stop-confirm" type="button">&#9632; Stop ${esc(CONTROL.open)}</button>
          <button class="link-btn" id="form-cancel" type="button">Cancel</button>
        </div>
        <p class="hint">The station holds its vehicle and stays stopped &mdash; nothing automated will restart it until someone presses Start.</p>
      </div>`;

    const impact = () => {
      const reason = reasons.find((r) => r.code === $('#stop-reason').value);
      $('#stop-impact').innerHTML = reason && reason.countsAgainstOee === false
        ? '<span class="t-ok">Planned &mdash; comes out of planned busy time, OEE availability unaffected.</span>'
        : '<span class="t-warn">Counts against OEE availability.</span>';
    };
    $('#stop-reason').addEventListener('change', impact);
    impact();

    $('#stop-confirm').addEventListener('click', () => submit('stop', {
      reasonCode: $('#stop-reason').value,
      reason: $('#stop-note').value.trim() || undefined
    }));
  }

  if (kind === 'maintenance') {
    const isDown = CONTROL.view?.state === 'DOWN';
    const types = CONTROL.types || [];
    const defaultType = isDown ? 'CORRECTIVE' : 'PREVENTIVE';
    host.innerHTML = `
      <div class="ctl-form">
        <div class="type-cards">
          ${types.map((t) => `
            <label class="type-card ${esc(t.code)}">
              <input type="radio" name="mtype" value="${esc(t.code)}"${t.code === defaultType ? ' checked' : ''}>
              <b>${esc(t.code.toLowerCase())}</b>
              <span>${t.planned ? 'Planned &mdash; out of busy time' : 'Repair &mdash; availability loss, counts for MTTR'}</span>
            </label>`).join('')}
        </div>
        <label class="field">Planned duration <b id="mins-val">20 min</b>
          <input id="maint-mins" type="range" min="5" max="120" step="5" value="20">
        </label>
        <label class="field">Note <input id="maint-note" type="text" placeholder="${isDown ? 'e.g. Servo fault on axis 3' : 'e.g. Scheduled PM'}"></label>
        <div class="form-actions">
          <button class="ctl-btn maint solid" id="maint-confirm" type="button">&#128295; Start maintenance</button>
          <button class="link-btn" id="form-cancel" type="button">Cancel</button>
        </div>
        <p class="hint">Locks the station under a maintenance order with a checklist for its equipment type.
          ${isDown ? 'The station is down, so corrective work keeps the existing failure downtime running.' : ''}</p>
      </div>`;

    const setMinutes = () => { $('#mins-val').textContent = `${$('#maint-mins').value} min`; };
    $$('input[name=mtype]').forEach((radio) => radio.addEventListener('change', () => {
      const type = types.find((t) => t.code === radio.value);
      if (type) { $('#maint-mins').value = type.defaultMinutes; setMinutes(); }
    }));
    const initial = types.find((t) => t.code === defaultType);
    if (initial) $('#maint-mins').value = initial.defaultMinutes;
    $('#maint-mins').addEventListener('input', setMinutes);
    setMinutes();

    $('#maint-confirm').addEventListener('click', () => submit('maintenance', {
      type: ($$('input[name=mtype]').find((r) => r.checked) || {}).value,
      technician: operator(),
      plannedMinutes: Number($('#maint-mins').value),
      note: $('#maint-note').value.trim() || undefined
    }));
  }

  $('#form-cancel')?.addEventListener('click', () => {
    CONTROL.form = null;
    CONTROL.dirty = false;
    renderForm(null);
    refreshDrawer();
  });
}

const ACTION_WORDS = {
  start: 'started',
  stop: 'stopped',
  maintenance: 'handed to maintenance',
  'maintenance/complete': 'returned to service'
};

async function submit(path, body) {
  const stationId = CONTROL.open;
  if (!stationId) return;
  $$('.ctl-btn').forEach((b) => { b.disabled = true; });

  try {
    const result = await control(`/stations/${encodeURIComponent(stationId)}/${path}`, {
      operator: operator(), ...body
    });
    CONTROL.form = null;
    CONTROL.dirty = false;

    const detail = result.completedOrder
      ? `${result.completedOrder.id} closed in ${result.completedOrder.actualMinutes} min` +
        (result.completedOrder.checklistComplete ? '' : ' (checklist incomplete)')
      : result.activeMaintenance && path === 'maintenance'
        ? `${result.activeMaintenance.id} opened, ${result.activeMaintenance.checklist.length} tasks`
        : `now ${result.state}`;
    toast(`${stationId} ${ACTION_WORDS[path]}`, 'ok', detail);
  } catch (error) {
    toast(`${stationId}: ${error.code || 'refused'}`, 'err', error.message);
  }

  await refreshDrawer({ force: true });
  loadStations();
}

// ---- wiring --------------------------------------------------------------

document.addEventListener('DOMContentLoaded', () => {
  $('#drawer-close').addEventListener('click', closeStation);
  $('#drawer-scrim').addEventListener('click', closeStation);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && CONTROL.open) closeStation();
  });
});
