'use strict';

/**
 * HTML shell for the documentation site.
 *
 * Plain template literals: the site has one layout and four body types, which
 * does not justify a template engine dependency.
 */

const { escapeHtml } = require('./renderer');
const config = require('../config');

// The flow editor and the flow-served pages exist only where Node-RED runs,
// or where a full runtime is configured to redirect to.
const hasFlows = () => config.nodeRed.enabled || Boolean(config.runtime.fullRuntimeUrl);

/** Inline SVG icons (24x24 stroke), so there is no icon font to load. */
const ICONS = {
  home: '<path d="M3 11l9-7 9 7"/><path d="M5 10v10h14V10"/><path d="M10 20v-6h4v6"/>',
  layers: '<path d="M12 3l9 5-9 5-9-5 9-5z"/><path d="M3 13l9 5 9-5"/><path d="M3 17.5l9 5 9-5" opacity=".5"/>',
  cube: '<path d="M12 2l9 5v10l-9 5-9-5V7l9-5z"/><path d="M12 12l9-5M12 12v10M12 12L3 7"/>',
  wrench: '<path d="M14.7 6.3a4 4 0 00-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 005.4-5.4l-2.5 2.5-2.5-.5-.5-2.5 2.5-2.5z"/>',
  plug: '<path d="M9 2v6M15 2v6"/><path d="M6 8h12v4a6 6 0 01-12 0V8z"/><path d="M12 18v4"/>',
  flow: '<rect x="3" y="3" width="6" height="6" rx="1.5"/><rect x="15" y="15" width="6" height="6" rx="1.5"/><path d="M9 6h4a3 3 0 013 3v6"/>',
  cloud: '<path d="M7 18a5 5 0 01-.6-9.96A6 6 0 0118 9a4.5 4.5 0 01-.5 9H7z"/>',
  check: '<path d="M4 12l5 5L20 6"/>',
  terminal: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 9l3 3-3 3M13 15h4"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M21 12.8A9 9 0 1111.2 3a7 7 0 009.8 9.8z"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  file: '<path d="M14 3H6v18h12V7l-4-4z"/><path d="M14 3v4h4"/>',
  folder: '<path d="M3 6h7l2 2h9v11H3V6z"/>',
  gauge: '<path d="M12 14l4-4"/><path d="M3.3 17a9 9 0 1117.4 0"/>',
  api: '<path d="M8 6l-6 6 6 6M16 6l6 6-6 6"/>',
  factory: '<path d="M3 21V10l6 4V10l6 4V6l6 4v11H3z"/>'
};

const icon = (name, size = 18) =>
  `<svg class="icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ICONS.file}</svg>`;

/**
 * The page shell: top bar, sidebar navigation, content, table of contents.
 * @param {object} options {title, body, pages, current, toc, accent}
 */
function layout({ title, body, pages, current = null, toc = [], accent = '#6366f1' }) {
  const nav = pages.map((page) => `
      <a class="nav-item${page.slug === current ? ' is-current' : ''}" href="/docs/${page.slug}" style="--c:${page.colour}">
        <span class="nav-icon">${icon(page.icon)}</span>
        <span class="nav-text"><b>${escapeHtml(page.title)}</b><small>${escapeHtml(page.blurb)}</small></span>
      </a>`).join('');

  const tocHtml = toc.length ? `
    <aside class="toc" aria-label="On this page">
      <div class="toc-title">On this page</div>
      <nav>${toc.map((item) => `
        <a class="toc-l${item.level}" href="#${escapeHtml(item.slug)}" data-target="${escapeHtml(item.slug)}">${escapeHtml(item.text)}</a>`).join('')}
      </nav>
      <div class="toc-live" id="toc-live"></div>
    </aside>` : '<aside class="toc toc-empty"></aside>';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<meta name="description" content="Production Core documentation - a vehicle assembly MES built on Node-RED.">
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>&#128216;</text></svg>">
<script>
  // Apply the saved or preferred theme before first paint, so the page never
  // flashes the wrong colours.
  (function () {
    var saved = null;
    try { saved = localStorage.getItem('pc.docs.theme'); } catch (e) {}
    var dark = saved ? saved === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches;
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  })();
</script>
<link rel="stylesheet" href="/docs/assets/docs.css">
</head>
<body style="--accent:${accent}">
<div class="read-progress" id="read-progress"></div>

<header class="topbar">
  <button class="icon-button menu-button" id="menu-button" type="button" aria-label="Open navigation">${icon('menu')}</button>
  <a class="brand" href="/docs/README">
    <span class="brand-mark">${icon('factory', 20)}</span>
    <span><b>Production Core</b><small>Documentation</small></span>
  </a>
  <button class="search-button" id="search-button" type="button">
    ${icon('search', 16)}<span>Search the docs</span><kbd>/</kbd>
  </button>
  <nav class="top-links">
    <a href="/">${icon('gauge', 16)}<span>Plant HMI</span></a>
    <a href="/api-docs">${icon('api', 16)}<span>API</span></a>
    ${hasFlows() ? `<a href="/red" target="_blank" rel="noopener">${icon('flow', 16)}<span>Flows</span></a>` : ''}
  </nav>
  <button class="icon-button" id="theme-button" type="button" aria-label="Toggle dark mode">
    <span class="theme-sun">${icon('sun')}</span><span class="theme-moon">${icon('moon')}</span>
  </button>
</header>

<div class="shell">
  <nav class="sidebar" id="sidebar" aria-label="Documentation">
    <div class="nav-group">Guide</div>
    ${nav}
    <div class="nav-group">Live system</div>
    <a class="nav-item plain" href="/">${icon('gauge')}<span class="nav-text"><b>Plant HMI</b></span></a>
    <a class="nav-item plain" href="/api-docs">${icon('api')}<span class="nav-text"><b>Swagger UI</b></span></a>
    ${hasFlows() ? `<a class="nav-item plain" href="/factory/board">${icon('flow')}<span class="nav-text"><b>Flow-served line board</b></span></a>` : ''}
    <a class="nav-item plain" href="/docs/source/src">${icon('folder')}<span class="nav-text"><b>Browse the source</b></span></a>
  </nav>

  <main class="content" id="content">
${body}
  </main>
${tocHtml}
</div>

<div class="search" id="search" hidden>
  <div class="search-panel" role="dialog" aria-label="Search">
    <div class="search-input">${icon('search')}<input id="search-input" type="text" placeholder="Search pages and sections&hellip;" autocomplete="off" spellcheck="false"><kbd>Esc</kbd></div>
    <div class="search-results" id="search-results"></div>
  </div>
</div>

<script src="/docs/assets/docs.js"></script>
<script src="/docs/assets/widgets.js"></script>
</body>
</html>`;
}

/** A rendered documentation page. */
function pageBody({ page, rendered, previous, next, readingMinutes }) {
  const updated = rendered.updatedAt.toISOString().slice(0, 10);
  const pagerCard = (target, direction) => target ? `
      <a class="pager-card ${direction}" href="/docs/${target.slug}" style="--c:${target.colour}">
        <small>${direction === 'prev' ? '&larr; Previous' : 'Next &rarr;'}</small>
        <b>${escapeHtml(target.title)}</b>
        <span>${escapeHtml(target.blurb)}</span>
      </a>` : '<span></span>';

  return `
    <section class="hero" style="--c:${page.colour}">
      <div class="hero-glow"></div>
      <div class="hero-kicker">${icon(page.icon, 16)} ${escapeHtml(page.title)}</div>
      <h1>${escapeHtml(rendered.title || page.title)}</h1>
      ${rendered.lede ? `<p class="lede">${rendered.lede}</p>` : ''}
      <div class="hero-meta">
        <span>${readingMinutes} min read</span>
        <span>Updated ${updated}</span>
        <a href="/docs/raw/${page.slug}">View markdown</a>
        <a href="/docs/source/${escapeHtml(page.file)}">${escapeHtml(page.file)}</a>
      </div>
    </section>

    <article class="prose">
${rendered.html}
    </article>

    <nav class="pager">${pagerCard(previous, 'prev')}${pagerCard(next, 'next')}</nav>`;
}

/** A highlighted repository file with line numbers and #L anchors. */
function sourceBody({ file, language, highlighted, lines, size }) {
  const crumbs = file.split('/');
  const breadcrumb = crumbs.map((part, index) => {
    const target = crumbs.slice(0, index + 1).join('/');
    return index === crumbs.length - 1
      ? `<b>${escapeHtml(part)}</b>`
      : `<a href="/docs/source/${escapeHtml(target)}">${escapeHtml(part)}</a>`;
  }).join('<span>/</span>');

  // highlight.js output can open a span on one line and close it on another;
  // re-open unclosed spans per line so each table row stays well-formed.
  const rows = [];
  const open = [];
  for (const line of highlighted.split('\n')) {
    const prefix = open.join('');
    const tags = line.match(/<span[^>]*>|<\/span>/g) || [];
    for (const tag of tags) {
      if (tag === '</span>') open.pop();
      else open.push(tag);
    }
    rows.push(prefix + line + '</span>'.repeat(open.length));
  }

  return `
    <section class="hero source-hero" style="--c:#64748b">
      <div class="hero-kicker">${icon('file', 16)} Source</div>
      <div class="breadcrumb">${breadcrumb}</div>
      <div class="hero-meta"><span>${escapeHtml(language)}</span><span>${lines} lines</span><span>${(size / 1024).toFixed(1)} KB</span>
        <a href="#" class="copy-source">Copy file</a></div>
    </section>
    <div class="source-view">
      <table class="source"><tbody>
${rows.map((row, index) => `<tr id="L${index + 1}"><td class="ln"><a href="#L${index + 1}">${index + 1}</a></td><td class="lc">${row || ' '}</td></tr>`).join('\n')}
      </tbody></table>
    </div>`;
}

/** A directory listing inside the source browser. */
function directoryBody(directory, entries) {
  const parent = directory.includes('/') ? directory.split('/').slice(0, -1).join('/') : null;
  return `
    <section class="hero source-hero" style="--c:#64748b">
      <div class="hero-kicker">${icon('folder', 16)} Source</div>
      <h1>${escapeHtml(directory)}/</h1>
    </section>
    <div class="dir-list">
      ${parent ? `<a class="dir-row" href="/docs/source/${escapeHtml(parent)}">${icon('folder')}<span>..</span></a>` : ''}
      ${entries.map((entry) => `
      <a class="dir-row" href="/docs/source/${escapeHtml(`${directory}/${entry.name}`)}">${icon(entry.dir ? 'folder' : 'file')}<span>${escapeHtml(entry.name)}${entry.dir ? '/' : ''}</span></a>`).join('')}
    </div>`;
}

function notFoundBody(url) {
  return `
    <section class="hero" style="--c:#ef4444">
      <div class="hero-kicker">404</div>
      <h1>Nothing here</h1>
      <p class="lede"><code>${escapeHtml(url)}</code> is not a documentation page or a viewable source file.</p>
      <div class="hero-meta"><a href="/docs/README">Back to the overview</a></div>
    </section>`;
}

module.exports = { layout, pageBody, sourceBody, directoryBody, notFoundBody, icon };
