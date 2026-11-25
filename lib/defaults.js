/* Text Extractor — default settings shared by the popup and the background crawler. */
'use strict';

globalThis.TE_DEFAULTS = Object.freeze({
  mode: 'page',            // 'page' = current tab only, 'site' = crawl the website
  maxPages: 100,
  maxDepth: 3,
  scope: 'host',           // 'host' | 'domain' (incl. subdomains) | 'path' (current folder)
  loader: 'fetch',         // 'fetch' = raw HTML (fast) | 'render' = load in a tab (runs JavaScript)
  concurrency: 3,
  delay: 250,              // ms pause after each page, per worker
  renderWait: 800,         // ms to let scripts settle after load (render loader)
  respectRobots: true,
  useSitemap: false,
  exclude: 'logout\nlog-out\nsignout\nsign-out\n/wp-admin\n/wp-login',
  mainOnly: true,
  skipHidden: true,
  includeLinks: true,
  includeImages: false,
  sort: 'structure',       // 'structure' (URL tree) | 'crawl' (discovery order)
  saveAs: false
});
