/* Text Extractor — HTML → Markdown conversion.
 * Used by the background crawler (DOMParser documents) and injected into tabs (live DOM).
 * Exposes globalThis.TextExtractor.extract(document, url, options). */
(function () {
  'use strict';

  // Sentinels survive whitespace cleanup and are swapped for real characters at the end.
  const BR = '\x01';     // <br>
  const SP = '\x03';     // significant space (code, list indentation)
  const EMPTY = '\x04';  // empty line inside a code block
  const TAB = '\x05';    // tab inside a code block
  const HARD = '\x06';   // hard line break marker during finalize
  const NEST = '\x07';   // boundary of a nested list (kept tight to its parent item)
  const SENTINELS = /[\x01-\x07]/g;

  const SKIP_TAGS = new Set([
    'script', 'style', 'noscript', 'template', 'svg', 'math', 'canvas', 'iframe', 'frame',
    'frameset', 'object', 'embed', 'audio', 'video', 'map', 'button', 'select', 'option',
    'input', 'textarea', 'dialog', 'head', 'link', 'meta', 'title', 'base', 'source', 'track'
  ]);

  const BLOCK_TAGS = new Set([
    'address', 'article', 'aside', 'body', 'caption', 'center', 'dd', 'details', 'div', 'dl',
    'fieldset', 'figcaption', 'figure', 'footer', 'form', 'header', 'hgroup', 'legend', 'main',
    'nav', 'section', 'search', 'tr', 'tbody', 'thead', 'tfoot', 'html', 'output'
  ]);

  const BOILERPLATE = [
    'nav', 'aside', '[role="navigation"]', '[role="banner"]', '[role="contentinfo"]',
    '[role="complementary"]', '[role="search"]', '[role="dialog"]', '[role="alertdialog"]',
    '[aria-modal="true"]', '.skip-link', '.skip-to-content', '#wpadminbar',
    // Site header / footer built from plain divs (WordPress themes, page builders)
    '#masthead', '#colophon', '#site-header', '#site-footer', '#main-header', '#main-footer',
    '#header', '#footer', '.site-header', '.site-footer', '.et-l--header', '.et-l--footer',
    '.elementor-location-header', '.elementor-location-footer',
    '[data-elementor-type="header"]', '[data-elementor-type="footer"]',
    // Call-to-action buttons
    'a[role="button"]', 'a.btn', 'a.button', 'a[class*="_button"]', 'a[class*="-button"]',
    // Common cookie / consent banners
    '#onetrust-consent-sdk', '#CybotCookiebotDialog', '#usercentrics-root', '#didomi-host',
    '#cookie-notice', '#cookie-law-info-bar', '#cmplz-cookiebanner-container',
    '.cky-consent-container', '.cc-window', '.qc-cmp2-container'
  ].join(',');

  const ICON_CLASS = /(?:^|[\s_-])(?:icons?|fa|fas|far|fab|dashicons|glyphicon)(?:$|[\s_-])/i;
  const ICON_TEXT = /^\s*\S{1,2}\s*$/;
  const LIGATURE_ICON = /(?:^|\s)(?:material-icons\S*|material-symbols-\S+)(?:$|\s)/;
  const PRIVATE_USE = /[-]/g;

  const collapseWs = s => s.replace(/\s+/g, ' ');
  const escapeText = s => s.replace(/[\\`*_[\]<]/g, '\\$&');
  const mdUrl = u => u.replace(/[ ()<>]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());

  function trimBlock(s) {
    return s.replace(/^[\s\x01]+|[\s\x01]+$/g, '');
  }

  function tidy(s) {
    return trimBlock(s.replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n'));
  }

  function block(s) {
    const t = trimBlock(s);
    return t ? `\n\n${t}\n\n` : '';
  }

  function wrap(s, mark) {
    const t = s.trim();
    if (!t || /[\n\x01]/.test(t)) return s;
    const lead = /^\s*/.exec(s)[0];
    const trail = /\s*$/.exec(s)[0];
    return `${lead}${mark}${t}${mark}${trail}`;
  }

  function oneLine(s) {
    return collapseWs(s.replace(/[\n\x01]+/g, ' ')).trim();
  }

  function resolve(href, base) {
    try { return new URL(href, base).href; } catch { return null; }
  }

  function prefixLines(text, marker) {
    const pad = SP.repeat(marker.length);
    return text.split('\n').map((l, i) => (i === 0 ? marker + l : l ? pad + l : l)).join('\n');
  }

  // ---------------------------------------------------------------------------

  function walkChildren(el, ctx) {
    let out = '';
    for (let n = el.firstChild; n; n = n.nextSibling) out += walk(n, ctx);
    return out;
  }

  function walk(node, ctx) {
    if (node.nodeType === 3) return textNode(node, ctx);
    if (node.nodeType !== 1) return '';
    const tag = node.localName;
    if (SKIP_TAGS.has(tag) || ctx.shouldSkip(node)) return '';

    switch (tag) {
      case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6':
        return heading(node, ctx);
      case 'p':
        return block(walkChildren(node, ctx));
      case 'br':
        return BR;
      case 'hr':
        return ctx.inTable ? ' ' : '\n\n---\n\n';
      case 'strong': case 'b':
        return ctx.noEmph ? walkChildren(node, ctx) : wrap(walkChildren(node, ctx), '**');
      case 'em': case 'i':
        return ctx.noEmph ? walkChildren(node, ctx) : wrap(walkChildren(node, ctx), '_');
      case 'del': case 's': case 'strike':
        return ctx.noEmph ? walkChildren(node, ctx) : wrap(walkChildren(node, ctx), '~~');
      case 'code': case 'kbd': case 'samp': case 'tt':
        return inlineCode(node.textContent, ctx);
      case 'pre':
        return ctx.inTable ? inlineCode(node.textContent, ctx) : preBlock(node);
      case 'a':
        return link(node, ctx);
      case 'img':
        return image(node, ctx);
      case 'ul': case 'ol': case 'menu':
        return ctx.inTable ? block(listItemsFlat(node, ctx)) : list(node, ctx);
      case 'li':
        return block(walkChildren(node, ctx));
      case 'blockquote':
        return quote(node, ctx);
      case 'table':
        return table(node, ctx);
      case 'dt': case 'summary':
        return block(wrap(walkChildren(node, ctx), '**'));
      case 'q':
        return `"${walkChildren(node, ctx)}"`;
      case 'td': case 'th':
        return walkChildren(node, ctx) + ' ';
      default: {
        const inner = walkChildren(node, ctx);
        return BLOCK_TAGS.has(tag) || tag.includes('-') ? block(inner) : inner;
      }
    }
  }

  function textNode(node, ctx) {
    let t = node.nodeValue;
    if (!t) return '';
    t = escapeText(collapseWs(t.replace(SENTINELS, '').replace(PRIVATE_USE, '')));
    if (ctx.inTable) t = t.replace(/\|/g, '\\|');
    return t;
  }

  function heading(node, ctx) {
    if (ctx.consumed.has(node)) return '';
    // Page builders often split one heading into several same-level elements.
    const parts = [node];
    for (let n = node.nextSibling; n; n = n.nextSibling) {
      if (n.nodeType === 8 || (n.nodeType === 3 && !n.nodeValue.trim())) continue;
      if (n.nodeType !== 1 || n.localName !== node.localName || ctx.shouldSkip(n)) break;
      ctx.consumed.add(n);
      parts.push(n);
    }
    const text = parts
      .map(p => oneLine(walkChildren(p, { ...ctx, noEmph: true })))
      .filter(Boolean)
      .join(' ');
    if (!text) return '';
    if (ctx.inTable) return ` **${text}** `;
    const level = Math.min(6, Number(node.localName[1]) + ctx.headingOffset);
    return `\n\n${'#'.repeat(level)} ${text}\n\n`;
  }

  function inlineCode(raw, ctx) {
    let t = collapseWs(raw.replace(SENTINELS, ''));
    if (!t.trim()) return raw ? ' ' : '';
    if (ctx.inTable) t = t.replace(/\|/g, '\\|');
    const runs = t.match(/`+/g);
    const fence = '`'.repeat(runs ? Math.max(...runs.map(r => r.length)) + 1 : 1);
    const pad = t.startsWith('`') || t.endsWith('`') ? ' ' : '';
    return `${fence}${pad}${t}${pad}${fence}`;
  }

  function preBlock(node) {
    const code = node.textContent
      .replace(SENTINELS, '')
      .replace(/\r\n?/g, '\n')
      .replace(/^\n+/, '')
      .replace(/\s+$/, '');
    if (!code.trim()) return '';
    const holder = node.querySelector('code') || node;
    const cls = `${node.getAttribute('class') || ''} ${holder.getAttribute('class') || ''}`;
    const lang = (/(?:lang(?:uage)?-)([\w+#.-]+)/i.exec(cls) || [])[1] || '';
    const runs = code.match(/`{3,}/g);
    const fence = '`'.repeat(runs ? Math.max(3, ...runs.map(r => r.length + 1)) : 3);
    const body = code
      .split('\n')
      .map(l => (l ? l.replace(/ /g, SP).replace(/\t/g, TAB) : EMPTY))
      .join('\n');
    return `\n\n${fence}${lang}\n${body}\n${fence}\n\n`;
  }

  function link(node, ctx) {
    const inner = walkChildren(node, ctx);
    if (!ctx.includeLinks) return inner;
    const text = inner.trim();
    const href = node.getAttribute('href');
    if (!text || /[\n\x01]/.test(text) || !href || /^\s*(#|javascript:)/i.test(href)) return inner;
    const url = resolve(href.trim(), ctx.baseUrl);
    if (!url) return inner;
    const lead = /^\s*/.exec(inner)[0];
    const trail = /\s*$/.exec(inner)[0];
    return `${lead}[${text}](${mdUrl(url)})${trail}`;
  }

  function image(node, ctx) {
    if (!ctx.includeImages) return '';
    const src = node.getAttribute('src') || node.getAttribute('data-src');
    if (!src || /^\s*data:/i.test(src)) return '';
    const url = resolve(src.trim(), ctx.baseUrl);
    if (!url) return '';
    const alt = collapseWs(node.getAttribute('alt') || '').trim().replace(/[[\]\\]/g, '\\$&');
    return `![${alt}](${mdUrl(url)})`;
  }

  function list(el, ctx) {
    const ordered = el.localName === 'ol';
    let n = parseInt(el.getAttribute('start'), 10);
    if (Number.isNaN(n)) n = 1;
    const sub = { ...ctx, listDepth: ctx.listDepth + 1 };
    const items = [];

    for (const child of el.children) {
      if (child.localName === 'li') {
        if (ctx.shouldSkip(child)) continue;
        const marker = ordered ? `${n++}. ` : '- ';
        const content = tidy(walkChildren(child, sub).replace(/\s*\x07\s*/g, '\n'));
        if (content) items.push({ text: prefixLines(content, marker), pad: marker.length });
      } else {
        // Invalid but common: nested list placed directly inside a list.
        const content = tidy(walk(child, sub).replace(/\s*\x07\s*/g, '\n'));
        if (!content) continue;
        const prev = items[items.length - 1];
        if (prev) prev.text += '\n' + prefixLines(content, SP.repeat(prev.pad));
        else items.push({ text: prefixLines(content, '- '), pad: 2 });
      }
    }
    if (!items.length) return '';
    const body = items.map(i => i.text).join('\n');
    return ctx.listDepth > 0 ? NEST + body + NEST : `\n\n${body}\n\n`;
  }

  function listItemsFlat(el, ctx) {
    const parts = [];
    for (const li of el.children) {
      if (ctx.shouldSkip(li)) continue;
      const t = oneLine(li.localName === 'li' ? walkChildren(li, ctx) : walk(li, ctx));
      if (t) parts.push('• ' + t);
    }
    return parts.join(BR);
  }

  function quote(node, ctx) {
    const inner = tidy(walkChildren(node, ctx));
    if (!inner) return '';
    if (ctx.inTable) return ` ${inner} `;
    return `\n\n${inner.split('\n').map(l => (l ? '> ' + l : '>')).join('\n')}\n\n`;
  }

  function table(el, ctx) {
    const rows = Array.from(el.rows || []).filter(r => !ctx.shouldSkip(r));
    const width = rows.reduce((m, r) => Math.max(m, cellCount(r)), 0);
    const nested = el.querySelector('table');
    const layout = el.getAttribute('role') === 'presentation' || nested || width < 2 || ctx.inTable;
    if (layout) return block(walkChildren(el, ctx));

    const sub = { ...ctx, inTable: true };
    const matrix = [];
    for (const tr of rows) {
      const cells = [];
      for (const c of tr.cells) {
        if (ctx.shouldSkip(c)) continue;
        const text = tidy(walkChildren(c, sub))
          .replace(/[\n\x01]+/g, '<br>')
          .replace(SENTINELS, ' ')
          .replace(/(<br>\s*)+/g, '<br>');
        cells.push(text);
        const span = Math.min(parseInt(c.getAttribute('colspan'), 10) || 1, 50);
        for (let k = 1; k < span; k++) cells.push('');
      }
      if (cells.some(Boolean)) matrix.push(cells);
    }
    if (!matrix.length) return '';

    const cols = Math.max(...matrix.map(r => r.length));
    const line = r => '| ' + Array.from({ length: cols }, (_, i) => r[i] || '').join(' | ') + ' |';
    const out = [line(matrix[0]), '| ' + Array(cols).fill('---').join(' | ') + ' |'];
    for (const r of matrix.slice(1)) out.push(line(r));

    const cap = el.querySelector('caption');
    const title = cap && !ctx.shouldSkip(cap) ? oneLine(walkChildren(cap, { ...ctx, noEmph: true })) : '';
    return `\n\n${title ? `**${title}**\n\n` : ''}${out.join('\n')}\n\n`;
  }

  function cellCount(tr) {
    let n = 0;
    for (const c of tr.cells) n += Math.min(parseInt(c.getAttribute('colspan'), 10) || 1, 50);
    return n;
  }

  function finalize(s) {
    return s
      .replace(/[ \t\r\f\v]+/g, ' ')
      .replace(/\x07/g, '\n\n')
      .replace(/ *(?:\x01 *)+/g, m => ((m.match(/\x01/g) || []).length > 1 ? '\n\n' : HARD + '\n'))
      .replace(/ *\n */g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/\x06\n\n/g, '\n\n')
      .replace(/\x06\n/g, '  \n')
      .replace(/\x06/g, '')
      .replace(/\x03/g, ' ')
      .replace(/\x05/g, '\t')
      .replace(/\x04/g, '')
      .replace(/^\n+|\s+$/g, '');
  }

  // Splits Markdown into blocks separated by blank lines, keeping fenced code blocks whole.
  function splitBlocks(md) {
    const blocks = [];
    let cur = [];
    let fence = '';
    for (const line of md.split('\n')) {
      if (fence) {
        cur.push(line);
        const t = line.trim();
        if (/^`+$/.test(t) && t.length >= fence.length) fence = '';
        continue;
      }
      const open = /^\s*(`{3,})/.exec(line);
      if (open) {
        fence = open[1];
        cur.push(line);
      } else if (!line.trim()) {
        if (cur.length) blocks.push(cur.join('\n'));
        cur = [];
      } else {
        cur.push(line);
      }
    }
    if (cur.length) blocks.push(cur.join('\n'));
    return blocks;
  }

  const HEADING_LINE = /^(#{1,6}) (.+)$/;

  function cleanBlocks(md) {
    // Drop lines made only of symbols (leftover icons, separators such as "|" or "•").
    const blocks = splitBlocks(md).filter(
      b => b.includes('\n') || /[\p{L}\p{N}]/u.test(b) || /^(?:---|```)/.test(b)
    );
    return blocks
      .map((b, i) => {
        // A short heading directly above a more important one is a label ("portfolio"), not a section.
        const h = HEADING_LINE.exec(b);
        const next = HEADING_LINE.exec(blocks[i + 1] || '');
        if (h && next && next[1].length < h[1].length && h[2].split(/\s+/).length <= 4) return h[2];
        return b;
      })
      .join('\n\n');
  }

  // ---------------------------------------------------------------------------

  function substantial(el, bodyLen) {
    const len = (el.textContent || '').trim().length;
    return len >= 1000 || len >= bodyLen * 0.25;
  }

  function pickRoot(doc, mainOnly) {
    const body = doc.body || doc.documentElement;
    if (!mainOnly) return body;
    const bodyLen = (body.textContent || '').trim().length;
    const mains = doc.querySelectorAll('main, [role="main"]');
    if (mains.length === 1 && substantial(mains[0], bodyLen)) return mains[0];
    if (!mains.length) {
      const articles = doc.querySelectorAll('article');
      if (articles.length === 1 && substantial(articles[0], bodyLen)) return articles[0];
    }
    return body;
  }

  function makeSkipper(opts, live) {
    return el => {
      if (el.getAttribute('aria-hidden') === 'true') return true;
      // Icon fonts render glyphs from a letter or symbol ("$", "home").
      const cls = el.getAttribute('class') || '';
      if (cls && ((ICON_CLASS.test(cls) && ICON_TEXT.test(el.textContent)) || LIGATURE_ICON.test(cls))) return true;
      if (opts.skipHidden) {
        if (el.hasAttribute('hidden')) return true;
        if (live) {
          if (el.checkVisibility && !el.checkVisibility({ visibilityProperty: true, checkVisibilityCSS: true })) {
            const view = el.ownerDocument.defaultView;
            if (!view || view.getComputedStyle(el).display !== 'contents') return true;
          }
        } else {
          const style = el.getAttribute('style');
          if (style && /(display\s*:\s*none|visibility\s*:\s*hidden)/i.test(style)) return true;
        }
      }
      if (opts.mainOnly) {
        if (el.matches(BOILERPLATE)) return true;
        const tag = el.localName;
        if ((tag === 'header' || tag === 'footer') &&
            !(el.parentElement && el.parentElement.closest('article, main, [role="main"]'))) {
          return true;
        }
      }
      return false;
    };
  }

  function extract(doc, pageUrl, options) {
    const opts = options || {};
    const live = !!opts.live;

    let baseUrl = pageUrl;
    const baseEl = doc.querySelector('base[href]');
    if (baseEl) baseUrl = resolve(baseEl.getAttribute('href'), pageUrl) || pageUrl;

    const meta = key => {
      for (const m of doc.querySelectorAll('meta[name], meta[property]')) {
        const k = (m.getAttribute('name') || m.getAttribute('property') || '').toLowerCase();
        if (k === key) return collapseWs(m.getAttribute('content') || '').trim();
      }
      return '';
    };

    const h1 = doc.querySelector('h1');
    const title =
      collapseWs((doc.querySelector('title') || {}).textContent || '').trim() ||
      meta('og:title') ||
      (h1 ? collapseWs(h1.textContent).trim() : '');

    const canonicalEl = doc.querySelector('link[rel~="canonical"][href]');

    const links = new Set();
    for (const a of doc.querySelectorAll('a[href], area[href]')) {
      const href = a.getAttribute('href');
      if (!href || /^\s*(#|javascript:|mailto:|tel:)/i.test(href)) continue;
      const abs = resolve(href.trim(), baseUrl);
      if (abs) links.add(abs);
    }

    const ctx = {
      baseUrl,
      headingOffset: opts.headingOffset == null ? 2 : opts.headingOffset,
      includeLinks: opts.includeLinks !== false,
      includeImages: !!opts.includeImages,
      listDepth: 0,
      inTable: false,
      noEmph: false,
      consumed: new WeakSet(),
      shouldSkip: makeSkipper(opts, live)
    };

    const root = pickRoot(doc, !!opts.mainOnly);
    const markdown = root ? cleanBlocks(finalize(walkChildren(root, ctx))) : '';
    const words = markdown ? markdown.split(/\s+/).filter(w => /[\p{L}\p{N}]/u.test(w)).length : 0;

    return {
      url: pageUrl,
      title,
      description: meta('description') || meta('og:description'),
      lang: (doc.documentElement.getAttribute('lang') || '').trim(),
      canonical: canonicalEl ? resolve(canonicalEl.getAttribute('href'), baseUrl) : null,
      markdown,
      words,
      links: Array.from(links)
    };
  }

  globalThis.TextExtractor = { extract, finalize, splitBlocks, version: '1.1.0' };
})();
