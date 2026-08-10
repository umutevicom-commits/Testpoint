#!/usr/bin/env node
/**
 * fetch_edlpoint.js
 *
 * Scraper for https://miuirom.org/updates/edl-point
 * (EDL / Test Point image archive for Xiaomi, Mi, REDMI, POCO phones).
 *
 * WHY PLAIN HTTPS (not Puppeteer like fetch_testpoints.js):
 * ---------------------------------------------------------------------
 * Unlike sigmakey.com's Testpoints/Pinouts page (infinite scroll, needs a
 * real browser tab), this page renders ALL devices server-side in one shot
 * — no lazy loading, no "load more" button, no client-side pagination. A
 * single https.get() + HTML parse (cheerio) is enough, same philosophy as
 * fetch_roms.js used for ximitime.com.
 *
 * WHAT IT COLLECTS
 * ---------------------------------------------------------------------
 * The page has three sections (each an <h2>): "Xiaomi EDL Point",
 * "REDMI EDL Point", "POCO EDL Point". Under each, every device is a
 * clickable thumbnail that opens the full-size test-point photo in a
 * popup, e.g.:
 *
 *   thumbnail: https://miuirom.org/wp-content/uploads/test-point/mi-redmi-7a-edl-point-250x148.jpg
 *   full image (popup target): https://miuirom.org/wp-content/uploads/test-point/mi-redmi-7a-edl-point.jpg
 *
 * next to the device name (linking to its firmware page), codename, and
 * model number(s). For every device we collect:
 *   - section      -> "Xiaomi" | "REDMI" | "POCO"
 *   - title        -> device name, e.g. "REDMI 7A"
 *   - codename     -> e.g. "pine"
 *   - models       -> e.g. "M1903C3EG, M1903C3EH, ..."
 *   - image_url    -> absolute URL of the full-size test point image
 *                     (the popup target, NOT the small thumbnail)
 *   - thumbnail_url-> absolute URL of the small (250x148) thumbnail
 *   - phone_url    -> absolute URL of the device's firmware page
 *
 * Usage:
 *   npm install cheerio
 *   node fetch_edlpoint.js                        # scrape everything
 *   node fetch_edlpoint.js --sections Xiaomi,POCO  # only some sections
 *   node fetch_edlpoint.js --out-dir ./feed
 *   node fetch_edlpoint.js --download-images       # also download the jpgs
 *
 *   # Publish via GitHub Pages instead of hotlinking miuirom.org:
 *   node fetch_edlpoint.js --download-images \
 *     --base-url https://<user>.github.io/<repo>
 *
 * PUBLISHING IMAGES FROM GITHUB PAGES (not the source site)
 * ---------------------------------------------------------------------
 * By default the RSS <link>/<enclosure> for each item points at the ORIGINAL
 * miuirom.org image URL. Pass BOTH --download-images AND --base-url to
 * change that: images are downloaded into --out-dir (as before), and every
 * RSS item then points at the GitHub Pages URL of the locally-downloaded
 * copy instead — e.g.
 *   https://<user>.github.io/<repo>/feed/edlpoint/images/mi-redmi-7a-edl-point.jpg
 * instead of
 *   https://miuirom.org/wp-content/uploads/test-point/mi-redmi-7a-edl-point.jpg
 * --base-url must be the root URL your GitHub Pages site is served from
 * (no trailing slash) — see .github/workflows/scrape.yml, which computes
 * this automatically from the repository name. If --base-url is omitted
 * (or --download-images isn't set), the script falls back to the original
 * miuirom.org URL for that item and prints a warning explaining why.
 *
 * IMAGE DEDUPING
 * ---------------------------------------------------------------------
 * Same approach as fetch_testpoints.js:
 *   - De-duped by remote image_url within a single run.
 *   - A manifest file (edlpoint/images-manifest.json) remembers every URL
 *     already downloaded; already-downloaded files are never re-fetched on
 *     later runs, only genuinely new images cause a new HTTP request.
 *   - Local filenames are derived from the remote URL itself.
 *
 * Output (in --out-dir, default "./feed"):
 *   edlpoint_all.json                 - every item, all sections, one array
 *                                        (image_url = source; published_image_url
 *                                        = what the RSS actually links to)
 *   edlpoint/<Section>.json           - per-section item list (Xiaomi/REDMI/POCO)
 *   edlpoint/images/*.jpg             - downloaded images (only with --download-images)
 *   edlpoint/images-manifest.json     - url -> local file map (skip re-download)
 *   rss_edlpoint.xml                  - RSS feed, one item per device, image + title
 */

const fs = require("fs");
const path = require("path");
const https = require("https");

const BASE = "https://miuirom.org";
const PAGE_URL = `${BASE}/updates/edl-point`;
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------
function parseArgs() {
  const args = process.argv.slice(2);
  let outDir = "./feed";
  let sectionFilter = null; // null = all sections
  let downloadImages = false;
  let baseUrl = null; // GitHub Pages root, e.g. https://user.github.io/repo (no trailing slash)

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--out-dir") {
      outDir = args[++i];
    } else if (args[i] === "--sections") {
      sectionFilter = args[++i].split(",").map((s) => s.trim().toLowerCase());
    } else if (args[i] === "--download-images") {
      downloadImages = true;
    } else if (args[i] === "--base-url") {
      baseUrl = args[++i].replace(/\/+$/, "");
    }
  }
  return { outDir, sectionFilter, downloadImages, baseUrl };
}

// ---------------------------------------------------------------------------
// Helpers (shared conventions with fetch_testpoints.js)
// ---------------------------------------------------------------------------
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function sanitizeFilename(name) {
  return name.replace(/[\\/:*?"<>|]+/g, "_").slice(0, 180);
}

function shortHash(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}

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
    return new Map(Object.entries(raw));
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
      .get(url, { headers: { "User-Agent": USER_AGENT } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return fetchHtml(absUrl(res.headers.location)).then(resolve, reject);
        }
        if (res.statusCode !== 200) {
          return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        }
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => resolve(data));
      })
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
          fs.unlinkSync(destPath);
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
 * Builds an RSS 2.0 feed: one item per device, image as the link/enclosure.
 * Uses each item's `published_image_url` (the GitHub-Pages-hosted local
 * copy) when available; otherwise falls back to the original miuirom.org
 * `image_url` — see the "PUBLISHING IMAGES FROM GITHUB PAGES" note at the
 * top of this file for how to make published_image_url get set.
 */
function generateRss(items) {
  const now = new Date().toUTCString();
  let xmlItems = "";

  for (const it of items) {
    const link = it.published_image_url || it.image_url || "";
    const title = `${it.title} EDL Point`;
    xmlItems += `    <item>
      <title>${escapeXml(title)}</title>
      <link>${escapeXml(link)}</link>
      <guid isPermaLink="false">${escapeXml(link)}</guid>
      <pubDate>${now}</pubDate>
      <description><![CDATA[
        Section: ${escapeXml(it.section)}
        ${it.codename ? "<br/>Codename: " + escapeXml(it.codename) : ""}
        ${it.models ? "<br/>Model(s): " + escapeXml(it.models) : ""}
        ${it.phone_url ? `<br/>Firmware page: ${escapeXml(it.phone_url)}` : ""}
        <br/><img src="${escapeXml(link)}" alt="${escapeXml(title)}" />
      ]]></description>
      <enclosure url="${escapeXml(link)}" type="image/jpeg" />
    </item>\n`;
  }

  return `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0">
  <channel>
    <generator>fetch_edlpoint.js</generator>
    <title>EDL Point / Test Point Archive - Xiaomi, Mi, REDMI, POCO</title>
    <link>${PAGE_URL}</link>
    <description>EDL (Emergency Download) test point images for Xiaomi, Mi, REDMI, and POCO devices, from miuirom.org.</description>
    <language>en</language>
    <lastBuildDate>${now}</lastBuildDate>
${xmlItems}  </channel>
</rss>
`;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------
/**
 * Flattens the DOM into a linear, document-order token stream. We deliberately
 * do NOT rely on any wrapper class name (Elementor/theme markup can change
 * without notice) — only on the two stable facts we actually know about this
 * page's markup:
 *   - the full-size test point photo is linked via
 *     <a href=".../wp-content/uploads/test-point/....jpg">
 *   - the device name is linked via <a href=".../phones/<slug>">
 * Everything else (codename, model numbers) is just plain text that follows
 * the device-name link, before the next thumbnail. This mirrors the
 * "walk forward through what comes next" resilience approach
 * fetch_testpoints.js uses for its captions, but doc-order based instead of
 * sibling-based, since we don't know the real wrapper nesting here.
 */
function linearize($) {
  const tokens = [];

  function walk(node) {
    if (!node) return;
    if (node.type === "tag") {
      const tag = (node.tagName || node.name || "").toLowerCase();
      if (tag === "script" || tag === "style" || tag === "noscript") return;
      if (tag === "h2") {
        tokens.push({ type: "h2", text: $(node).text().trim() });
        return; // heading text captured whole, don't descend
      }
      if (tag === "br") {
        tokens.push({ type: "text", text: "\n" });
        return;
      }
      if (tag === "a") {
        const href = $(node).attr("href") || "";
        if (/\/wp-content\/uploads\/test-point\//i.test(href)) {
          const img = $(node).find("img").first();
          tokens.push({
            type: "image",
            href,
            alt: (img.attr("alt") || "").trim(),
            src: img.attr("src") || img.attr("data-src") || "",
          });
          return; // don't descend into the <img> as separate text
        }
        if (/\/phones\//i.test(href)) {
          tokens.push({ type: "phone", href, text: $(node).text().trim() });
          return;
        }
        // other links (nav, language switcher, etc.) — fall through and
        // descend normally so we don't lose/garble surrounding text flow.
      }
      $(node)
        .contents()
        .each((_, child) => walk(child));
    } else if (node.type === "text") {
      const t = (node.data || "").trim();
      if (t) tokens.push({ type: "text", text: t });
    }
  }

  $("body")
    .contents()
    .each((_, child) => walk(child));

  return tokens;
}

function parseEdlPoints(html, sectionFilter) {
  const cheerio = require("cheerio");
  const $ = cheerio.load(html);
  const tokens = linearize($);

  const items = [];
  const seenImageUrls = new Set();
  let currentSection = null;

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];

    if (tok.type === "h2") {
      // "Xiaomi EDL Point" -> "Xiaomi", "REDMI EDL Point" -> "REDMI"
      if (/edl point$/i.test(tok.text)) {
        currentSection = tok.text.replace(/\s*edl point\s*$/i, "").trim();
      }
      continue;
    }

    if (tok.type !== "image") continue;

    const imageUrl = absUrl(tok.href);
    if (!imageUrl || seenImageUrls.has(imageUrl)) continue;
    seenImageUrls.add(imageUrl);
    const thumbnailUrl = absUrl(tok.src);
    const altTitle = tok.alt.replace(/\s*test point\s*$/i, "").trim();

    // Look ahead (bounded) for the device-name link that belongs to this
    // thumbnail — normally the very next token.
    let phoneTok = null;
    let j = i + 1;
    for (; j < tokens.length && j < i + 6; j++) {
      if (tokens[j].type === "image" || tokens[j].type === "h2") break;
      if (tokens[j].type === "phone") {
        phoneTok = tokens[j];
        j++;
        break;
      }
    }

    const title = (phoneTok && phoneTok.text) || altTitle;
    const phoneUrl = phoneTok ? absUrl(phoneTok.href) : "";

    // Then take up to 2 plain-text lines (codename, model numbers) —
    // exactly the shape observed on the page — stopping at the next
    // thumbnail/heading so trailing page content never leaks in.
    const textLines = [];
    for (; j < tokens.length && textLines.length < 2; j++) {
      if (tokens[j].type === "image" || tokens[j].type === "h2") break;
      if (tokens[j].type === "text" && tokens[j].text !== "\n") {
        textLines.push(tokens[j].text);
      }
    }

    const codename = textLines[0] || "";
    const models = textLines[1] || "";

    if (!title || !imageUrl) continue;

    items.push({
      section: currentSection || "Unknown",
      title,
      codename,
      models,
      image_url: imageUrl,
      thumbnail_url: thumbnailUrl,
      phone_url: phoneUrl,
    });
  }

  if (!sectionFilter) return items;
  return items.filter((it) => sectionFilter.includes(it.section.toLowerCase()));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const { outDir, sectionFilter, downloadImages, baseUrl } = parseArgs();

  if (baseUrl && !downloadImages) {
    console.warn(
      "  !! --base-url was given without --download-images — there will be no local files to " +
        "publish, so RSS items will fall back to the original miuirom.org image URLs. Add " +
        "--download-images to actually host images from GitHub Pages."
    );
  }

  fs.mkdirSync(outDir, { recursive: true });
  fs.mkdirSync(path.join(outDir, "edlpoint"), { recursive: true });
  if (downloadImages) {
    fs.mkdirSync(path.join(outDir, "edlpoint", "images"), { recursive: true });
  }

  console.log(`Fetching ${PAGE_URL} ...`);
  const html = await fetchHtml(PAGE_URL);

  console.log("Parsing EDL point items...");
  const allItems = parseEdlPoints(html, sectionFilter);
  console.log(`Found ${allItems.length} device(s).`);

  if (allItems.length === 0) {
    console.warn(
      "  !! WARNING: 0 items parsed. The page markup may have changed " +
        "(linearize()/parseEdlPoints() expect an <a href> containing " +
        "'/wp-content/uploads/test-point/' for each thumbnail, and an " +
        "<a href> containing '/phones/' right after it for the device name) " +
        "— inspect the page HTML and adjust parseEdlPoints()."
    );
  }

  // -------------------------------------------------------------------
  // Write per-section JSON files.
  // -------------------------------------------------------------------
  const bySection = new Map();
  for (const it of allItems) {
    if (!bySection.has(it.section)) bySection.set(it.section, []);
    bySection.get(it.section).push(it);
  }
  for (const [sectionName, items] of bySection) {
    fs.writeFileSync(
      path.join(outDir, "edlpoint", `${sanitizeFilename(sectionName)}.json`),
      JSON.stringify(items, null, 2)
    );
    console.log(`  -> ${sectionName}: ${items.length} device(s)`);
  }

  // -------------------------------------------------------------------
  // Download images once per unique remote URL — never twice.
  // -------------------------------------------------------------------
  if (downloadImages) {
    const imagesDir = path.join(outDir, "edlpoint", "images");
    const manifestPath = path.join(imagesDir, "images-manifest.json");
    const manifest = loadManifest(manifestPath);

    const uniqueUrls = [...new Set(allItems.map((it) => it.image_url))];
    console.log(`\nDownloading images: ${uniqueUrls.length} unique URL(s).`);

    const usedFilenames = new Set(manifest.values());
    let downloaded = 0;
    let skippedExisting = 0;
    let failed = 0;

    for (const url of uniqueUrls) {
      const existingRel = manifest.get(url);
      const existingAbs = existingRel ? path.join(outDir, "edlpoint", existingRel) : null;

      if (existingRel && fs.existsSync(existingAbs)) {
        skippedExisting++;
        continue;
      }

      let fname = filenameForUrl(url);
      let relPath = path.join("images", fname);
      if (usedFilenames.has(relPath) && !existingRel) {
        fname = `${shortHash(url)}_${fname}`;
        relPath = path.join("images", fname);
      }
      const dest = path.join(outDir, "edlpoint", relPath);

      if (fs.existsSync(dest)) {
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

    // pagesPrefix = --out-dir relative to the repo root, posix-style, e.g.
    // "./feed" -> "feed". GitHub Pages (per the workflow) serves the whole
    // repo from "/", so a file at <outDir>/edlpoint/images/x.jpg is reachable
    // at <base-url>/<pagesPrefix>/edlpoint/images/x.jpg.
    const pagesPrefix = outDir.replace(/^\.\/?/, "").split(path.sep).filter(Boolean).join("/");

    for (const it of allItems) {
      const rel = manifest.get(it.image_url);
      if (!rel) continue;
      const relPosix = rel.split(path.sep).join("/");
      it.local_image_path = `edlpoint/${relPosix}`;
      if (baseUrl) {
        it.published_image_url = [baseUrl, pagesPrefix, "edlpoint", relPosix]
          .filter(Boolean)
          .join("/");
      }
    }
    for (const [sectionName, items] of bySection) {
      fs.writeFileSync(
        path.join(outDir, "edlpoint", `${sanitizeFilename(sectionName)}.json`),
        JSON.stringify(items, null, 2)
      );
    }
  }

  fs.writeFileSync(path.join(outDir, "edlpoint_all.json"), JSON.stringify(allItems, null, 2));

  const rssXml = generateRss(allItems);
  const rssPath = path.join(outDir, "rss_edlpoint.xml");
  fs.writeFileSync(rssPath, rssXml);

  const publishedCount = allItems.filter((it) => it.published_image_url).length;
  console.log(`\nDone. ${allItems.length} total item(s).`);
  console.log(`Written to ${path.join(outDir, "edlpoint_all.json")}`);
  console.log(`RSS feed: ${rssPath}`);
  if (baseUrl) {
    console.log(
      `RSS images point at GitHub Pages (${baseUrl}) for ${publishedCount}/${allItems.length} item(s)` +
        (publishedCount < allItems.length ? " — the rest fall back to miuirom.org." : ".")
    );
  } else {
    console.log(`RSS images point at the original miuirom.org URLs (no --base-url given).`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
