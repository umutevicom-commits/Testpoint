#!/usr/bin/env node
/**
 * fetch_testpoints.js
 *
 * Scraper for https://sigmakey.com/en/sigma-help/testpoints-pinouts/
 * (Sigma / SigmaKey Testpoints & Pinouts archive).
 *
 * WHY PUPPETEER (not plain https + regex like fetch_roms.js):
 * ---------------------------------------------------------------------
 * The page renders only the first batch of items server-side. The
 * brand/platform counters shown in the nav (e.g. "Motorola (14)") do
 * NOT match what a plain GET request returns (e.g. only 9 items) —
 * the rest load client-side as you scroll ("infinite scroll"). A raw
 * fetch() therefore silently misses items. This script drives a real
 * (headless) Chromium tab, scrolls to the bottom repeatedly until no
 * new items appear (or the counter target is reached), then reads the
 * fully-loaded DOM.
 *
 * WHAT IT COLLECTS
 * ---------------------------------------------------------------------
 * For every brand shown on the page, and every platform sub-tab under
 * that brand (Exynos / MTK / Qualcomm / HiSilicon / ADB Mode / etc.),
 * it collects each card's:
 *   - title      -> the caption text under the thumbnail
 *                   e.g. "Huawei, ADB Mode, ABR-AL00"
 *   - image_url  -> absolute URL of the full-size testpoint image
 *                   (the <a href> the thumbnail links to, under
 *                   /content/nfs/testpoints/...)
 *
 * Usage:
 *   npm install puppeteer
 *   node fetch_testpoints.js                     # scrape every brand
 *   node fetch_testpoints.js --brands Huawei,Samsung
 *   node fetch_testpoints.js --out-dir ./feed
 *   node fetch_testpoints.js --download-images    # also download the jpgs
 *
 *   # Publish via GitHub Pages instead of hotlinking sigmakey.com — pass
 *   # BOTH --download-images and --base-url (your Pages root, no trailing
 *   # slash); RSS items then link to the locally-downloaded copy instead of
 *   # the original sigmakey.com URL. See fetch_edlpoint.js's header comment
 *   # for the full explanation — same mechanism, same --base-url flag.
 *   node fetch_testpoints.js --download-images --base-url https://<user>.github.io/<repo>
 *
 * IMAGE DEDUPING
 * ---------------------------------------------------------------------
 * Downloads are deduped by the remote image URL, not by brand/title:
 *   - Within a single run, if the same image_url is referenced by more
 *     than one card (this happens on the site — the same photo is
 *     sometimes reused across multiple model listings), it is only
 *     downloaded once.
 *   - Across runs, a manifest file (testpoints/images-manifest.json)
 *     records every URL already downloaded and the local file it lives
 *     in. On the next run (e.g. the next day's cron), any URL already
 *     in the manifest with its file still present on disk is skipped —
 *     it is never re-downloaded. Only genuinely new images cause a new
 *     HTTP request.
 *   - Local filenames are derived from the remote URL itself (not from
 *     brand+title), so the same remote image always maps to the same
 *     local file regardless of which title(s) reference it.
 *
 * Output (in --out-dir, default "./feed"):
 *   testpoints_all.json               - every item, all brands, one array
 *   testpoints_coverage.json          - collected vs. badge count per brand
 *   testpoints/<Brand>.json           - per-brand item list
 *   testpoints/images/*.jpg           - downloaded images (only with --download-images)
 *   testpoints/images-manifest.json   - url -> local file map, used to skip
 *                                        re-downloading already-fetched images
 */

const fs = require("fs");
const path = require("path");
const https = require("https");

const BASE = "https://sigmakey.com";
const LIST_URL = `${BASE}/en/sigma-help/testpoints-pinouts/`;
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------
function parseArgs() {
  const args = process.argv.slice(2);
  let outDir = "./feed";
  let brandFilter = null; // null = all brands
  let downloadImages = false;
  let headless = true;
  let baseUrl = null; // GitHub Pages root, e.g. https://user.github.io/repo (no trailing slash)

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--out-dir") {
      outDir = args[++i];
    } else if (args[i] === "--brands") {
      brandFilter = args[++i].split(",").map((s) => s.trim().toLowerCase());
    } else if (args[i] === "--download-images") {
      downloadImages = true;
    } else if (args[i] === "--no-headless") {
      headless = false;
    } else if (args[i] === "--base-url") {
      baseUrl = args[++i].replace(/\/+$/, "");
    }
  }
  return { outDir, brandFilter, downloadImages, headless, baseUrl };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function sanitizeFilename(name) {
  return name.replace(/[\\/:*?"<>|]+/g, "_").slice(0, 180);
}

function shortHash(str) {
  // Small, dependency-free non-crypto hash — only used to disambiguate
  // filename collisions, not for security.
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}

/** Derives a stable local filename from the remote image URL itself. */
function filenameForUrl(url) {
  let base;
  try {
    base = decodeURIComponent(path.basename(new URL(url).pathname));
  } catch {
    base = path.basename(url);
  }
  base = sanitizeFilename(base);
  if (!base) base = `image_${shortHash(url)}.jpg`;
  return base;
}

function loadManifest(manifestPath) {
  if (!fs.existsSync(manifestPath)) return new Map();
  try {
    const raw = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const map = new Map();
    for (const [url, relPath] of Object.entries(raw)) {
      map.set(url, relPath);
    }
    return map;
  } catch (err) {
    console.warn(`  ! could not read existing manifest (${err.message}), starting fresh`);
    return new Map();
  }
}

function saveManifest(manifestPath, map) {
  const obj = Object.fromEntries(map.entries());
  fs.writeFileSync(manifestPath, JSON.stringify(obj, null, 2));
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

/**
 * Builds an RSS 2.0 feed from the collected testpoint/pinout items.
 * Uses each item's `published_image_url` (the GitHub-Pages-hosted local
 * copy, set in main() when both --download-images and --base-url are
 * given) when available; otherwise falls back to the original sigmakey.com
 * `image_url`.
 */
function generateRss(items) {
  const now = new Date().toUTCString();
  let xmlItems = "";

  for (const it of items) {
    const link = it.published_image_url || it.image_url || "";
    xmlItems += `    <item>
      <title>${escapeXml(it.title || `${it.brand} ${it.platform || ""}`.trim())}</title>
      <link>${escapeXml(link)}</link>
      <guid isPermaLink="false">${escapeXml(link)}</guid>
      <pubDate>${now}</pubDate>
      <description><![CDATA[
        Brand: ${escapeXml(it.brand)}
        ${it.platform ? "<br/>Platform: " + escapeXml(it.platform) : ""}
        <br/><img src="${escapeXml(link)}" alt="${escapeXml(it.title || "")}" />
      ]]></description>
      <enclosure url="${escapeXml(link)}" type="image/jpeg" />
    </item>\n`;
  }

  return `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0">
  <channel>
    <generator>fetch_testpoints.js</generator>
    <title>Testpoints / Pinouts Archive</title>
    <link>https://sigmakey.com/en/sigma-help/testpoints-pinouts/</link>
    <description>Sigma / SigmaKey Testpoints &amp; Pinouts archive feed.</description>
    <language>en</language>
    <lastBuildDate>${now}</lastBuildDate>
${xmlItems}  </channel>
</rss>
`;
}

function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    https
      .get(url, { headers: { "User-Agent": USER_AGENT } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          file.close();
          fs.unlinkSync(destPath);
          return downloadFile(res.headers.location, destPath).then(resolve, reject);
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

// ---------------------------------------------------------------------------
// Main scraping logic
// ---------------------------------------------------------------------------
async function getBrandList(page) {
  await page.goto(LIST_URL, { waitUntil: "networkidle2", timeout: 60000 });
  // Brand pills at the top of the results list, e.g.:
  // <a href="?brand=4">Huawei (968)</a>
  return page.evaluate(() => {
    const out = [];
    document.querySelectorAll('a[href*="?brand="]').forEach((a) => {
      const href = a.getAttribute("href") || "";
      const m = href.match(/[?&]brand=(\d+)(?!.*platform)/);
      // Only top-level brand links (no &platform= in them) carry the count.
      if (!m || href.includes("platform=")) return;
      const text = a.textContent.trim();
      const countMatch = text.match(/\((\d+)\)\s*$/);
      if (!countMatch) return;
      out.push({
        id: m[1],
        name: text.replace(/\s*\(\d+\)\s*$/, "").trim(),
        count: parseInt(countMatch[1], 10),
      });
    });
    // De-dupe by id
    const seen = new Set();
    return out.filter((b) => (seen.has(b.id) ? false : (seen.add(b.id), true)));
  });
}

async function getPlatformTabs(page) {
  // Sub-tabs like Exynos / MTK / Qualcomm / ADB Mode / HiSilicon, e.g.:
  // <a href="?brand=143&platform=8">Exynos</a>
  return page.evaluate(() => {
    const out = [];
    document.querySelectorAll('a[href*="platform="]').forEach((a) => {
      const href = a.getAttribute("href") || "";
      const m = href.match(/platform=(\d+)/);
      if (!m) return;
      out.push({ platformId: m[1], label: a.textContent.trim() });
    });
    const seen = new Set();
    return out.filter((p) =>
      seen.has(p.platformId) ? false : (seen.add(p.platformId), true)
    );
  });
}

async function scrapeCurrentGrid(page) {
  return page.evaluate((BASE) => {
    const items = [];
    // Each card: <a href="/content/nfs/testpoints/....jpg"><img ...></a>
    // followed by a sibling/nearby text node with the same caption.
    document
      .querySelectorAll('a[href*="/content/nfs/testpoints/"]')
      .forEach((a) => {
        const href = a.getAttribute("href");
        if (!href) return;
        const img = a.querySelector("img");
        const alt = img ? img.getAttribute("alt") || "" : "";
        // The caption is usually rendered as a text block right after the
        // link/figure — walk forward until we find non-empty text.
        let caption = alt.trim();
        if (!caption) {
          let node = a.closest("figure, div") || a;
          let sib = node.nextElementSibling;
          for (let i = 0; i < 3 && sib; i++, sib = sib.nextElementSibling) {
            const t = sib.textContent.trim();
            if (t) {
              caption = t;
              break;
            }
          }
        }
        const imageUrl = href.startsWith("http") ? href : BASE + href;
        items.push({ title: caption, image_url: imageUrl });
      });
    return items;
  }, BASE);
}

/**
 * Scrolls the page repeatedly, re-reading the grid each time, until the
 * item count stops growing (two consecutive scrolls with no new items)
 * or we've hit the brand's advertised total count.
 */
async function scrapeWithScroll(page, targetCount, maxIdleRounds = 4) {
  let collected = new Map(); // key: image_url -> item
  let idleRounds = 0;
  let lastCount = -1;

  for (let round = 0; round < 200; round++) {
    const items = await scrapeCurrentGrid(page);
    items.forEach((it) => collected.set(it.image_url, it));

    if (targetCount && collected.size >= targetCount) break;
    if (collected.size === lastCount) {
      idleRounds++;
      if (idleRounds >= maxIdleRounds) break;
    } else {
      idleRounds = 0;
    }
    lastCount = collected.size;

    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await sleep(900);

    // Some sites use a "Load more" button instead of/along with scroll.
    const clicked = await page.evaluate(() => {
      const btn = [...document.querySelectorAll("button, a")].find((el) =>
        /load more|show more|daha fazla/i.test(el.textContent || "")
      );
      if (btn) {
        btn.click();
        return true;
      }
      return false;
    });
    if (clicked) await sleep(900);
  }

  return [...collected.values()];
}

async function main() {
  const { outDir, brandFilter, downloadImages, headless, baseUrl } = parseArgs();

  if (baseUrl && !downloadImages) {
    console.warn(
      "  !! --base-url was given without --download-images — there will be no local files to " +
        "publish, so RSS items will fall back to the original sigmakey.com image URLs. Add " +
        "--download-images to actually host images from GitHub Pages."
    );
  }
  const puppeteer = require("puppeteer");

  fs.mkdirSync(outDir, { recursive: true });
  fs.mkdirSync(path.join(outDir, "testpoints"), { recursive: true });
  if (downloadImages) {
    fs.mkdirSync(path.join(outDir, "testpoints", "images"), { recursive: true });
  }

  const browser = await puppeteer.launch({
    headless: headless ? "new" : false,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
  const page = await browser.newPage();
  await page.setUserAgent(USER_AGENT);
  await page.setViewport({ width: 1366, height: 900 });

  console.log("Fetching brand list...");
  let brands = await getBrandList(page);
  if (brandFilter) {
    brands = brands.filter((b) => brandFilter.includes(b.name.toLowerCase()));
  }
  console.log(`Found ${brands.length} brand(s) to scrape.`);

  const allItems = [];
  const coverage = [];

  for (const brand of brands) {
    const brandUrl = `${LIST_URL}?brand=${brand.id}`;
    console.log(`\n=== ${brand.name} (advertised ${brand.count}) -> ${brandUrl}`);
    await page.goto(brandUrl, { waitUntil: "networkidle2", timeout: 60000 });

    const platforms = await getPlatformTabs(page);
    let brandItems = [];

    if (platforms.length === 0) {
      brandItems = await scrapeWithScroll(page, brand.count);
    } else {
      // Scrape each platform tab separately (more reliable than trying to
      // lazy-load a combined multi-platform grid), then merge + de-dupe.
      const seen = new Map();
      for (const plat of platforms) {
        const url = `${LIST_URL}?brand=${brand.id}&platform=${plat.platformId}`;
        console.log(`  - ${plat.label}: ${url}`);
        await page.goto(url, { waitUntil: "networkidle2", timeout: 60000 });
        const items = await scrapeWithScroll(page, null);
        items.forEach((it) =>
          seen.set(it.image_url, { ...it, brand: brand.name, platform: plat.label })
        );
        await sleep(300);
      }
      brandItems = [...seen.values()];
    }

    brandItems = brandItems.map((it) => ({
      brand: brand.name,
      platform: it.platform || null,
      title: it.title,
      image_url: it.image_url,
    }));

    console.log(`  -> collected ${brandItems.length} item(s) for ${brand.name}`);
    if (brand.count && brandItems.length < brand.count) {
      console.warn(
        `  !! WARNING: nav badge says ${brand.count} but only ${brandItems.length} were collected for ${brand.name}. ` +
          `Possible missed items (slow load, or a "Load more" button the script didn't detect). ` +
          `Re-run with --no-headless --brands "${brand.name}" to watch it happen and adjust selectors/timing if needed.`
      );
    } else if (brand.count && brandItems.length > brand.count) {
      console.log(
        `  (note: collected more than the badge count — badge may be stale, or duplicates weren't fully de-duped across platforms)`
      );
    }

    fs.writeFileSync(
      path.join(outDir, "testpoints", `${sanitizeFilename(brand.name)}.json`),
      JSON.stringify(brandItems, null, 2)
    );

    allItems.push(...brandItems);
    coverage.push({
      brand: brand.name,
      badge_count: brand.count,
      collected_count: brandItems.length,
      complete: brand.count ? brandItems.length >= brand.count : null,
    });
  }

  // -------------------------------------------------------------------
  // Download images once per unique remote URL — never twice, ever.
  // -------------------------------------------------------------------
  if (downloadImages) {
    const imagesDir = path.join(outDir, "testpoints", "images");
    const manifestPath = path.join(imagesDir, "images-manifest.json");
    const manifest = loadManifest(manifestPath);

    // De-dupe by URL across the WHOLE run (all brands combined) first —
    // the same photo is sometimes reused across multiple model listings.
    const uniqueUrls = [...new Set(allItems.map((it) => it.image_url))];
    console.log(
      `\nDownloading images: ${uniqueUrls.length} unique URL(s) out of ${allItems.length} item(s).`
    );

    const usedFilenames = new Set(manifest.values());
    let downloaded = 0;
    let skippedExisting = 0;
    let failed = 0;

    for (const url of uniqueUrls) {
      const existingRel = manifest.get(url);
      const existingAbs = existingRel ? path.join(outDir, "testpoints", existingRel) : null;

      if (existingRel && fs.existsSync(existingAbs)) {
        skippedExisting++;
        continue; // already downloaded in a previous run — do not re-fetch
      }

      let fname = filenameForUrl(url);
      let relPath = path.join("images", fname);
      // Guard against two different URLs sanitizing to the same filename.
      if (usedFilenames.has(relPath) && !existingRel) {
        fname = `${shortHash(url)}_${fname}`;
        relPath = path.join("images", fname);
      }
      const dest = path.join(outDir, "testpoints", relPath);

      if (fs.existsSync(dest)) {
        // File is already there (e.g. manifest was stale/missing) — trust
        // it and just record it, no re-download.
        manifest.set(url, relPath);
        usedFilenames.add(relPath);
        skippedExisting++;
        continue;
      }

      try {
        await downloadFile(url, dest);
        manifest.set(url, relPath);
        usedFilenames.add(relPath);
        downloaded++;
      } catch (err) {
        failed++;
        console.warn(`  ! failed to download ${url}: ${err.message}`);
      }
      await sleep(150);
    }

    saveManifest(manifestPath, manifest);

    console.log(
      `Images: ${downloaded} newly downloaded, ${skippedExisting} already present (skipped), ${failed} failed.`
    );

    // Attach the local path (and, if --base-url was given, the GitHub Pages
    // published URL) to every item that references a downloaded image.
    // pagesPrefix = --out-dir relative to the repo root, posix-style, e.g.
    // "./feed" -> "feed" — GitHub Pages serves the whole repo from "/".
    const pagesPrefix = outDir.replace(/^\.\/?/, "").split(path.sep).filter(Boolean).join("/");
    for (const it of allItems) {
      const rel = manifest.get(it.image_url);
      if (!rel) continue;
      const relPosix = rel.split(path.sep).join("/");
      it.local_image_path = `testpoints/${relPosix}`;
      if (baseUrl) {
        it.published_image_url = [baseUrl, pagesPrefix, "testpoints", relPosix]
          .filter(Boolean)
          .join("/");
      }
    }
    // Re-write per-brand JSON files now that local_image_path is known.
    const byBrand = new Map();
    for (const it of allItems) {
      if (!byBrand.has(it.brand)) byBrand.set(it.brand, []);
      byBrand.get(it.brand).push(it);
    }
    for (const [brandName, items] of byBrand) {
      fs.writeFileSync(
        path.join(outDir, "testpoints", `${sanitizeFilename(brandName)}.json`),
        JSON.stringify(items, null, 2)
      );
    }
  }

  fs.writeFileSync(
    path.join(outDir, "testpoints_all.json"),
    JSON.stringify(allItems, null, 2)
  );
  fs.writeFileSync(
    path.join(outDir, "testpoints_coverage.json"),
    JSON.stringify(coverage, null, 2)
  );

  const rssXml = generateRss(allItems);
  const rssPath = path.join(outDir, "rss.xml");
  fs.writeFileSync(rssPath, rssXml);

  const incomplete = coverage.filter((c) => c.complete === false);
  const publishedCount = allItems.filter((it) => it.published_image_url).length;
  console.log(`\nDone. ${allItems.length} total item(s) across ${brands.length} brand(s).`);
  console.log(`Written to ${path.join(outDir, "testpoints_all.json")}`);
  console.log(`Coverage report: ${path.join(outDir, "testpoints_coverage.json")}`);
  console.log(`RSS feed: ${rssPath}`);
  if (baseUrl) {
    console.log(
      `RSS images point at GitHub Pages (${baseUrl}) for ${publishedCount}/${allItems.length} item(s)` +
        (publishedCount < allItems.length ? " — the rest fall back to sigmakey.com." : ".")
    );
  } else {
    console.log(`RSS images point at the original sigmakey.com URLs (no --base-url given).`);
  }
  if (incomplete.length) {
    console.warn(
      `\n${incomplete.length} brand(s) look INCOMPLETE (collected < badge count):`
    );
    incomplete.forEach((c) =>
      console.warn(`  - ${c.brand}: ${c.collected_count}/${c.badge_count}`)
    );
  } else {
    console.log(`\nAll brands matched or exceeded their badge count. ✔`);
  }

  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
