#!/usr/bin/env node
/**
 * fetch_deviceforum.js
 *
 * Scraper for https://device-forum.com/media/
 * (Device Forum — Firmwares, Schematics, Hardware Repairs media gallery:
 * testpoints, pinouts, board photos, component maps, etc. for phones/tablets.)
 *
 * WHY PLAIN HTTPS (not Puppeteer):
 * ---------------------------------------------------------------------
 * Like fetch_edlpoint.js's page, /media/ is a XenForo forum with a media
 * gallery add-on ("Solutions" in the nav). The listing grid is rendered
 * fully server-side — no infinite scroll, no client-side lazy loading.
 * Pagination is plain numbered pages (/media/page-2, /media/page-3, ...).
 * A single https.get() per page + cheerio parse is enough.
 *
 * WHAT IT COLLECTS
 * ---------------------------------------------------------------------
 * The gallery has ~565 categories (brand > model line > exact model, e.g.
 * Samsung > SM-G > SM-G991) and, at last count, 7,000+ uploaded images
 * across ~140+ listing pages (50 items/page). For every item in the grid
 * we collect:
 *   - id             -> numeric media id (from /media/<id>/)
 *   - title          -> caption under the thumbnail, which on this site is
 *                       literally the original filename, e.g.
 *                       "SAMSUNG SM-G991 TOUCHSCREEN.webp"
 *   - category_id / category_name -> the (leaf) category shown on the card,
 *                       e.g. "SM-G991" (id 563)
 *   - page_url       -> https://device-forum.com/media/<id>/  (item page)
 *   - thumbnail_url  -> small grid thumbnail (…/data/xfmg/thumbnail/…)
 *   - image_url      -> FULL-SIZE image, built directly from the id as
 *                       https://device-forum.com/media/<id>/full — this
 *                       endpoint is what the lightbox on the item page
 *                       itself points at, so it is derivable WITHOUT a
 *                       second HTTP request per item (unlike
 *                       fetch_testpoints.js / fetch_edlpoint.js, which
 *                       have to read a real <a href> per item). This is
 *                       the single biggest reason a full-site run here is
 *                       cheap: total requests ≈ number of listing pages,
 *                       not number of items.
 *   - added_by, date_added, view_count, comment_count -> best-effort
 *                       metadata scraped from the card (not guaranteed
 *                       present on every card; null if not found)
 *
 * PARSING APPROACH / FRAGILITY NOTE
 * ---------------------------------------------------------------------
 * Same philosophy as fetch_edlpoint.js: don't trust a specific CSS class
 * name (add-on markup can be re-skinned without notice). Instead:
 *   1. Find every thumbnail <img> whose src contains "/xfmg/thumbnail/"
 *      (the media-gallery add-on's stable thumbnail path).
 *   2. Walk up its ancestors (bounded to 8 levels) until we reach a node
 *      whose text contains "View count" — that's the whole card.
 *   3. Within that card, pull the id from the thumbnail's <a href>, the
 *      title from the *other* link that points at the same id (or the
 *      img's alt as a fallback), the category from a link to
 *      /media/categories/<id>/, and the rest via light regex on the
 *      card's flattened text.
 * If this returns 0 items, the site's markup likely changed — check the
 * console warning and adjust parseListingPage() accordingly.
 *
 * Usage:
 *   npm install cheerio
 *   node fetch_deviceforum.js                          # scrape EVERYTHING
 *   node fetch_deviceforum.js --out-dir ./feed
 *   node fetch_deviceforum.js --max-pages 5             # testing/limiting
 *   node fetch_deviceforum.js --start-page 10           # resume from page 10
 *   node fetch_deviceforum.js --category 563             # only one category
 *   node fetch_deviceforum.js --download-images          # also download images
 *
 *   # Publish via GitHub Pages instead of hotlinking device-forum.com —
 *   # pass BOTH --download-images and --base-url (your Pages root, no
 *   # trailing slash); RSS items then link to the locally-downloaded copy.
 *   # Same mechanism as fetch_testpoints.js / fetch_edlpoint.js.
 *   node fetch_deviceforum.js --download-images --base-url https://<user>.github.io/<repo>
 *
 * IMAGE DEDUPING
 * ---------------------------------------------------------------------
 * Same approach as the other two scrapers:
 *   - De-duped by media id (and therefore by image_url, which embeds the
 *     id) within a single run.
 *   - A manifest file (deviceforum/images-manifest.json) remembers every
 *     URL already downloaded; already-downloaded files are never
 *     re-fetched on later runs — only genuinely new images cause a new
 *     HTTP request. This matters a lot here: the gallery grows daily and
 *     a full run is thousands of images.
 *   - Local filenames are "<id>_<sanitized original filename>" so they
 *     stay human-readable AND collision-free (id is always unique).
 *   - Images are sharded into subfolders of 1000 ids each (e.g.
 *     "images/0000-0999/", "images/1000-1999/", ...) so no single
 *     directory ever holds more than ~1000 files. This keeps the repo
 *     browsable on GitHub, whose file browser truncates directory
 *     listings at 1,000 entries — with 7,000+ images in one flat
 *     "images/" folder, over 80% of files became invisible in the UI
 *     (though still present in git). Sharding is purely a directory
 *     layout choice: filenameForItem() returns "<shard>/<id>_<name>",
 *     the manifest stores that full relative path, and everything
 *     downstream (RSS, published_image_url) just uses that path as-is.
 *
 * A FULL RUN IS BIG — BE POLITE
 * ---------------------------------------------------------------------
 * At last count this is ~140+ listing pages and 7,000+ images (7.8 GB).
 * Every request carries a short delay (--delay, default 200ms) to avoid
 * hammering the forum. With --download-images a full run WILL take a
 * long time and use a lot of bandwidth/disk — that's inherent to
 * "download literally everything", not a bug. Use --max-pages while
 * testing, and see .github/workflows/scrape.yml's timeout-minutes note
 * for the same trade-off the other two scrapers already made.
 *
 * Output (in --out-dir, default "./feed"):
 *   deviceforum_all.json               - every item, one array
 *   deviceforum_categories.json        - category_id -> {name, url} seen so far
 *   deviceforum_coverage.json          - pages scraped vs. advertised total
 *   deviceforum/images/*.{jpg,webp,..} - downloaded images (only with --download-images)
 *   deviceforum/images-manifest.json   - url -> local file map (skip re-download)
 *   rss_deviceforum.xml                - RSS feed, ALL items, one per image
 */

const fs = require("fs");
const path = require("path");
const https = require("https");
const cheerio = require("cheerio");

const BASE = "https://device-forum.com";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------
function parseArgs() {
  const args = process.argv.slice(2);
  let outDir = "./feed";
  let maxPages = null; // null = no limit, scrape until the last page
  let startPage = 1;
  let categoryId = null; // null = full /media/ gallery, otherwise /media/categories/<id>/
  let downloadImages = false;
  let baseUrl = null;
  let delayMs = 200;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--out-dir") {
      outDir = args[++i];
    } else if (args[i] === "--max-pages") {
      maxPages = parseInt(args[++i], 10);
    } else if (args[i] === "--start-page") {
      startPage = parseInt(args[++i], 10);
    } else if (args[i] === "--category") {
      categoryId = args[++i];
    } else if (args[i] === "--download-images") {
      downloadImages = true;
    } else if (args[i] === "--base-url") {
      baseUrl = args[++i].replace(/\/+$/, "");
    } else if (args[i] === "--delay") {
      delayMs = parseInt(args[++i], 10);
    }
  }
  return { outDir, maxPages, startPage, categoryId, downloadImages, baseUrl, delayMs };
}

// ---------------------------------------------------------------------------
// Helpers (shared conventions with fetch_testpoints.js / fetch_edlpoint.js)
// ---------------------------------------------------------------------------
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function sanitizeFilename(name) {
  return name.replace(/[\\/:*?"<>|]+/g, "_").trim().slice(0, 180);
}

function loadManifest(manifestPath) {
  if (!fs.existsSync(manifestPath)) return new Map();
  try {
    return new Map(Object.entries(JSON.parse(fs.readFileSync(manifestPath, "utf8"))));
  } catch (err) {
    console.warn(`  ! could not read existing manifest (${err.message}), starting fresh`);
    return new Map();
  }
}

function saveManifest(manifestPath, map) {
  fs.writeFileSync(manifestPath, JSON.stringify(Object.fromEntries(map.entries()), null, 2));
}

function escapeXml(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function absUrl(href) {
  if (!href) return "";
  try {
    return new URL(href, BASE).toString();
  } catch {
    return href;
  }
}

function fetchHtml(url) {
  return new Promise((resolve, reject) => {
    https
      .get(
        url,
        { headers: { "User-Agent": USER_AGENT, Accept: "text/html,application/xhtml+xml" } },
        (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            return fetchHtml(absUrl(res.headers.location)).then(resolve, reject);
          }
          if (res.statusCode !== 200) {
            res.resume();
            return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
          }
          let data = "";
          res.setEncoding("utf8");
          res.on("data", (chunk) => (data += chunk));
          res.on("end", () => resolve(data));
        }
      )
      .on("error", reject);
  });
}

function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    https
      .get(url, { headers: { "User-Agent": USER_AGENT } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          file.close();
          fs.unlink(destPath, () => {});
          return downloadFile(absUrl(res.headers.location), destPath).then(resolve, reject);
        }
        if (res.statusCode !== 200) {
          file.close();
          fs.unlink(destPath, () => {});
          return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        }
        res.pipe(file);
        file.on("finish", () => file.close(resolve));
      })
      .on("error", (err) => {
        fs.unlink(destPath, () => {});
        reject(err);
      });
  });
}

/**
 * Shard folder for a given numeric media id, grouping ids in blocks of
 * 1000 so no single directory exceeds ~1000 files, e.g.:
 *   id 42     -> "0000-0999"
 *   id 1234   -> "1000-1999"
 *   id 90501  -> "90000-90999"
 * Non-numeric / unparsable ids fall back to an "other" bucket.
 */
function shardForId(id) {
  const n = parseInt(id, 10);
  if (!Number.isFinite(n) || n < 0) return "other";
  const start = Math.floor(n / 1000) * 1000;
  return `${String(start).padStart(4, "0")}-${String(start + 999).padStart(4, "0")}`;
}

/**
 * Local relative path (inside images/): "<shard>/<id>_<sanitized original
 * filename>". The shard prefix keeps any single directory well under
 * GitHub's 1,000-file listing cap; the "<id>_" prefix keeps filenames
 * unique within a shard (id is always unique).
 */
function filenameForItem(item) {
  let base = sanitizeFilename(item.title || `media_${item.id}`);
  if (!/\.(jpe?g|png|webp|gif|bmp)$/i.test(base)) base += ".jpg";
  return path.join(shardForId(item.id), `${item.id}_${base}`);
}

/**
 * Builds an RSS 2.0 feed, one item per image. Uses `published_image_url`
 * (GitHub-Pages-hosted local copy, set in main() when both --download-images
 * and --base-url are given) when available; otherwise falls back to the
 * original device-forum.com `/media/<id>/full` URL.
 */
function generateRss(items, sourceLabel) {
  const now = new Date().toUTCString();
  let xmlItems = "";

  for (const it of items) {
    const link = it.published_image_url || it.image_url || "";
    let pubDate = now;
    if (it.date_added) {
      const d = new Date(it.date_added);
      if (!isNaN(d.getTime())) pubDate = d.toUTCString();
    }
    xmlItems += `    <item>
      <title>${escapeXml(it.title || `Media ${it.id}`)}</title>
      <link>${escapeXml(it.page_url)}</link>
      <guid isPermaLink="false">deviceforum-media-${it.id}</guid>
      <pubDate>${pubDate}</pubDate>
      <description><![CDATA[
        ${it.category_name ? "Category: " + escapeXml(it.category_name) + "<br/>" : ""}
        ${it.added_by ? "Added by: " + escapeXml(it.added_by) + "<br/>" : ""}
        <img src="${escapeXml(link)}" alt="${escapeXml(it.title || "")}" />
      ]]></description>
      <enclosure url="${escapeXml(link)}" type="image/jpeg" />
    </item>\n`;
  }

  return `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0">
  <channel>
    <generator>fetch_deviceforum.js</generator>
    <title>Device Forum - Media Gallery${sourceLabel ? " (" + escapeXml(sourceLabel) + ")" : ""}</title>
    <link>${BASE}/media/</link>
    <description>Full media gallery feed from device-forum.com — schematics, testpoints, pinouts and board photos, every category, every image.</description>
    <language>en</language>
    <lastBuildDate>${now}</lastBuildDate>
${xmlItems}  </channel>
</rss>
`;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------
/** Highest N found in any /media/page-N (or /media/categories/<id>/page-N) link on the page. */
function findLastPage(html) {
  const re = /\/page-(\d+)/g;
  let max = 1;
  let m;
  while ((m = re.exec(html))) {
    const n = parseInt(m[1], 10);
    if (n > max) max = n;
  }
  return max;
}

function parseListingPage(html) {
  const $ = cheerio.load(html);
  const items = [];
  const seenIds = new Set();

  $('img[src*="/xfmg/thumbnail/"]').each((_, imgEl) => {
    const $img = $(imgEl);
    const $thumbAnchor = $img.closest("a[href]");
    const href = $thumbAnchor.attr("href") || "";
    const idMatch = href.match(/\/media\/(\d+)\/?(?:$|[?#])/);
    if (!idMatch) return;
    const id = idMatch[1];
    if (seenIds.has(id)) return;

    // Walk up until we find the card boundary (contains "View count").
    let $card = $thumbAnchor;
    for (let hop = 0; hop < 8; hop++) {
      const parent = $card.parent();
      if (!parent || parent.length === 0) break;
      $card = parent;
      if (/view count/i.test($card.text())) break;
    }

    const cardHtml = $card;
    const idHref = `/media/${id}/`;

    // Title: the OTHER link to the same id that has real text (not just
    // wrapping the <img>); fall back to the thumbnail's alt attribute.
    let title = "";
    cardHtml.find(`a[href="${idHref}"], a[href="${idHref.slice(0, -1)}"]`).each((_, a) => {
      const t = $(a).text().trim();
      if (t && !title) title = t;
    });
    if (!title) title = ($img.attr("alt") || "").trim();

    // Category: last link to /media/categories/<catId>/ inside the card.
    let categoryId = null;
    let categoryName = null;
    const $catLink = cardHtml.find('a[href*="/media/categories/"]').last();
    if ($catLink && $catLink.length) {
      const catHref = $catLink.attr("href") || "";
      const catMatch = catHref.match(/\/media\/categories\/(\d+)\/?/);
      if (catMatch) categoryId = catMatch[1];
      categoryName = $catLink.text().trim() || null;
    }

    // Added by: first link to /members/<id>/ inside the card.
    let addedBy = null;
    const $memberLink = cardHtml.find('a[href*="/members/"]').first();
    if ($memberLink && $memberLink.length) {
      addedBy = $memberLink.text().trim() || null;
    }

    const blockText = cardHtml.text().replace(/\s+/g, " ").trim();
    const dateMatch = blockText.match(/Date added\s*([A-Za-z]{3,9}\s+\d{1,2},\s*\d{4})/i);
    const viewMatch = blockText.match(/View count\s*([\d,]+)/i);
    const commentMatch = blockText.match(/Comments?\s*(\d+)/i);

    seenIds.add(id);
    items.push({
      id,
      title,
      category_id: categoryId,
      category_name: categoryName,
      page_url: `${BASE}/media/${id}/`,
      thumbnail_url: absUrl($img.attr("src") || $img.attr("data-src") || ""),
      image_url: `${BASE}/media/${id}/full`,
      added_by: addedBy,
      date_added: dateMatch ? dateMatch[1] : null,
      view_count: viewMatch ? parseInt(viewMatch[1].replace(/,/g, ""), 10) : null,
      comment_count: commentMatch ? parseInt(commentMatch[1], 10) : null,
    });
  });

  return items;
}

/** Best-effort: category_id -> {name, url}, parsed from the nav tree present on /media/ pages. */
function parseCategoryTree(html) {
  const $ = cheerio.load(html);
  const map = new Map();
  $('a[href*="/media/categories/"]').each((_, a) => {
    const href = $(a).attr("href") || "";
    const m = href.match(/\/media\/categories\/(\d+)\/?/);
    if (!m) return;
    const name = $(a).text().trim();
    if (name) map.set(m[1], { name, url: absUrl(href) });
  });
  return map;
}

function pageUrl(basePath, n) {
  // basePath already ends with "/", e.g. "/media/" or "/media/categories/563/"
  if (n <= 1) return `${BASE}${basePath}`;
  return `${BASE}${basePath}page-${n}`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const { outDir, maxPages, startPage, categoryId, downloadImages, baseUrl, delayMs } = parseArgs();

  if (baseUrl && !downloadImages) {
    console.warn(
      "  !! --base-url was given without --download-images — RSS items will fall back to the " +
        "original device-forum.com URLs. Add --download-images to actually host images from GitHub Pages."
    );
  }

  fs.mkdirSync(outDir, { recursive: true });
  fs.mkdirSync(path.join(outDir, "deviceforum"), { recursive: true });
  if (downloadImages) {
    fs.mkdirSync(path.join(outDir, "deviceforum", "images"), { recursive: true });
  }

  const basePath = categoryId ? `/media/categories/${categoryId}/` : "/media/";
  const sourceLabel = categoryId ? `category ${categoryId}` : null;

  console.log(`Fetching page 1: ${pageUrl(basePath, 1)}`);
  const firstHtml = await fetchHtml(pageUrl(basePath, 1));
  const advertisedLastPage = findLastPage(firstHtml);
  const lastPage = maxPages ? Math.min(startPage + maxPages - 1, advertisedLastPage) : advertisedLastPage;

  console.log(
    `Site reports ${advertisedLastPage} page(s) total. Scraping page ${startPage}..${lastPage}` +
      (maxPages ? ` (capped by --max-pages ${maxPages})` : " (no cap — full run)") +
      "."
  );

  const categoryTree = parseCategoryTree(firstHtml);

  const allItemsById = new Map();
  let pagesFetched = 0;
  let pagesFailed = 0;

  for (let n = startPage; n <= lastPage; n++) {
    let html;
    if (n === 1 && startPage === 1) {
      html = firstHtml;
    } else {
      const url = pageUrl(basePath, n);
      try {
        html = await fetchHtml(url);
        await sleep(delayMs);
      } catch (err) {
        pagesFailed++;
        console.warn(`  ! failed to fetch page ${n} (${url}): ${err.message}`);
        continue;
      }
    }

    const items = parseListingPage(html);
    if (items.length === 0) {
      console.warn(
        `  ! page ${n}: 0 items parsed — markup may have changed, or this page is genuinely empty. ` +
          `Inspect the HTML and adjust parseListingPage() if this happens on pages that should have content.`
      );
    }
    for (const it of items) {
      if (!allItemsById.has(it.id)) allItemsById.set(it.id, it);
    }
    // Pick up any category names/ids not already known (cheap, page text we already have).
    for (const [cid, info] of parseCategoryTree(html)) {
      if (!categoryTree.has(cid)) categoryTree.set(cid, info);
    }

    pagesFetched++;
    if (n % 10 === 0 || n === lastPage) {
      console.log(`  ... page ${n}/${lastPage} done, ${allItemsById.size} unique item(s) so far`);
    }
  }

  const allItems = [...allItemsById.values()];
  console.log(`\nCollected ${allItems.length} unique item(s) across ${pagesFetched} page(s).`);
  if (pagesFailed) console.warn(`  ${pagesFailed} page(s) failed to fetch and were skipped.`);

  // -------------------------------------------------------------------
  // Download images once per unique media id — never twice, ever.
  // -------------------------------------------------------------------
  if (downloadImages) {
    const imagesDir = path.join(outDir, "deviceforum", "images");
    const manifestPath = path.join(imagesDir, "images-manifest.json");
    const manifest = loadManifest(manifestPath);

    console.log(`\nDownloading images: ${allItems.length} item(s).`);
    let downloaded = 0;
    let skippedExisting = 0;
    let failed = 0;

    for (const it of allItems) {
      const url = it.image_url;
      const relPath = path.join("images", filenameForItem(it));
      const dest = path.join(outDir, "deviceforum", relPath);

      const existingRel = manifest.get(url);
      if (existingRel && fs.existsSync(path.join(outDir, "deviceforum", existingRel))) {
        skippedExisting++;
        continue;
      }
      if (fs.existsSync(dest)) {
        manifest.set(url, relPath);
        skippedExisting++;
        continue;
      }

      try {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        await downloadFile(url, dest);
        manifest.set(url, relPath);
        downloaded++;
      } catch (err) {
        failed++;
        console.warn(`  ! failed to download ${url}: ${err.message}`);
      }
      await sleep(delayMs);
    }

    saveManifest(manifestPath, manifest);
    console.log(
      `Images: ${downloaded} newly downloaded, ${skippedExisting} already present (skipped), ${failed} failed.`
    );

    const pagesPrefix = outDir.replace(/^\.\/?/, "").split(path.sep).filter(Boolean).join("/");
    for (const it of allItems) {
      const rel = manifest.get(it.image_url);
      if (!rel) continue;
      const relPosix = rel.split(path.sep).join("/");
      it.local_image_path = `deviceforum/${relPosix}`;
      if (baseUrl) {
        it.published_image_url = [baseUrl, pagesPrefix, "deviceforum", relPosix].filter(Boolean).join("/");
      }
    }
  }

  fs.writeFileSync(path.join(outDir, "deviceforum_all.json"), JSON.stringify(allItems, null, 2));
  fs.writeFileSync(
    path.join(outDir, "deviceforum_categories.json"),
    JSON.stringify(Object.fromEntries(categoryTree.entries()), null, 2)
  );
  fs.writeFileSync(
    path.join(outDir, "deviceforum_coverage.json"),
    JSON.stringify(
      {
        source: categoryId ? `${BASE}/media/categories/${categoryId}/` : `${BASE}/media/`,
        advertised_last_page: advertisedLastPage,
        pages_fetched: pagesFetched,
        pages_failed: pagesFailed,
        items_collected: allItems.length,
      },
      null,
      2
    )
  );

  const rssXml = generateRss(allItems, sourceLabel);
  const rssPath = path.join(outDir, "rss_deviceforum.xml");
  fs.writeFileSync(rssPath, rssXml);

  const publishedCount = allItems.filter((it) => it.published_image_url).length;
  console.log(`\nDone. ${allItems.length} total item(s).`);
  console.log(`Written to ${path.join(outDir, "deviceforum_all.json")}`);
  console.log(`RSS feed: ${rssPath}`);
  if (baseUrl) {
    console.log(
      `RSS images point at GitHub Pages (${baseUrl}) for ${publishedCount}/${allItems.length} item(s)` +
        (publishedCount < allItems.length ? " — the rest fall back to device-forum.com." : ".")
    );
  } else {
    console.log(`RSS images point at the original device-forum.com URLs (no --base-url given).`);
  }
  if (advertisedLastPage > lastPage) {
    console.log(
      `\nNote: site has ${advertisedLastPage} pages total, only scraped up to page ${lastPage} ` +
        `(--max-pages was set). Re-run with --start-page ${lastPage + 1} to continue, or drop ` +
        `--max-pages for a full run.`
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
