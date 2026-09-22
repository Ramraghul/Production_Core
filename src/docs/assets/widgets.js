/* ==========================================================================
   Production Core docs - live widgets
   --------------------------------------------------------------------------
   Each widget replaces an ASCII diagram in the markdown (kept on the page as a
   collapsed "text version"). They read the running plant through its public
   API, so what the documentation shows is what this instance is doing now.
   Widgets never write: a documentation page is not the place to change a plant.
   ========================================================================== */

(function () {
  'use strict';

  const $ = (selector, root) => (root || document).querySelector(selector);
  const $$ = (selector, root) => Array.from((root || document).querySelectorAll(selector));
  const esc = (value) => String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  const getJson = async (url) => {
    const response = await fetch(url, { headers: { accept: 'application/json' } });
    if (!response.ok) throw new Error(`${response.status} ${url}`);
    return response.json();
  };

  const band = (value) => (value >= 85 ? '#16a34a' : value >= 60 ? '#d97706' : '#dc2626');

  /** Poll while the widget is on screen and the tab is visible. */
  function every(ms, fn, element) {
    const observed = 'IntersectionObserver' in window;
    let onScreen = !observed;
    const run = () => { if (onScreen && document.visibilityState !== 'hidden') fn(); };
    if (observed) {
      // Fires once straight away, so this is also the first load.
      new IntersectionObserver(([entry]) => {
        const appeared = entry.isIntersecting && !onScreen;
        onScreen = entry.isIntersecting;
        if (appeared) run();
      }).observe(element);
    } else {
      run();
    }
    document.addEventListener('visibilitychange', run);
    setInterval(run, ms);
  }

  const head = (title, subtitle, live = true) => `
    <div class="live-head"><h4>${title}</h4>${live ? '<span class="live-dot">live</span>' : '<span class="live-dot off">interactive</span>'}
      ${subtitle ? `<p>${subtitle}</p>` : ''}</div>`;

  // ======================================================================
  // stats - the running instance in six numbers
  // ======================================================================
  function stats(body) {
    body.innerHTML = `${head('This instance, right now', 'Read from the running plant every 5 seconds.')}<div class="stat-grid"><div class="live-loading">Reading the plant&hellip;</div></div>`;
    const grid = $('.stat-grid', body);
    every(5000, async () => {
      try {
        const [health, dashboard, stations] = await Promise.all([
          getJson('/api/v1/health'), getJson('/api/v1/kpi/dashboard'), getJson('/api/v1/stations')
        ]);
        const locked = stations.items.filter((s) => s.controlMode && s.controlMode !== 'AUTO').length;
        const tiles = [
          ['Plant OEE', `${dashboard.headline.oee}%`, dashboard.headline.rating.replace(/_/g, ' ').toLowerCase(), band(dashboard.headline.oee)],
          ['Jobs / hour', dashboard.headline.jph, `target ${dashboard.headline.targetJph}`, '#0ea5e9'],
          ['Vehicles tracked', health.store.collections.units.toLocaleString(), `${dashboard.headline.wip} on the floor`, '#6366f1'],
          ['Supplier lots', health.store.indexes.lots.toLocaleString(), 'indexed for recall', '#10b981'],
          ['Andon open', dashboard.andon.open, `${dashboard.stations.downNow} stations stopped`, dashboard.andon.open ? '#f59e0b' : '#16a34a'],
          ['Stations locked', locked, 'operator stop or maintenance', locked ? '#d946ef' : '#64748b']
        ];
        grid.innerHTML = tiles.map(([k, v, s, c]) =>
          `<div class="stat" style="--c:${c}"><small>${esc(k)}</small><b>${esc(v)}</b><span>${esc(s)}</span></div>`).join('');
      } catch (error) {
        grid.innerHTML = `<div class="widget-error">Could not reach the API: ${esc(error.message)}</div>`;
      }
    }, body);
  }

  // ======================================================================
  // architecture - click a module to see what it does and open its source
  // ======================================================================
  const LAYERS = [
    {
      name: 'Interface', note: 'every way in', colour: '#0ea5e9',
      modules: [
        ['Express API', 'src/api/routes/index.js', 'REST API v1: thin routes that validate input, call a service and shape the response.'],
        ['OpenAPI', 'src/api/openapi.js', 'The Swagger document, generated from the live plant model so enums never drift.'],
        ['Node-RED flows', 'flows/plant.spec.js', 'Thirteen tabs of orchestration, generated from a declarative spec (flows as code).'],
        ['Custom nodes', 'nodes/pc-station/pc-station.js', 'Seven palette nodes that call the services directly - no HTTP hop.'],
        ['Simulator', 'src/simulator/index.js', 'Plays the plant and its people: launches vehicles, breaks stations, repairs them.'],
        ['Docs site', 'src/docs/index.js', 'This page: markdown rendered on the server, live widgets on top.']
      ]
    },
    {
      name: 'Services', note: 'transaction boundary', colour: '#6366f1',
      modules: [
        ['production', 'src/services/productionService.js', 'Work orders, vehicles, sub-assemblies, genealogy. Enforces routing and lockout on entry.'],
        ['quality', 'src/services/qualityService.js', 'Inspections, defects, dispositions and the quality gate.'],
        ['operations', 'src/services/operationsService.js', 'Station state, operator control, maintenance orders, andon and downtime.'],
        ['kpi', 'src/services/kpiService.js', 'ISO 22400 OEE by station, line and plant, with per-window indexes and a short cache.'],
        ['trace', 'src/services/traceService.js', 'Recall analysis against the lot index, judged at the query clock.']
      ]
    },
    {
      name: 'Domain core', note: 'pure functions, no I/O', colour: '#10b981',
      modules: [
        ['plantModel', 'src/core/plantModel.js', 'The factory as data: 7 lines, 43 stations, with integrity checks at boot.'],
        ['unit', 'src/core/unit.js', 'Vehicle lifecycle and routing rules.'],
        ['stationControl', 'src/core/stationControl.js', 'Control modes, lockout, maintenance orders and PM scheduling.'],
        ['genealogy', 'src/core/genealogy.js', 'Append-only as-built tree, sealed at release.'],
        ['quality', 'src/core/quality.js', 'Defect catalogue, inspection plans, dispositions, Pareto.'],
        ['oee', 'src/core/oee.js', 'OEE, TEEP, RTY, DPMO - with the performance cap and loss waterfall.'],
        ['ids', 'src/core/ids.js', 'ISO 3779 VINs with check digits, serials, lots, a seeded PRNG.']
      ]
    },
    {
      name: 'Infrastructure', note: 'state and transport', colour: '#f59e0b',
      modules: [
        ['repository', 'src/store/repository.js', 'In-memory store with capped ring buffers, secondary indexes and JSON snapshots.'],
        ['eventBus', 'src/services/eventBus.js', 'Every event published once; subscribers that throw cannot stall the plant.'],
        ['mqttBroker', 'src/broker/mqttBroker.js', 'Embedded Aedes broker on TCP and WebSocket, mirroring events onto an ISA-95 topic tree.'],
        ['seed', 'src/store/seed.js', 'Deterministic demo history that is never empty, whatever time it boots.']
      ]
    }
  ];

  function architecture(body) {
    body.innerHTML = `${head('The layers - click a module', 'Dependencies point downward only. The core imports nothing from the layers above it.', false)}
      <div class="arch">${LAYERS.map((layer, i) => `
        ${i ? '<div class="arch-arrow">&#9660; calls</div>' : ''}
        <div class="arch-layer" style="--c:${layer.colour}">
          <b>${esc(layer.name)}<small>${esc(layer.note)}</small></b>
          <div class="chips">${layer.modules.map((m, j) =>
            `<button class="chip" style="--c:${layer.colour}" data-l="${i}" data-m="${j}" type="button">${esc(m[0])}</button>`).join('')}</div>
        </div>`).join('')}
      </div>
      <div class="arch-detail" hidden></div>`;

    const detail = $('.arch-detail', body);
    $$('.chip', body).forEach((chip) => chip.addEventListener('click', () => {
      $$('.chip', body).forEach((c) => c.classList.toggle('is-active', c === chip));
      const [name, file, text] = LAYERS[chip.dataset.l].modules[chip.dataset.m];
      detail.hidden = false;
      detail.innerHTML = `<h5>${esc(name)}</h5><p>${esc(text)}</p>
        <a href="/docs/source/${esc(file)}">Read ${esc(file)} &rarr;</a>`;
    }));
  }

  // ======================================================================
  // eventbus - real events from the plant, fanned out to four consumers
  // ======================================================================
  function eventbus(body) {
    const sinks = [
      ['Repository', 'appends to the event log', '#f59e0b'],
      ['MQTT broker', 'republishes on the topic tree', '#10b981'],
      ['SSE stream', 'streams to browsers - this page', '#0ea5e9'],
      ['KPI engine', 'reads it into shift figures', '#6366f1']
    ];
    body.innerHTML = `${head('The event bus, live', 'Every plant event arrives here once and fans out to four consumers. These are real events from this instance.')}
      <div class="bus">
        <div class="bus-source" style="--c:#6366f1"><b>Services</b><small>publish()</small>
          <div style="margin-top:8px;font:700 22px var(--mono)" class="bus-rate">0</div><small>events / min</small></div>
        <div class="bus-pipe"></div>
        <div class="bus-sinks">${sinks.map(([name, note, c]) =>
          `<div class="bus-sink" style="--c:${c}"><span><b>${name}</b><small>${note}</small></span><em>0</em></div>`).join('')}</div>
      </div>
      <div class="bus-feed"></div>`;

    const pipe = $('.bus-pipe', body);
    const counters = $$('.bus-sink em', body);
    const feed = $('.bus-feed', body);
    const rate = $('.bus-rate', body);
    const stamps = [];
    let total = 0;
    let lastDot = 0;

    if (typeof EventSource === 'undefined') return;
    const stream = new EventSource('/api/v1/events/stream');
    const onEvent = (message) => {
      let event;
      try { event = JSON.parse(message.data); } catch (_error) { return; }
      total += 1;
      stamps.push(Date.now());
      while (stamps.length && stamps[0] < Date.now() - 60000) stamps.shift();
      rate.textContent = stamps.length;
      counters.forEach((c) => { c.textContent = total.toLocaleString(); });

      const now = Date.now();
      if (now - lastDot > 220) {
        lastDot = now;
        const dot = document.createElement('i');
        dot.style.top = `${10 + Math.random() * 120}px`;
        pipe.appendChild(dot);
        setTimeout(() => dot.remove(), 750);
        const sink = $$('.bus-sink', body)[Math.floor(Math.random() * 4)];
        sink.classList.add('flash');
        setTimeout(() => sink.classList.remove('flash'), 250);
      }

      if (event.type === 'station.telemetry' || event.type === 'station.cycle') return;
      const row = document.createElement('div');
      row.innerHTML = `<span>${new Date(event.timestamp).toLocaleTimeString('en-CA', { hour12: false })}</span>
        <b>${esc(event.type)}</b><span>${esc(event.stationId || event.vin || '')}</span>`;
      feed.prepend(row);
      while (feed.children.length > 6) feed.lastChild.remove();
    };
    // SSE sends named events; listen to the common families.
    ['unit.moved', 'unit.completed', 'unit.created', 'station.state', 'station.cycle', 'station.telemetry',
      'station.stopped', 'station.started', 'andon.raised', 'andon.resolved', 'andon.acknowledged',
      'downtime.started', 'downtime.ended', 'quality.defect.raised', 'subassembly.built',
      'subassembly.consumed', 'maintenance.started', 'maintenance.completed', 'workorder.released']
      .forEach((type) => stream.addEventListener(type, onEvent));
    window.addEventListener('beforeunload', () => stream.close());
  }

  // ======================================================================
  // plant - lines coloured by live OEE, stations by live state
  // ======================================================================
  function plant(body) {
    body.innerHTML = `${head('The plant, live', 'Line OEE this shift and every station\'s state. Vehicles flow along the main route; feeders deliver serialised modules into main assembly.')}
      <div class="plant"><div class="live-loading">Reading the plant&hellip;</div></div>
      <div class="plant-legend">${['RUNNING', 'IDLE', 'STARVED', 'BLOCKED', 'DOWN', 'STOPPED', 'MAINTENANCE']
        .map((s) => `<span><i class="${s}" style="background:${{ RUNNING: '#22c55e', IDLE: '#94a3b8', STARVED: '#eab308', BLOCKED: '#f97316', DOWN: '#ef4444', STOPPED: '#ec4899', MAINTENANCE: '#a855f7' }[s]}"></i>${s.toLowerCase()}</span>`).join('')}</div>`;
    const grid = $('.plant', body);

    every(6000, async () => {
      try {
        const [dashboard, stations] = await Promise.all([getJson('/api/v1/kpi/dashboard'), getJson('/api/v1/stations')]);
        const lines = new Map(dashboard.lines.map((l) => [l.lineId, l]));
        const byLine = stations.items.reduce((acc, s) => { (acc[s.lineId] = acc[s.lineId] || []).push(s); return acc; }, {});
        const box = (id) => {
          const line = lines.get(id);
          if (!line) return '';
          return `<a class="plant-line" href="/#stations" style="--c:${band(line.oee)}">
              <b>${esc(line.lineName || id)}</b><small>${esc(id)}</small>
              <div class="oee">${line.oee}%</div><small>${line.jph} JPH &middot; wip ${line.wip}</small>
              <div class="station-dots">${(byLine[id] || []).map((s) =>
                `<i class="${esc(s.state)}" title="${esc(s.stationId)} - ${esc(s.state)}${s.controlMode && s.controlMode !== 'AUTO' ? ' (locked)' : ''}"></i>`).join('')}</div>
            </a>`;
        };
        grid.innerHTML = `
          <div><div class="plant-row-label">Feeder lines &middot; deliver serialised modules into main assembly</div>
            <div class="plant-cards feeders">${box('DOOR')}${box('TIRE')}${box('SUBASM')}</div></div>
          <div><div class="plant-row-label">Main route</div>
            <div class="plant-cards main">${box('BODY')}${box('PAINT')}${box('MAINASM')}${box('QUALITY')}</div></div>
          <div class="plant-flow"><span>body in white</span><span class="rail"></span><span>released to the yard</span></div>`;
      } catch (error) {
        grid.innerHTML = `<div class="widget-error">Could not reach the API: ${esc(error.message)}</div>`;
      }
    }, body);
  }

  // ======================================================================
  // state-machine - drawn from the transition tables the domain enforces
  // ======================================================================
  let machinesPromise = null;
  const machines = () => { machinesPromise = machinesPromise || getJson('/api/v1/reference/state-machines'); return machinesPromise; };

  const GOOD = ['COMPLETED', 'RESOLVED', 'CLOSED', 'CONSUMED', 'AVAILABLE', 'VERIFIED'];
  const BAD = ['SCRAPPED', 'CANCELLED'];
  const HOLD = ['HOLD', 'ON_HOLD', 'QUARANTINED', 'ESCALATED', 'REWORK', 'STOPPED', 'MAINTENANCE', 'IN_REPAIR'];

  function layoutMachine(machine) {
    const out = new Map(machine.states.map((s) => [s.id, []]));
    machine.transitions.forEach((t) => out.get(t.from).push(t.to));

    // Column = shortest distance from the initial state.
    const depth = new Map([[machine.initial, 0]]);
    const queue = [machine.initial];
    while (queue.length) {
      const id = queue.shift();
      for (const next of out.get(id) || []) {
        if (!depth.has(next)) { depth.set(next, depth.get(id) + 1); queue.push(next); }
      }
    }
    const maxDepth = Math.max(...depth.values());
    machine.states.forEach((s) => { if (!depth.has(s.id)) depth.set(s.id, maxDepth + 1); });

    // Terminal states share the last column, so every edge into an end state
    // points forward instead of doubling back across the diagram.
    const lastLive = Math.max(0, ...machine.states.filter((s) => !s.terminal).map((s) => depth.get(s.id)));
    machine.states.filter((s) => s.terminal).forEach((s) => depth.set(s.id, lastLive + 1));

    // Rows within a column, ordered by where their predecessors sit.
    const columns = [];
    machine.states.forEach((s) => { (columns[depth.get(s.id)] = columns[depth.get(s.id)] || []).push(s.id); });
    const row = new Map();
    columns.forEach((ids, col) => {
      const score = (id) => {
        const preds = machine.transitions.filter((t) => t.to === id && depth.get(t.from) < col).map((t) => row.get(t.from) ?? 0);
        return preds.length ? preds.reduce((a, b) => a + b, 0) / preds.length : 0;
      };
      ids.sort((a, b) => score(a) - score(b)).forEach((id, i) => row.set(id, i));
    });

    const width = (id) => Math.max(98, id.length * 8 + 30);
    const COL = Math.max(...machine.states.map((s) => width(s.id))) + 76;
    const ROW = 78;
    const tallest = Math.max(...columns.map((c) => c.length));
    // Edges that point backwards arc around the nodes: over the top from a
    // state at the top of its column, underneath from any other, so an arc
    // never has to pass behind a state to get out.
    const backEdges = machine.transitions.filter((t) => depth.get(t.to) < depth.get(t.from));
    const over = new Set(backEdges.filter((t) => row.get(t.from) === 0));
    const under = backEdges.length - over.size;
    const top = 30 + Math.min(over.size, 6) * 14;
    const nodesBottom = top + (tallest - 1) * ROW + 40;

    const pos = new Map();
    columns.forEach((ids, col) => {
      const offset = ((tallest - ids.length) * ROW) / 2;
      ids.forEach((id) => {
        pos.set(id, { x: 24 + col * COL, y: top + offset + row.get(id) * ROW, w: width(id), h: 40 });
      });
    });

    return {
      pos,
      depth,
      over,
      width: 24 + columns.length * COL - 40,
      height: nodesBottom + 30 + Math.min(under, 6) * 14,
      top,
      nodesBottom
    };
  }

  function stateMachine(body, args) {
    const name = args[0];
    body.innerHTML = '<div class="live-loading">Drawing from the live transition tables&hellip;</div>';
    machines().then((all) => {
      const machine = all[name];
      if (!machine) { body.innerHTML = `<div class="widget-error">Unknown state machine '${esc(name)}'</div>`; return; }
      const { pos, depth, over, width, height, top, nodesBottom } = layoutMachine(machine);
      const hasPair = (a, b) => machine.transitions.some((t) => t.from === b && t.to === a);

      let overIndex = 0;
      let underIndex = 0;
      const edges = machine.transitions.map((t, i) => {
        const a = pos.get(t.from);
        const b = pos.get(t.to);
        let d; let lx; let ly;
        const forward = depth.get(t.to) > depth.get(t.from);
        if (forward) {
          const x1 = a.x + a.w; const y1 = a.y + a.h / 2 + (hasPair(t.from, t.to) ? 7 : 0);
          const x2 = b.x; const y2 = b.y + b.h / 2 + (hasPair(t.from, t.to) ? 7 : 0);
          const mid = (x1 + x2) / 2;
          d = `M${x1},${y1} C${mid},${y1} ${mid},${y2} ${x2 - 2},${y2}`;
          lx = mid; ly = (y1 + y2) / 2 - 6;
        } else if (depth.get(t.to) === depth.get(t.from)) {
          // Same column: loop out to the right.
          const x1 = a.x + a.w; const y1 = a.y + a.h / 2;
          const x2 = b.x + b.w; const y2 = b.y + b.h / 2;
          const bulge = x1 + 38 + (a.y > b.y ? 14 : 0);
          d = `M${x1},${y1} C${bulge},${y1} ${bulge},${y2} ${x2 + 2},${y2}`;
          lx = bulge; ly = (y1 + y2) / 2;
        } else {
          // Backwards: arc over or under the nodes so it never crosses the
          // forward flow. The label sits on the curve's midpoint.
          const up = over.has(t);
          const control = up
            ? top - 12 - (overIndex++ % 6) * 14
            : nodesBottom + 14 + (underIndex++ % 6) * 14;
          const x1 = a.x + a.w / 2 + 10; const y1 = up ? a.y : a.y + a.h;
          const x2 = b.x + b.w / 2 - 10; const y2 = up ? b.y : b.y + b.h;
          d = `M${x1},${y1} C${x1},${control} ${x2},${control} ${x2},${up ? y2 - 2 : y2 + 2}`;
          lx = (x1 + x2) / 2; ly = (y1 + y2 + 6 * control) / 8 + 4;
        }
        const label = t.label ? `<rect class="label-bg" x="${lx - t.label.length * 3.4 - 4}" y="${ly - 11}" width="${t.label.length * 6.8 + 8}" height="15" rx="4"/>
          <text x="${lx}" y="${ly}" text-anchor="middle">${esc(t.label)}</text>` : '';
        return `<g class="edge" data-from="${esc(t.from)}" data-to="${esc(t.to)}" data-i="${i}">
          <path d="${d}" marker-end="url(#arrow-${name})"/>${label}</g>`;
      }).join('');

      const nodes = machine.states.map((s) => {
        const p = pos.get(s.id);
        const kind = s.id === machine.initial ? 'initial'
          : GOOD.includes(s.id) ? 'good' : BAD.includes(s.id) ? 'bad' : HOLD.includes(s.id) ? 'hold' : '';
        return `<g class="node ${kind}${s.terminal ? ' terminal' : ''}" data-id="${esc(s.id)}" tabindex="0">
          <rect x="${p.x}" y="${p.y}" width="${p.w}" height="${p.h}" rx="10"/>
          <text x="${p.x + p.w / 2}" y="${p.y + p.h / 2 + 4.5}" text-anchor="middle">${esc(s.id)}</text></g>`;
      }).join('');

      body.innerHTML = `${head(`${esc(machine.name)} lifecycle`, `${esc(machine.description)} Hover or tab to a state to see where it can go.`, false)}
        <div class="sm-wrap"><div class="sm"><svg viewBox="0 0 ${width + 60} ${height}" width="${width + 60}" role="img" aria-label="${esc(machine.name)} state machine">
          <defs><marker id="arrow-${name}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0,0 L10,5 L0,10 z" style="fill:var(--faint)"/></marker></defs>
          ${edges}${nodes}</svg></div></div>
        <div class="sm-caption">Generated from the transition table the domain enforces &mdash; ${machine.states.length} states, ${machine.transitions.length} transitions.</div>
        <div class="sm-legend"><span><i style="border-color:#3b82f6"></i>start</span><span><i style="border-color:#22c55e"></i>success</span>
          <span><i style="border-color:#f59e0b"></i>held</span><span><i style="border-color:#ef4444"></i>failure</span><span><i style="border-color:var(--faint);border-width:3px"></i>terminal</span></div>`;

      const sm = $('.sm', body);
      const caption = $('.sm-caption', body);
      const original = caption.innerHTML;
      const focus = (id) => {
        sm.classList.add('focusing');
        const outgoing = machine.transitions.filter((t) => t.from === id);
        const incoming = machine.transitions.filter((t) => t.to === id);
        $$('.node', sm).forEach((n) => {
          n.classList.toggle('lit', n.dataset.id === id || outgoing.some((t) => t.to === n.dataset.id));
          n.classList.toggle('focus', n.dataset.id === id);
        });
        $$('.edge', sm).forEach((e) => e.classList.toggle('lit', e.dataset.from === id));
        caption.innerHTML = outgoing.length
          ? `From <b>${esc(id)}</b> it can move to ${outgoing.map((t) => `<b>${esc(t.to)}</b>${t.label ? ` (${esc(t.label)})` : ''}`).join(', ')}. Anything else is refused with 409.`
          : `<b>${esc(id)}</b> is terminal &mdash; nothing leaves it. ${incoming.length} way${incoming.length === 1 ? '' : 's'} in.`;
      };
      const clear = () => { sm.classList.remove('focusing'); $$('.lit,.focus', sm).forEach((n) => n.classList.remove('lit', 'focus')); caption.innerHTML = original; };
      $$('.node', sm).forEach((n) => {
        n.addEventListener('mouseenter', () => focus(n.dataset.id));
        n.addEventListener('focus', () => focus(n.dataset.id));
        n.addEventListener('mouseleave', clear);
        n.addEventListener('blur', clear);
      });
    }).catch((error) => { body.innerHTML = `<div class="widget-error">${esc(error.message)}</div>`; });
  }

  // ======================================================================
  // oee-calc - drag the sliders, the real engine answers
  // ======================================================================
  function arcGauge(value, colour) {
    const r = 34; const c = 2 * Math.PI * r;
    const dash = (Math.max(0, Math.min(100, value)) / 100) * c * 0.75;
    return `<svg viewBox="0 0 92 80"><g transform="rotate(135 46 46)">
      <circle cx="46" cy="46" r="${r}" fill="none" stroke="var(--border)" stroke-width="9" stroke-dasharray="${c * 0.75} ${c}" stroke-linecap="round"/>
      <circle cx="46" cy="46" r="${r}" fill="none" stroke="${colour}" stroke-width="9" stroke-dasharray="${dash} ${c}" stroke-linecap="round"/></g>
      <text x="46" y="52" text-anchor="middle" style="font:700 16px var(--mono);fill:var(--text)">${value}</text></svg>`;
  }

  function oeeCalc(body) {
    const fields = [
      ['shift', 'Shift length (minutes, less breaks)', 240, 720, 10, 440],
      ['planned', 'Planned stops (minutes)', 0, 120, 5, 0],
      ['down', 'Unplanned downtime (minutes)', 0, 240, 1, 42],
      ['cycle', 'Ideal cycle time (seconds)', 20, 120, 1, 60],
      ['units', 'Units produced', 0, 900, 5, 390],
      ['fpy', 'First-pass good (%)', 50, 100, 0.5, 97]
    ];
    body.innerHTML = `${head('OEE calculator', 'Every change calls GET /api/v1/kpi/calculate - the same ISO 22400 engine the plant uses, not a copy of the formula. Push "Units produced" past what the cycle time allows to see the performance cap.', false)}
      <div class="calc">
        <div>${fields.map(([id, label, min, max, step, value]) =>
          `<label>${label} <b data-out="${id}">${value}</b><input type="range" data-in="${id}" min="${min}" max="${max}" step="${step}" value="${value}"></label>`).join('')}</div>
        <div><div class="calc-rating"></div><div class="gauges"></div>
          <div class="waterfall"></div><div class="waterfall-legend"></div><div class="calc-out"></div></div>
      </div>`;

    let timer = null;
    const read = () => Object.fromEntries($$('[data-in]', body).map((input) => [input.dataset.in, Number(input.value)]));
    const update = async () => {
      const v = read();
      const total = Math.round(v.units);
      const params = new URLSearchParams({
        plannedBusySeconds: v.shift * 60,
        plannedDowntimeSeconds: v.planned * 60,
        downtimeSeconds: v.down * 60,
        idealCycleSeconds: v.cycle,
        totalCount: total,
        goodCount: Math.round(total * (v.fpy / 100))
      });
      try {
        const r = await getJson(`/api/v1/kpi/calculate?${params}`);
        const colours = { WORLD_CLASS: '#16a34a', GOOD: '#0ea5e9', ACCEPTABLE: '#d97706', NEEDS_ATTENTION: '#dc2626' };
        $('.calc-rating', body).innerHTML = `Rating <b style="background:${colours[r.rating]}">${r.rating.replace(/_/g, ' ')}</b>`;
        $('.gauges', body).innerHTML = [['Availability', r.availability], ['Performance', r.performance], ['Quality', r.quality], ['OEE', r.oee]]
          .map(([k, value]) => `<div class="gauge">${arcGauge(value, band(value))}<small>${k}</small></div>`).join('');
        const l = r.losses;
        const all = Math.max(1, l.availabilityLossSeconds + l.performanceLossSeconds + l.qualityLossSeconds + l.valueAddingSeconds);
        const parts = [['Value-adding', l.valueAddingSeconds, '#16a34a'], ['Quality loss', l.qualityLossSeconds, '#ef4444'],
          ['Performance loss', l.performanceLossSeconds, '#f59e0b'], ['Availability loss', l.availabilityLossSeconds, '#64748b']];
        $('.waterfall', body).innerHTML = parts.map(([, s, c]) => `<span style="width:${(s / all) * 100}%;background:${c}"></span>`).join('');
        $('.waterfall-legend', body).innerHTML = parts.map(([k, s, c]) => `<span><i style="background:${c}"></i>${k} ${Math.round(s / 60)} min</span>`).join('');
        $('.calc-out', body).innerHTML = r.warnings.map((w) => `<div class="calc-warn"><b>${esc(w.code)}</b> &mdash; ${esc(w.message)}</div>`).join('');
      } catch (error) {
        $('.calc-out', body).innerHTML = `<div class="widget-error">${esc(error.message)}</div>`;
      }
    };
    $$('[data-in]', body).forEach((input) => input.addEventListener('input', () => {
      $(`[data-out="${input.dataset.in}"]`, body).textContent = input.value;
      clearTimeout(timer);
      timer = setTimeout(update, 120);
    }));
    update();
  }

  // ======================================================================
  // boot - the start-up order, and why two of the steps are load-bearing
  // ======================================================================
  function boot(body) {
    const steps = [
      ['Store, event bus, services', 'createContext() - restore a snapshot or seed a plant that is never empty.'],
      ['MQTT broker', 'Before Node-RED, or the flows\' mqtt-in nodes come up disconnected and back off.', true],
      ['Express app', 'REST API, Swagger UI and the docs.'],
      ['Node-RED init', 'Registers the service context BEFORE any custom node module is loaded.', true],
      ['finalizeApp()', 'Static files and the error handler go last, after Node-RED has claimed /red and /factory.', true],
      ['HTTP listen', 'One port for everything - free tiers expose only one.'],
      ['Node-RED start', 'The flows begin running.'],
      ['Simulator', 'The plant starts building; shutdown runs this list in reverse.']
    ];
    body.innerHTML = `${head('Boot sequence', 'Order matters in the three highlighted places.', false)}
      <ol class="boot">${steps.map(([t, s, critical]) => `<li class="${critical ? 'critical' : ''}"><b>${esc(t)}</b><span>${esc(s)}</span></li>`).join('')}</ol>
      <div class="boot-controls"><button class="btn primary" type="button">&#9654; Replay</button></div>`;
    const items = $$('.boot li', body);
    const play = () => {
      items.forEach((li) => li.classList.remove('on'));
      items.forEach((li, i) => setTimeout(() => li.classList.add('on'), 180 + i * 260));
    };
    $('.btn', body).addEventListener('click', play);
    if ('IntersectionObserver' in window) {
      const observer = new IntersectionObserver(([entry]) => { if (entry.isIntersecting) { play(); observer.disconnect(); } }, { threshold: 0.4 });
      observer.observe(body);
    } else {
      play();
    }
  }

  // ======================================================================
  // pm-board - maintenance in progress and stations coming due
  // ======================================================================
  function pmBoard(body) {
    body.innerHTML = `${head('Maintenance, live', 'Open maintenance orders and the stations closest to their PM interval. Control them from the Stations tab of the plant HMI.')}
      <div class="pm-rows"><div class="live-loading">Reading the plant&hellip;</div></div>`;
    const rows = $('.pm-rows', body);
    const colour = { OK: '#16a34a', DUE_SOON: '#eab308', DUE: '#f97316', OVERDUE: '#ef4444' };
    every(8000, async () => {
      try {
        const [due, active] = await Promise.all([getJson('/api/v1/maintenance/due'), getJson('/api/v1/maintenance?status=IN_PROGRESS&limit=10')]);
        const open = active.items.map((o) => {
          const minutes = Math.round((Date.now() - Date.parse(o.startedAt)) / 60000);
          return `<div class="pm-row2"><code>${esc(o.stationId)}</code>
            <div class="pm-track2"><span style="width:${Math.min(100, (minutes / o.plannedMinutes) * 100)}%;background:#a855f7"></span></div>
            <span>${minutes}/${o.plannedMinutes}m</span><span class="pill" style="background:#a855f722;color:#a855f7">${esc(o.type.toLowerCase())}</span></div>`;
        }).join('');
        const coming = due.items.slice(0, 8).map((pm) => `<div class="pm-row2"><code>${esc(pm.stationId)}</code>
            <div class="pm-track2"><span style="width:${Math.min(100, pm.usedPct / 1.3)}%;background:${colour[pm.status]}"></span></div>
            <span>${pm.usedPct}%</span><span class="pill" style="background:${colour[pm.status]}22;color:${colour[pm.status]}">${esc(pm.status.replace('_', ' ').toLowerCase())}</span></div>`).join('');
        rows.innerHTML = `${open ? `<small style="color:var(--muted)">IN PROGRESS</small>${open}` : ''}
          <small style="color:var(--muted);margin-top:8px">CLOSEST TO THEIR PM INTERVAL</small>${coming}`;
      } catch (error) {
        rows.innerHTML = `<div class="widget-error">${esc(error.message)}</div>`;
      }
    }, body);
  }

  // ---- registry ------------------------------------------------------------
  const WIDGETS = {
    stats, architecture, eventbus, plant, 'state-machine': stateMachine, 'oee-calc': oeeCalc, boot, 'pm-board': pmBoard
  };

  $$('.live-widget').forEach((element) => {
    const render = WIDGETS[element.dataset.widget];
    const body = $('.live-body', element);
    if (!render) {
      body.innerHTML = `<div class="widget-error">Unknown widget '${esc(element.dataset.widget)}'</div>`;
      return;
    }
    try {
      render(body, (element.dataset.args || '').split(' ').filter(Boolean));
    } catch (error) {
      body.innerHTML = `<div class="widget-error">${esc(error.message)}</div>`;
    }
  });
}());
