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
 * Output (in --out-dir, default "./feed"):
 *   testpoints_all.json          - every item, all brands, one array
 *   testpoints/<Brand>.json      - per-brand item list
 *   testpoints/images/*.jpg      - downloaded images (only with --download-images)
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

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--out-dir") {
      outDir = args[++i];
    } else if (args[i] === "--brands") {
      brandFilter = args[++i].split(",").map((s) => s.trim().toLowerCase());
    } else if (args[i] === "--download-images") {
      downloadImages = true;
    } else if (args[i] === "--no-headless") {
      headless = false;
    }
  }
  return { outDir, brandFilter, downloadImages, headless };
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
  const { outDir, brandFilter, downloadImages, headless } = parseArgs();
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

    fs.writeFileSync(
      path.join(outDir, "testpoints", `${sanitizeFilename(brand.name)}.json`),
      JSON.stringify(brandItems, null, 2)
    );

    if (downloadImages) {
      for (const it of brandItems) {
        const ext = path.extname(new URL(it.image_url).pathname) || ".jpg";
        const fname = sanitizeFilename(`${brand.name}_${it.title}${ext}`);
        const dest = path.join(outDir, "testpoints", "images", fname);
        if (fs.existsSync(dest)) continue;
        try {
          await downloadFile(it.image_url, dest);
        } catch (err) {
          console.warn(`    ! failed to download ${it.image_url}: ${err.message}`);
        }
        await sleep(150);
      }
    }

    allItems.push(...brandItems);
  }

  fs.writeFileSync(
    path.join(outDir, "testpoints_all.json"),
    JSON.stringify(allItems, null, 2)
  );

  console.log(`\nDone. ${allItems.length} total item(s) across ${brands.length} brand(s).`);
  console.log(`Written to ${path.join(outDir, "testpoints_all.json")}`);

  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
