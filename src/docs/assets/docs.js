/* ==========================================================================
   Production Core docs - page behaviour
   The page is fully rendered on the server; everything here is enhancement.
   ========================================================================== */

(function () {
  'use strict';

  const $ = (selector, root) => (root || document).querySelector(selector);
  const $$ = (selector, root) => Array.from((root || document).querySelectorAll(selector));

  const escapeHtml = (value) => String(value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  // ---- theme ---------------------------------------------------------------
  $('#theme-button')?.addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('pc.docs.theme', next); } catch (_error) { /* private mode */ }
    document.dispatchEvent(new CustomEvent('themechange'));
  });

  // ---- mobile navigation ---------------------------------------------------
  $('#menu-button')?.addEventListener('click', () => document.body.classList.toggle('nav-open'));
  $('#content')?.addEventListener('click', () => document.body.classList.remove('nav-open'));

  // ---- reading progress ----------------------------------------------------
  const progress = $('#read-progress');
  const onScroll = () => {
    const max = document.documentElement.scrollHeight - window.innerHeight;
    if (progress) progress.style.width = `${max > 0 ? (window.scrollY / max) * 100 : 0}%`;
  };
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  // ---- table of contents: highlight the section being read -----------------
  const tocLinks = $$('.toc nav a');
  if (tocLinks.length && 'IntersectionObserver' in window) {
    const byId = new Map(tocLinks.map((link) => [link.dataset.target, link]));
    const visible = new Set();
    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) visible.add(entry.target.id);
        else visible.delete(entry.target.id);
      });
      // The first heading in document order that is on screen wins; if none
      // is, keep the last one scrolled past.
      const headings = $$('.prose h2[id], .prose h3[id]');
      let active = headings.find((h) => visible.has(h.id));
      if (!active) active = headings.filter((h) => h.getBoundingClientRect().top < 120).pop();
      tocLinks.forEach((link) => link.classList.remove('is-active'));
      if (active && byId.has(active.id)) byId.get(active.id).classList.add('is-active');
    }, { rootMargin: '-70px 0px -65% 0px' });
    $$('.prose h2[id], .prose h3[id]').forEach((heading) => observer.observe(heading));
  }

  // ---- copy buttons ----------------------------------------------------------
  async function copy(text, button) {
    try {
      await navigator.clipboard.writeText(text);
      const original = button.textContent;
      button.textContent = 'Copied';
      setTimeout(() => { button.textContent = original; }, 1400);
    } catch (_error) {
      button.textContent = 'Press Ctrl+C';
    }
  }

  $$('.code-block').forEach((block) => {
    const button = $('.code-copy', block);
    const code = $('pre code', block);
    button?.addEventListener('click', () => copy(code.textContent, button));
  });

  $('.copy-source')?.addEventListener('click', (event) => {
    event.preventDefault();
    const text = $$('table.source td.lc').map((cell) => cell.textContent).join('\n');
    copy(text, event.currentTarget);
  });

  // Source view: #L10-L20 highlights a range, the way code hosts do.
  function highlightRange() {
    const match = location.hash.match(/^#L(\d+)(?:-L(\d+))?$/);
    $$('table.source tr.hl').forEach((row) => row.classList.remove('hl'));
    if (!match) return;
    const from = Number(match[1]);
    const to = Number(match[2] || match[1]);
    for (let line = from; line <= to; line += 1) $(`#L${line}`)?.classList.add('hl');
    $(`#L${from}`)?.scrollIntoView({ block: 'center' });
  }
  if ($('table.source')) {
    window.addEventListener('hashchange', highlightRange);
    highlightRange();
  }

  // ---- runnable API examples ------------------------------------------------
  //
  // Every GET `curl` in a bash block gets a Run button that performs the same
  // request against this instance and shows the response. Writes are never
  // run from the docs: a documentation page is not the place to change a plant.

  let sampleVin = null;
  async function vin() {
    if (sampleVin) return sampleVin;
    const response = await fetch('/api/v1/units?status=COMPLETED&limit=1');
    const body = await response.json();
    sampleVin = body.items?.[0]?.vin || null;
    return sampleVin;
  }

  /** Parse the GET requests out of a bash block. */
  function parseCommands(text) {
    const joined = text.replace(/\\\n\s*/g, ' ');
    const commands = [];
    for (const raw of joined.split('\n')) {
      const line = raw.trim();
      if (!/^curl\b/.test(line)) continue;
      if (/\s-X\s*(POST|PUT|PATCH|DELETE)\b|\s(-d|--data)\b/.test(line)) continue;

      const [request, ...pipes] = line.split('|');
      // `$API` already ends in /api/v1 (see the API page), so `$API/health`
      // is as much an API URL as `localhost:1880/api/v1/health`.
      const urlMatch = request.match(/["']?(\$API\/[^\s"']*|(?:https?:\/\/)?(?:localhost:\d+|127\.0\.0\.1:\d+|\$BASE)?\/?(?:api\/v1|factory|openapi\.json)[^\s"']*)["']?/);
      if (!urlMatch) continue;

      let url = urlMatch[1]
        .replace(/^https?:\/\//, '')
        .replace(/^(localhost|127\.0\.0\.1):\d+/, '')
        .replace(/^\$API/, '/api/v1')
        .replace(/^\$BASE/, '');
      if (!url.startsWith('/')) url = `/${url}`;
      if (/\$(?!VIN\b)\w+/.test(url)) continue; // other variables cannot be resolved here
      if (url.includes('/events/stream')) continue; // never ends; the live widgets show it instead

      const jq = pipes.join('|').match(/jq\s+(?:-\w+\s+)?'([^']*)'/)?.[1] || null;
      commands.push({ url, jq });
    }
    return commands;
  }

  /**
   * Apply the subset of jq the examples use: paths (.a.b, .items[0]),
   * iteration and slices (.items[], .items[:5]), shorthand objects ({a, b})
   * and pipes between them. Anything else shows the full response instead.
   */
  function applyJq(data, filter) {
    if (!filter) return { value: data, applied: true };
    let outputs = [data];
    let streaming = false;

    for (const segment of filter.split('|').map((s) => s.trim())) {
      const object = segment.match(/^\{\s*([\w\s,]+)\}$/);
      if (object) {
        const keys = object[1].split(',').map((k) => k.trim()).filter(Boolean);
        outputs = outputs.map((v) => Object.fromEntries(keys.map((k) => [k, v?.[k] ?? null])));
        continue;
      }
      const steps = [...segment.matchAll(/\.([A-Za-z_]\w*)|\[(\d+)\]|\[(\d*):(\d*)\]|\[\]/g)];
      const consumed = steps.map((m) => m[0]).join('');
      // `.` alone is identity; otherwise every character must be a known step.
      if (segment !== '.' && consumed !== segment && `.${consumed}` !== segment) {
        return { value: data, applied: false };
      }
      for (const [, key, index, from, to] of steps) {
        if (key !== undefined) outputs = outputs.map((v) => v?.[key]);
        else if (index !== undefined) outputs = outputs.map((v) => v?.[Number(index)]);
        else if (from !== undefined || to !== undefined) {
          outputs = outputs.map((v) => (Array.isArray(v)
            ? v.slice(from ? Number(from) : 0, to ? Number(to) : undefined) : v));
        } else {
          outputs = outputs.flatMap((v) => (Array.isArray(v) ? v : []));
          streaming = true;
        }
      }
    }
    return { value: streaming ? outputs : outputs[0], applied: true };
  }

  function colourJson(json) {
    return escapeHtml(json)
      .replace(/(&quot;[^&]*?&quot;)(\s*:)/g, '<span class="hljs-attr">$1</span>$2')
      .replace(/:\s(&quot;.*?&quot;)/g, ': <span class="hljs-string">$1</span>')
      .replace(/\b(-?\d+(?:\.\d+)?)\b/g, '<span class="hljs-number">$1</span>')
      .replace(/\b(true|false|null)\b/g, '<span class="hljs-literal">$1</span>');
  }

  $$('.code-block[data-runnable]').forEach((block) => {
    const commands = parseCommands($('pre code', block).textContent);
    commands.forEach((command) => {
      const row = document.createElement('div');
      row.className = 'run-line';
      row.innerHTML = `<code>GET ${escapeHtml(command.url)}${command.jq ? `  | jq '${escapeHtml(command.jq)}'` : ''}</code>
        <button type="button">Run &#9654;</button>`;
      const result = document.createElement('div');
      result.className = 'run-result';
      result.hidden = true;
      block.append(row, result);

      $('button', row).addEventListener('click', async (event) => {
        const button = event.currentTarget;
        button.disabled = true;
        button.textContent = 'Running';
        let url = command.url;
        if (url.includes('$VIN')) {
          const found = await vin().catch(() => null);
          if (!found) {
            result.hidden = false;
            result.innerHTML = '<div class="run-status"><span class="bad">no vehicle available to substitute for $VIN</span></div>';
            button.disabled = false;
            button.textContent = 'Run ▶';
            return;
          }
          url = url.replace(/\$VIN/g, found);
        }

        const started = performance.now();
        try {
          const response = await fetch(url, { headers: { accept: 'application/json' } });
          const ms = Math.round(performance.now() - started);
          const text = await response.text();
          let body = text;
          let note = '';
          try {
            const { value, applied } = applyJq(JSON.parse(text), command.jq);
            body = JSON.stringify(value, null, 2);
            if (command.jq && !applied) note = ' &middot; jq filter not applied - showing the full response';
          } catch (_error) { /* not JSON */ }
          const size = new Blob([text]).size;
          result.hidden = false;
          result.innerHTML = `
            <div class="run-status"><span class="${response.ok ? 'ok' : 'bad'}">${response.status} ${escapeHtml(response.statusText)}</span>
              <span>${ms} ms</span><span>${(size / 1024).toFixed(1)} KB</span><span>${escapeHtml(url)}${note}</span></div>
            <pre>${colourJson(body.length > 60000 ? `${body.slice(0, 60000)}\n... truncated` : body)}</pre>`;
        } catch (error) {
          result.hidden = false;
          result.innerHTML = `<div class="run-status"><span class="bad">${escapeHtml(error.message)}</span></div>`;
        }
        button.disabled = false;
        button.textContent = 'Run again ▶';
      });
    });
  });

  // ---- search ----------------------------------------------------------------
  const search = $('#search');
  const input = $('#search-input');
  const results = $('#search-results');
  let index = null;
  let activeHit = 0;

  async function openSearch() {
    search.hidden = false;
    input.value = '';
    input.focus();
    if (!index) {
      try {
        index = await (await fetch('/docs/search-index.json')).json();
      } catch (_error) {
        index = [];
      }
    }
    // Whatever was typed while the index loaded still counts.
    render(input.value);
  }

  function closeSearch() { search.hidden = true; }

  const mark = (text, terms) => terms.reduce(
    (html, term) => html.replace(new RegExp(`(${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'ig'), '<mark>$1</mark>'),
    escapeHtml(text)
  );

  function render(query) {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    const hits = [];
    for (const page of index || []) {
      const pageText = `${page.title} ${page.heading || ''} ${page.blurb}`.toLowerCase();
      if (!terms.length || terms.every((t) => pageText.includes(t))) {
        hits.push({ href: `/docs/${page.slug}`, title: page.title, sub: page.blurb, colour: page.colour, score: 2 });
      }
      if (!terms.length) continue;
      for (const section of page.sections) {
        const text = section.text.toLowerCase();
        if (terms.every((t) => text.includes(t) || page.title.toLowerCase().includes(t))) {
          hits.push({
            href: `/docs/${page.slug}#${section.slug}`, title: section.text, sub: page.title,
            colour: page.colour, score: terms.every((t) => text.includes(t)) ? 1 : 0
          });
        }
      }
    }
    hits.sort((a, b) => b.score - a.score);
    const shown = hits.slice(0, 14);
    activeHit = 0;
    results.innerHTML = shown.length
      ? shown.map((hit, i) => `
          <a class="search-hit${i === 0 ? ' is-active' : ''}" href="${hit.href}">
            <i style="background:${hit.colour}"></i>
            <span><b>${mark(hit.title, terms)}</b><small>${mark(hit.sub, terms)}</small></span>
          </a>`).join('')
      : `<div class="search-empty">Nothing matches &ldquo;${escapeHtml(query)}&rdquo;.</div>`;
  }

  $('#search-button')?.addEventListener('click', openSearch);
  search?.addEventListener('click', (event) => { if (event.target === search) closeSearch(); });
  input?.addEventListener('input', () => render(input.value));
  input?.addEventListener('keydown', (event) => {
    const hits = $$('.search-hit', results);
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      activeHit = (activeHit + (event.key === 'ArrowDown' ? 1 : -1) + hits.length) % Math.max(hits.length, 1);
      hits.forEach((hit, i) => hit.classList.toggle('is-active', i === activeHit));
      hits[activeHit]?.scrollIntoView({ block: 'nearest' });
    } else if (event.key === 'Enter' && hits[activeHit]) {
      location.href = hits[activeHit].href;
      closeSearch();
    }
  });

  document.addEventListener('keydown', (event) => {
    const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName);
    if ((event.key === '/' && !typing) || ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k')) {
      event.preventDefault();
      openSearch();
    } else if (event.key === 'Escape') {
      if (!search.hidden) closeSearch();
      document.body.classList.remove('nav-open');
    }
  });
}());
