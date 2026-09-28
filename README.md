# Text Extractor (Firefox add-on)

Text Extractor pulls the text from the page you're viewing, or crawls a whole website, and saves it as **one structured Markdown file**.

## Features

- **This page:** reads the page as it appears in the tab, after its JavaScript has run.
- **Whole website:** crawls pages breadth-first from the current page.
  - **Limits:** set the maximum number of pages and the maximum link depth.
  - **Scope:** stay on this site, include its subdomains, or stay inside the current folder.
  - **Fast loader:** downloads the raw HTML directly. Parallel requests and a pause between pages are configurable.
  - **Render JavaScript loader:** opens pages in a minimized window, for single-page apps and content that JavaScript loads.
  - **robots.txt and sitemaps:** optionally follows `robots.txt` rules and adds URLs from `sitemap.xml`.
  - **Exclude rules:** skips URLs matching text or a `/regex/`. Logout and admin links are excluded by default.
  - **Duplicates:** skips duplicate URLs (tracking parameters, `www.` and trailing slashes are ignored) and pages whose text is identical. Copies of a page with extra query parameters (such as `?nocache=…`) are skipped when the page declares the same canonical URL.
  - **Your session:** uses your browser cookies, so pages you're logged in to are included.
- **Clean Markdown:**
  - Keeps headings, paragraphs, lists (including nested lists), tables, quotes, code blocks, bold and italic text, links, and optionally images.
  - **Main content only (on by default):** skips menus, headers, footers (including footers built from plain `div`s by WordPress themes and page builders), sidebars, button links, icon glyphs and common cookie banners.
  - **Tidy structure:** joins headings that a page splits across several elements, turns small label headings into plain text, and drops lines that contain only symbols.
  - **Site-wide text appears once:** text that repeats on at least half of the crawled pages (at least 3), such as a footer, is removed from the pages and listed once in a *Site-wide content* section at the end.
  - **Shorter page titles:** a site name shared by most titles (`Contact | My Site`) is removed from the page titles and shown once at the top.
  - **Skip hidden elements (on by default):** leaves out text that isn't visible on the page.
- **Stop at any time:** the pages collected so far are still saved.
- **Get the result:** the file downloads automatically. You can also download it again or copy it to the clipboard from the popup.

## Output structure

```markdown
---
title: "My Site — Website Text Export"
source: "https://example.com/"
site: "My Site"
language: "en"
exported: 2026-09-17T10:00:00.000Z
mode: website-crawl
pages: 42
words: 18234
generator: "Text Extractor 1.1.0"
---

# My Site — Website Text Export

> **Source:** <https://example.com/>
> **Pages:** 42 · **Words:** 18,234 · **Language:** en

## Table of Contents
- [Home](#page-1) — `/`
  - [About us](#page-2) — `/about`
    - [Team](#page-3) — `/about/team`
- [Site-wide content](#site-wide)

---

<a id="page-1"></a>

## 1. Home

**URL:** <https://example.com/> · **Words:** 523
**Description:** …

### Page H1 heading        ← headings inside a page are shifted down two levels
#### Page H2 heading
…

---

## Site-wide content       ← footer and other text repeated across pages, listed once
…

---

## Crawl Report            ← skipped pages, URLs left in the queue, errors
```

Pages are sorted by URL structure by default, so each section of the site stays together. You can switch to crawl order instead.

## Install

### Temporary install (for development)

1. Open `about:debugging#/runtime/this-firefox` in Firefox.
2. Click **Load Temporary Add-on…** and select `manifest.json` from this folder.
3. Pin the **Text Extractor** icon to the toolbar.

Firefox removes a temporary add-on when it restarts.

### With web-ext

```bash
npx web-ext run          # starts Firefox with the add-on loaded
npx web-ext lint         # checks the add-on for problems
npx web-ext build        # creates a .zip in web-ext-artifacts/
```

To install the add-on permanently in regular Firefox, sign it through [addons.mozilla.org](https://addons.mozilla.org/developers/) (you can list it or keep it unlisted). Firefox Developer Edition and Nightly can install unsigned builds if you set `xpinstall.signatures.required` to `false`.

## Usage

1. Open any page on the site you want to extract.
2. Click the toolbar icon and choose **This page** or **Whole website**.
3. Adjust the options and click **Extract** or **Crawl**.
4. The popup can be closed while the extraction runs; the work continues in the background. Open the popup again to check progress or to stop.

The first time you start, Firefox asks for permission to access websites. The add-on needs it to read pages other than the current tab.

## Notes & limits

- **The Fast loader doesn't run JavaScript.** If a site's pages come out empty, switch to **Render JavaScript**.
- **Render JavaScript is slower** and opens a minimized browser window. Closing that window stops the crawl.
- **Some pages can't be read.** Firefox doesn't let add-ons read its own pages (`about:`, `addons.mozilla.org`) or the built-in PDF viewer.
- **Only webpages are crawled.** Links to files such as PDFs, images, archives and office documents are skipped.
- **Crawl limit:** the most you can crawl in one run is 10,000 pages.
- **Crawl responsibly.** Keep the defaults for the pause per page and robots.txt on sites you don't own.

## Project layout

```
manifest.json        Manifest V3 (Firefox 140+)
background.js        crawler, robots.txt/sitemap handling, Markdown assembly, download
lib/html2md.js       HTML → Markdown converter (runs in the background and inside tabs)
lib/defaults.js      default settings shared by the popup and background
popup/               toolbar popup UI
icons/icon.svg       add-on icon
```

## License

Text Extractor is free software, licensed under the [GNU General Public License v3.0](LICENSE).
