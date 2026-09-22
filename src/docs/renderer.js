'use strict';

/**
 * Markdown to HTML for the documentation site.
 *
 * Rendering happens on the server so the pages work with JavaScript off, are
 * readable by a crawler, and need no markdown library in the browser. The
 * browser only adds interactivity on top: live widgets, runnable examples,
 * search and the table-of-contents highlight.
 *
 * Live widgets are declared in the markdown with an HTML comment placed just
 * before an ordinary code block:
 *
 *     <!-- live:state-machine unit -->
 *     ```
 *     PLANNED --> IN_PROCESS --> COMPLETED      (ASCII diagram)
 *     ```
 *
 * GitHub hides the comment and shows the ASCII diagram. This renderer swaps
 * the code block for an interactive widget and keeps the ASCII as a collapsed
 * "text version", so neither audience loses anything.
 */

const path = require('path');
const MarkdownIt = require('markdown-it');
const hljs = require('highlight.js/lib/core');
const { findPage, SOURCE_PREFIXES, SOURCE_FILES } = require('./catalogue');

hljs.registerLanguage('javascript', require('highlight.js/lib/languages/javascript'));
hljs.registerLanguage('json', require('highlight.js/lib/languages/json'));
hljs.registerLanguage('bash', require('highlight.js/lib/languages/bash'));
hljs.registerLanguage('yaml', require('highlight.js/lib/languages/yaml'));
hljs.registerLanguage('dockerfile', require('highlight.js/lib/languages/dockerfile'));
hljs.registerLanguage('xml', require('highlight.js/lib/languages/xml'));
hljs.registerLanguage('css', require('highlight.js/lib/languages/css'));
hljs.registerLanguage('ini', require('highlight.js/lib/languages/ini'));
hljs.registerLanguage('markdown', require('highlight.js/lib/languages/markdown'));

const ALIASES = {
  js: 'javascript', sh: 'bash', shell: 'bash', yml: 'yaml', html: 'xml', env: 'ini', toml: 'ini', md: 'markdown'
};

const LIVE_MARKER = /^<!--\s*live:([\w-]+)((?:\s+[\w-]+)*)\s*-->\s*$/;

const escapeHtml = (value) => String(value)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

/** Syntax-highlight a block. Unknown languages fall back to escaped text. */
function highlight(code, language) {
  const lang = ALIASES[language] || language;
  if (lang && hljs.getLanguage(lang)) {
    try {
      return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
    } catch (_error) { /* fall through */ }
  }
  return escapeHtml(code);
}

/** GitHub-compatible heading slug, so existing #anchors keep working. */
function slugify(text) {
  return String(text)
    .toLowerCase()
    .replace(/<[^>]+>/g, '')
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .trim()
    .replace(/\s+/g, '-');
}

/**
 * Rewrite a link found in a markdown file.
 *
 *  - another doc (`ARCHITECTURE.md`, `docs/API.md`, `../README.md`) -> its page
 *  - a repository file the docs may show (`../flows/plant.spec.js`) -> source view
 *  - absolute and external links are left alone
 *
 * @param {string} href
 * @param {string} fromFile repo-relative path of the markdown being rendered
 */
function rewriteHref(href, fromFile) {
  if (!href || /^(https?:|mailto:|#|\/)/i.test(href)) return href;

  const [target, hash] = href.split('#');
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), target));
  const anchor = hash ? `#${hash}` : '';

  if (resolved.startsWith('..')) return href;

  const page = /\.md$/i.test(resolved) ? findPage(path.posix.basename(resolved)) : null;
  if (page && (resolved === page.file)) return `/docs/${page.slug}${anchor}`;

  if (isViewableSource(resolved) || isViewableSource(resolved.replace(/\/$/, '') + '/')) {
    return `/docs/source/${resolved}${anchor}`;
  }
  return href;
}

/** Whether a repo-relative path is on the source allow-list. */
function isViewableSource(relative) {
  if (!relative || relative.includes('..')) return false;
  if (/(^|\/)(node_modules|data)(\/|$)/.test(relative)) return false;
  if (/(^|\/)\.env$/.test(relative)) return false;
  return SOURCE_FILES.includes(relative) || SOURCE_PREFIXES.some((prefix) => relative.startsWith(prefix));
}

function createMarkdown() {
  const md = new MarkdownIt({ html: true, linkify: true, typographer: false });

  // --- live widget markers -------------------------------------------------
  md.core.ruler.push('live_markers', (state) => {
    const tokens = state.tokens;
    for (let index = 0; index < tokens.length; index += 1) {
      const token = tokens[index];
      if (token.type !== 'html_block') continue;
      const match = token.content.trim().match(LIVE_MARKER);
      if (!match) continue;

      const live = { name: match[1], args: match[2].trim().split(/\s+/).filter(Boolean) };
      // A marker claims a code block only when the block starts on the very
      // next line. With a blank line between them the marker is a standalone
      // widget and the code block is ordinary content.
      const next = tokens[index + 1];
      const adjacent = next && next.map && token.map && next.map[0] === token.map[1];
      if (next && next.type === 'fence' && adjacent) {
        next.meta = { ...(next.meta || {}), live };
        token.meta = { hidden: true };
      } else {
        token.meta = { live };
      }
    }
  });

  const widget = (live, fallback) => `
<div class="live-widget" data-widget="${escapeHtml(live.name)}" data-args="${escapeHtml(live.args.join(' '))}">
  <div class="live-body"><div class="live-loading">Loading live view&hellip;</div></div>
  ${fallback ? `<details class="text-fallback"><summary>Text version</summary>${fallback}</details>` : ''}
</div>\n`;

  md.renderer.rules.html_block = (tokens, index) => {
    const token = tokens[index];
    if (token.meta?.hidden) return '';
    if (token.meta?.live) return widget(token.meta.live, '');
    return token.content;
  };

  md.renderer.rules.fence = (tokens, index) => {
    const token = tokens[index];
    const language = (token.info || '').trim().split(/\s+/)[0];
    const body = highlight(token.content, language);
    const pre = `<pre class="hljs"><code class="language-${escapeHtml(language || 'text')}">${body}</code></pre>`;

    if (token.meta?.live) return widget(token.meta.live, pre);

    const runnable = (ALIASES[language] || language) === 'bash' && /\bcurl\b/.test(token.content);
    return `
<div class="code-block"${runnable ? ' data-runnable="1"' : ''}>
  <div class="code-bar"><span class="code-lang">${escapeHtml(language || 'text')}</span>
    <button class="code-copy" type="button">Copy</button></div>
  ${pre}
</div>\n`;
  };

  // --- tables and callouts --------------------------------------------------
  md.renderer.rules.table_open = () => '<div class="table-wrap"><table>\n';
  md.renderer.rules.table_close = () => '</table></div>\n';
  md.renderer.rules.blockquote_open = () => '<blockquote class="callout">\n';

  return md;
}

const md = createMarkdown();

/**
 * Render one markdown document.
 *
 * @param {string} source markdown text
 * @param {string} file repo-relative path, for resolving relative links
 * @returns {{title, lede, html, toc, words}}
 */
function renderMarkdown(source, file) {
  const env = {};
  const tokens = md.parse(source, env);

  // Pull the H1 and the paragraph after it out as the page hero.
  let title = null;
  let lede = null;
  if (tokens[0]?.type === 'heading_open' && tokens[0].tag === 'h1') {
    title = tokens[1].content;
    tokens.splice(0, 3);
    if (tokens[0]?.type === 'paragraph_open') {
      lede = md.renderer.renderInline(tokens[1].children, md.options, env);
      tokens.splice(0, 3);
    }
  }

  // Anchor every heading, collect h2/h3 for the table of contents, and rewrite
  // links so they work inside the site.
  const toc = [];
  const used = new Map();
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];

    if (token.type === 'heading_open') {
      const inline = tokens[index + 1];
      const text = inline.children.map((c) => c.content).join('');
      let slug = slugify(text) || `section-${index}`;
      const seen = used.get(slug) || 0;
      used.set(slug, seen + 1);
      if (seen) slug = `${slug}-${seen}`;
      token.attrSet('id', slug);
      if (token.tag === 'h2' || token.tag === 'h3') {
        toc.push({ level: Number(token.tag.slice(1)), text, slug });
      }
    }

    if (token.type === 'inline' && token.children) {
      for (const child of token.children) {
        if (child.type !== 'link_open') continue;
        const href = child.attrGet('href');
        const rewritten = rewriteHref(href, file);
        child.attrSet('href', rewritten);
        if (/^https?:/i.test(rewritten)) {
          child.attrSet('target', '_blank');
          child.attrSet('rel', 'noopener');
        }
      }
    }
  }

  // Heading anchors, added after slugging so the anchor uses the final id.
  const html = md.renderer.render(tokens, md.options, env)
    .replace(/<(h[2-4]) id="([^"]+)">/g,
      '<$1 id="$2"><a class="anchor" href="#$2" aria-label="Link to this section">#</a>');

  const words = source.replace(/```[\s\S]*?```/g, ' ').split(/\s+/).filter(Boolean).length;

  return { title, lede, html, toc, words };
}

module.exports = { renderMarkdown, highlight, slugify, rewriteHref, isViewableSource, escapeHtml };
