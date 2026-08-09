#!/usr/bin/env node
/**
 * fetch_roms.js
 *
 * Single-site firmware scraper for ximitime.com/hyperos/ (Xiaomi HyperOS
 * OTA update database).
 *
 * ---------------------------------------------------------------------
 * v4.0 — rewritten for ximitime.com's current site structure
 * ---------------------------------------------------------------------
 * ximitime.com no longer publishes HyperOS updates as WordPress blog
 * posts with /hyperos/page/N/ pagination. It is now a device database:
 *
 *   1. https://ximitime.com/hyperos/                          (device list, ~445 devices)
 *   2. https://ximitime.com/hyperos/{codename}/                (device page: table of
 *                                                                every version/region with
 *                                                                its release Date)
 *   3. https://ximitime.com/hyperos/{codename}/version/{ver}/   (version page: actual
 *                                                                direct download link,
 *                                                                file size, MD5 — but NO
 *                                                                date field)
 *
 * The release date only exists on the device page's table (step 2), not
 * on the version page itself (step 3) — the old scraper looked for a date
 * on the version page and always got "Unknown". This build reads the date
 * from the device table and carries it through.
 *
 * Accumulation / dedupe / batching
 * ---------------------------------------------------------------------
 * - Every run re-reads roms_hyperos.json from --out-dir (if present) and
 *   treats every entry already in it (keyed by its version-page URL) as
 *   "already fetched" — it is never re-scraped or re-downloaded.
 * - Every run still does a full, unlimited crawl of the *listing* pages
 *   (the device index + every device's version table) to discover which
 *   version URLs exist — nothing is skipped or depth-limited there.
 * - Of the newly discovered (not-yet-known) version URLs, only up to
 *   --batch (default 50) are actually fetched for their download link /
 *   file size / MD5 in this run. Anything past the batch limit is simply
 *   left "new" and will be picked up automatically on the next run — no
 *   separate cursor file needed.
 * - Newly fetched items are appended to the existing accumulated list
 *   (never overwritten), then the JSON + RSS are rewritten from the full
 *   accumulated set, newest first, with no duplicate entries.
 *
 * Usage:
 *   node fetch_roms.js                      # scrape hyperos (only brand)
 *   node fetch_roms.js hyperos               # same, explicit
 *   node fetch_roms.js --batch 50            # max NEW items to fetch this run (default 50)
 *   node fetch_roms.js --out-dir ./feed      # output / state directory
 *
 * Output (accumulated across runs, in --out-dir):
 *   roms_hyperos.json  - structured metadata, all runs merged, deduped
 *   rss_hyperos.xml     - RSS feed with direct download links
 *   roms_all.json       - combined metadata (mirrors roms_hyperos.json)
 *   rss_all.xml          - combined RSS feed (mirrors rss_hyperos.xml)
 */

const https = require("https");
const http = require("http");
const fs = require("fs");
const path = require("path");

// ---------------------------------------------------------------------------
// Brand configuration
// ---------------------------------------------------------------------------
const BRANDS = {
  hyperos: {
    name: "Xiaomi HyperOS",
    site: "ximitime.com",
    listUrl: "https://ximitime.com/hyperos/",
    type: "ximitime-db",
  },
};

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const RATE_LIMIT_MS = 200;
const DEFAULT_BATCH = 50;
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------
function parseArgs() {
  const args = process.argv.slice(2);
  let brands = [];
  let batchSize = DEFAULT_BATCH;
  let outDir = ".";

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--batch" || args[i] === "--depth") {
      // --depth kept as a backward-compatible alias for --batch
      const d = parseInt(args[i + 1], 10);
      batchSize = isNaN(d) ? DEFAULT_BATCH : d;
      i++;
    } else if (args[i] === "--out-dir") {
      outDir = args[i + 1];
      i++;
    } else if (!args[i].startsWith("--")) {
      brands.push(args[i].toLowerCase());
    }
  }

  if (brands.length === 0) brands = Object.keys(BRANDS);
  return { brands, batchSize, outDir };
}

// ---------------------------------------------------------------------------
// HTTP fetch with gzip support and redirect following
// ---------------------------------------------------------------------------
function fetchText(url, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (redirectCount > 10) {
      return reject(new Error(`Too many redirects: ${url}`));
    }
    const mod = url.startsWith("https") ? https : http;
    const req = mod.get(
      url,
      {
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
          "Accept-Encoding": "gzip, deflate",
        },
        timeout: 30000,
      },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          const next = res.headers.location.startsWith("http")
            ? res.headers.location
            : new URL(res.headers.location, url).href;
          res.resume();
          return resolve(fetchText(next, redirectCount + 1));
        }

        const chunks = [];
        const encoding = res.headers["content-encoding"];
        let stream = res;

        if (encoding === "gzip") {
          const zlib = require("zlib");
          stream = res.pipe(zlib.createGunzip());
        } else if (encoding === "deflate") {
          const zlib = require("zlib");
          stream = res.pipe(zlib.createInflate());
        }

        stream.on("data", (c) => chunks.push(c));
        stream.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf-8");
          resolve({ body, statusCode: res.statusCode, headers: res.headers });
        });
        stream.on("error", reject);
      }
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error(`Timeout fetching ${url}`));
    });
  });
}

function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return "";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(2)} ${units[i]}`;
}

// Normalizes the site's abbreviated size format ("8.0G", "927.1M") into
// "8.00 GB" / "927.10 MB" style output.
function normalizeSize(raw) {
  if (!raw) return "";
  const m = raw.trim().match(/^([\d.]+)\s*([KMGT]?)B?$/i);
  if (!m) return raw.trim();
  const num = parseFloat(m[1]);
  const unitLetter = (m[2] || "").toUpperCase();
  const unit = unitLetter ? `${unitLetter}B` : "B";
  return `${num.toFixed(2)} ${unit}`;
}

// ---------------------------------------------------------------------------
// Small HTML utilities (kept dependency-free, matching the rest of the file)
// ---------------------------------------------------------------------------
function stripTags(html) {
  if (!html) return "";
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#0?39;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, " ")
    .trim();
}

// ---------------------------------------------------------------------------
// Step 1: device index page — https://ximitime.com/hyperos/
// Extracts every device codename from links of the form
// https://ximitime.com/hyperos/{codename}/ (single path segment only —
// excludes /version/, /stable/, pagination, taxonomy, etc.)
// ---------------------------------------------------------------------------
function parseDeviceIndex(html) {
  const codenames = new Set();
  const linkRegex = /href=["']https?:\/\/(?:www\.)?ximitime\.com\/hyperos\/([a-z0-9_]+)\/?["']/gi;
  let m;
  while ((m = linkRegex.exec(html)) !== null) {
    codenames.add(m[1].toLowerCase());
  }
  return Array.from(codenames);
}

// ---------------------------------------------------------------------------
// Step 2: device page — https://ximitime.com/hyperos/{codename}/
// Parses the version table (Version | Region | OS Type | Android | Date |
// Fastboot). The "All" tab on this page already includes every region, so
// no separate per-region tab crawl is needed.
// ---------------------------------------------------------------------------
function parseDeviceTable(html, deviceUrl, codename) {
  const result = { deviceName: "", entries: [] };

  // Prefer the H1 ("Xiaomi 15 Pro (haotian) | Latest HyperOS ROMs") since the
  // <title> tag's word order ("Download {name} HyperOS & MIUI ROM Updates |
  // XimiTime") is harder to reliably strip down to just the device name.
  const h1Match = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (h1Match) {
    result.deviceName = stripTags(h1Match[1])
      .replace(/\s*\([^)]*\)\s*\|.*$/i, "") // drop "(codename) | Latest HyperOS ROMs"
      .replace(/\s*\([^)]*\)\s*$/i, "") // drop trailing "(codename)" with no suffix
      .trim();
  }
  if (!result.deviceName) {
    const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
    if (titleMatch) {
      result.deviceName = titleMatch[1]
        .replace(/^Download\s+/i, "")
        .replace(/\s*(HyperOS\s*&amp;\s*MIUI\s*ROM\s*Updates|HyperOS.*ROM Updates).*$/i, "")
        .trim();
    }
  }
  if (!result.deviceName) result.deviceName = codename;

  const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowMatch;
  while ((rowMatch = rowRegex.exec(html)) !== null) {
    const rowHtml = rowMatch[1];
    const cellRegex = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    const cells = [];
    let cellMatch;
    while ((cellMatch = cellRegex.exec(rowHtml)) !== null) {
      cells.push(cellMatch[1]);
    }
    if (cells.length < 5) continue; // header row or unrelated table

    const linkMatch = cells[0].match(/href=["']([^"']+)["'][^>]*>([^<]*)</i);
    if (!linkMatch) continue;
    const versionUrl = linkMatch[1].startsWith("http")
      ? linkMatch[1]
      : new URL(linkMatch[1], deviceUrl).href;

    result.entries.push({
      versionUrl,
      versionCode: stripTags(cells[0]) || linkMatch[2].trim(),
      region: stripTags(cells[1] || ""),
      osType: stripTags(cells[2] || ""),
      androidVersion: stripTags(cells[3] || ""),
      date: stripTags(cells[4] || ""),
      fastboot: stripTags(cells[5] || ""),
    });
  }

  return result;
}

// ---------------------------------------------------------------------------
// Step 3: version page — https://ximitime.com/hyperos/{codename}/version/{ver}/
// Extracts the direct download link, file size, MD5, and a short changelog.
// No date lives here — the caller supplies the date it read from the
// device table in step 2.
// ---------------------------------------------------------------------------
function parseVersionPage(html, versionUrl) {
  const result = {
    name: "",
    directDownloadUrl: "",
    linkSource: "",
    fileSize: "",
    md5: "",
    linkValidUntil: "",
    firmwareVersion: "",
    description: "",
  };

  const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
  if (titleMatch) {
    result.name = titleMatch[1]
      .replace(/\s*\|\s*Download\s*HyperOS.*$/i, "")
      .trim();
  }

  // Direct OTA zip link — Xiaomi's Aliyun OSS update CDN.
  const ossMatch = html.match(
    /https?:\/\/[a-z0-9.-]*\.oss-[a-z0-9-]+\.aliyuncs\.com\/[^"'\s<>]+?\.(?:zip|tgz)/i
  );
  if (ossMatch) {
    result.directDownloadUrl = ossMatch[0];
    result.linkSource = "aliyun-oss";
  } else {
    const miuiCdnMatch = html.match(
      /https?:\/\/(?:[a-z0-9-]+\.)*(?:bigota|cdnorg|superota|hugeota)\.d\.miui\.com\/[^"'\s<>]+?\.(?:zip|tgz)/i
    );
    if (miuiCdnMatch) {
      result.directDownloadUrl = miuiCdnMatch[0];
      result.linkSource = "miui-ota-cdn";
    } else {
      const anyZipMatch = html.match(/https?:\/\/[^"'\s<>]+?\.(?:zip|tgz)/i);
      if (anyZipMatch) {
        result.directDownloadUrl = anyZipMatch[0];
        result.linkSource = "direct";
      }
    }
  }

  // File size — site prints abbreviated units like "8.0G" rather than "8.0 GB".
  const sizeMatch = html.match(/File\s*Size[^0-9]{0,60}?([\d.]+\s*[KMGT]?B?)\b/i);
  if (sizeMatch) result.fileSize = normalizeSize(sizeMatch[1]);

  // MD5 checksum. Match the nearest standalone 32-char hex token after the
  // "MD5" label (non-greedy "anything" span, not an exclusion class — text
  // like "MD5 Copy" contains hex-range letters such as "C" that would
  // break a [^a-f0-9]-style exclusion).
  const md5Match = html.match(/MD5[\s\S]{0,120}?\b([a-fA-F0-9]{32})\b/);
  if (md5Match) result.md5 = md5Match[1];

  // Signed-link expiry, e.g. "Link Valid Until 2026-08-10 02:02:44" — the
  // OSS download link is time-limited, this explains why old links go dead.
  const validMatch = html.match(
    /Link\s*Valid\s*Until[^0-9]{0,20}(\d{4}-\d{2}-\d{2}[^<\n]*)/i
  );
  if (validMatch) result.linkValidUntil = validMatch[1].trim();

  // Firmware version token from the URL itself (most reliable).
  const otaVerMatch = versionUrl.match(/\/version\/([A-Za-z0-9.]+)\/?$/i);
  if (otaVerMatch) result.firmwareVersion = otaVerMatch[1];

  // Changelog — list items under the "Changelog" heading, if present.
  const changelogIdx = html.search(/Changelog/i);
  if (changelogIdx !== -1) {
    const afterChangelog = html.slice(changelogIdx);
    const nextHeadingIdx = afterChangelog.slice(10).search(/<h[1-3][ >]/i);
    const changelogBlock =
      nextHeadingIdx !== -1 ? afterChangelog.slice(0, nextHeadingIdx + 10) : afterChangelog.slice(0, 2000);
    const liMatches = changelogBlock.match(/<li[^>]*>([\s\S]*?)<\/li>/gi) || [];
    const items = liMatches
      .map((li) => stripTags(li))
      .filter(Boolean)
      .slice(0, 12);
    if (items.length) result.description = items.join(" | ");
  }
  if (!result.description) {
    const descMatch = html.match(/<meta\s+name="description"\s+content="([^"]+)"/i);
    if (descMatch) result.description = descMatch[1].trim();
  }

  return result;
}

// ---------------------------------------------------------------------------
// State: load previously accumulated results so we never re-fetch a
// version URL we already have.
// ---------------------------------------------------------------------------
function loadPreviousState(outDir, brandKey) {
  const jsonPath = path.join(outDir, `roms_${brandKey}.json`);
  try {
    if (fs.existsSync(jsonPath)) {
      const parsed = JSON.parse(fs.readFileSync(jsonPath, "utf-8"));
      if (parsed && Array.isArray(parsed.files)) return parsed.files;
    }
  } catch (e) {
    console.log(`  Could not read previous state (${jsonPath}): ${e.message} — starting fresh.`);
  }
  return [];
}

// ---------------------------------------------------------------------------
// Scraper engine
// ---------------------------------------------------------------------------
async function scrapeBrand(brandKey, batchSize, outDir) {
  const brand = BRANDS[brandKey];
  console.log(`\n${"=".repeat(60)}`);
  console.log(` Scraping: ${brand.name} (${brand.site})`);
  console.log(`${"=".repeat(60)}`);

  const previousFiles = loadPreviousState(outDir, brandKey);
  const knownVersionUrls = new Set(previousFiles.map((f) => f.versionUrl).filter(Boolean));
  console.log(`Loaded ${previousFiles.length} previously-fetched entries (will not be re-fetched).`);

  const discovered = new Map(); // versionUrl -> entry metadata (from device table)

  try {
    // -----------------------------------------------------------------
    // Deep, unlimited discovery crawl: device index -> every device page
    // -----------------------------------------------------------------
    console.log(`Fetching device index from ${brand.listUrl}...`);
    const { body: indexBody } = await fetchText(brand.listUrl);
    await sleep(RATE_LIMIT_MS);

    const codenames = parseDeviceIndex(indexBody);
    console.log(`Found ${codenames.length} devices. Scanning every device page (unlimited, no page cap)...`);

    for (let i = 0; i < codenames.length; i++) {
      const codename = codenames[i];
      const deviceUrl = `https://ximitime.com/hyperos/${codename}/`;
      process.stdout.write(`  [${i + 1}/${codenames.length}] ${codename}... `);
      try {
        const { body: deviceHtml } = await fetchText(deviceUrl);
        await sleep(RATE_LIMIT_MS);
        const { deviceName, entries } = parseDeviceTable(deviceHtml, deviceUrl, codename);
        for (const entry of entries) {
          if (!discovered.has(entry.versionUrl)) {
            discovered.set(entry.versionUrl, { ...entry, deviceName, deviceUrl, codename });
          }
        }
        console.log(`${entries.length} version(s)`);
      } catch (e) {
        console.log(`ERROR: ${e.message}`);
      }
    }

    console.log(`\nDiscovered ${discovered.size} total device/version combinations across the site.`);

    // -----------------------------------------------------------------
    // Figure out what's actually new, then only fetch up to batchSize of it
    // -----------------------------------------------------------------
    const newEntries = Array.from(discovered.values()).filter((e) => !knownVersionUrls.has(e.versionUrl));
    console.log(`${newEntries.length} of those are new (not yet fetched previously).`);

    const toFetch = newEntries.slice(0, batchSize);
    const leftover = newEntries.length - toFetch.length;
    console.log(
      `Fetching ${toFetch.length} new item(s) this run` +
        (leftover > 0 ? ` (${leftover} more new item(s) will be picked up on the next run).` : ".")
    );

    const newlyFetched = [];
    for (let i = 0; i < toFetch.length; i++) {
      const entry = toFetch[i];
      process.stdout.write(`  [${i + 1}/${toFetch.length}] ${entry.deviceName} ${entry.versionCode}... `);
      try {
        const { body: versionHtml } = await fetchText(entry.versionUrl);
        await sleep(RATE_LIMIT_MS);
        const info = parseVersionPage(versionHtml, entry.versionUrl);

        if (!info.directDownloadUrl) {
          console.log("NO DOWNLOAD LINK");
          continue;
        }

        newlyFetched.push({
          brand: brand.name,
          deviceName: info.name || entry.deviceName,
          deviceUrl: entry.deviceUrl,
          versionUrl: entry.versionUrl,
          region: entry.region,
          osType: entry.osType,
          androidVersion: entry.androidVersion,
          fastboot: entry.fastboot,
          directDownloadUrl: info.directDownloadUrl,
          linkSource: info.linkSource || "direct",
          fileSize: info.fileSize || "Unknown",
          md5: info.md5 || "",
          linkValidUntil: info.linkValidUntil || "",
          date: entry.date || "Unknown", // <- comes from the device table, not the version page
          firmwareVersion: info.firmwareVersion || entry.versionCode || "",
          description: info.description || "",
        });
        console.log(`OK - ${info.directDownloadUrl.substring(0, 70)}...`);
      } catch (e) {
        console.log(`ERROR: ${e.message}`);
      }
    }

    // -----------------------------------------------------------------
    // Accumulate: keep every previous entry, append only the new ones
    // -----------------------------------------------------------------
    const seen = new Set();
    const allFiles = [];
    for (const f of [...previousFiles, ...newlyFetched]) {
      const key = f.versionUrl || f.directDownloadUrl;
      if (seen.has(key)) continue;
      seen.add(key);
      allFiles.push(f);
    }
    allFiles.sort((a, b) => (b.date || "").localeCompare(a.date || ""));

    console.log(
      `\n${brand.name}: ${allFiles.length} total accumulated files (${newlyFetched.length} added this run)`
    );
    return { brand: brandKey, brandName: brand.name, files: allFiles };
  } catch (e) {
    console.log(`Failed to scrape ${brand.name}: ${e.message}`);
    return { brand: brandKey, brandName: brand.name, files: previousFiles };
  }
}

// ---------------------------------------------------------------------------
// RSS generator
// ---------------------------------------------------------------------------
function escapeXml(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function generateRss(brandName, files) {
  const now = new Date().toUTCString();
  let items = "";

  for (const f of files) {
    const pubDate =
      f.date && f.date !== "Unknown" ? new Date(f.date).toUTCString() : now;

    const mirrorLabel =
      f.linkSource === "aliyun-oss" ? "Xiaomi OTA CDN (Aliyun OSS)" :
      f.linkSource === "miui-ota-cdn" ? "Xiaomi OTA CDN" :
      "Direct";

    items += `    <item>
      <title>${escapeXml(f.deviceName)}${f.firmwareVersion ? " " + escapeXml(f.firmwareVersion) : ""}</title>
      <link>${escapeXml(f.directDownloadUrl)}</link>
      <guid isPermaLink="false">${escapeXml(f.versionUrl || f.directDownloadUrl)}</guid>
      <pubDate>${pubDate}</pubDate>
      <description><![CDATA[
        Device: ${escapeXml(f.deviceName)}
        <br/>Brand: ${escapeXml(f.brand)}
        <br/>Region: ${escapeXml(f.region || "Unknown")}
        <br/>OS Type: ${escapeXml(f.osType || "")}
        <br/>Android: ${escapeXml(f.androidVersion || "")}
        <br/>Size: ${escapeXml(f.fileSize)}
        <br/>Date: ${escapeXml(f.date)}
        ${f.firmwareVersion ? "<br/>Version: " + escapeXml(f.firmwareVersion) : ""}
        ${f.md5 ? "<br/>MD5: " + escapeXml(f.md5) : ""}
        ${f.linkValidUntil ? "<br/>Link valid until: " + escapeXml(f.linkValidUntil) : ""}
        <br/><a href="${escapeXml(f.directDownloadUrl)}">Direct Download (${escapeXml(mirrorLabel)})</a>
        <br/><a href="${escapeXml(f.versionUrl)}">Source Page</a>
      ]]></description>
      <enclosure url="${escapeXml(f.directDownloadUrl)}" type="application/zip" />
    </item>\n`;
  }

  return `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <atom:link href="firmwaredrive.com" rel="self" type="application/rss+xml"/>
    <generator>fetch_roms.js</generator>
    <title>${escapeXml(brandName)} Firmware - Direct Downloads</title>
    <link>https://firmwaredrive.com</link>
    <description>Direct download links for ${escapeXml(brandName)} firmware files. Click any link to download directly without visiting the site.</description>
    <language>en</language>
    <lastBuildDate>${now}</lastBuildDate>
${items}  </channel>
</rss>
`;
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  let { brands, batchSize, outDir } = parseArgs();

  console.log(`\n${"=".repeat(60)}`);
  console.log(` ximitime.com/hyperos Firmware Scraper v4.0`);
  console.log(`${"=".repeat(60)}`);
  console.log(` Brands: ${brands.join(", ")}`);
  console.log(` New items fetched per run: ${batchSize}`);
  console.log(` Discovery crawl: unlimited (all devices, all pages, every run)`);
  console.log(` Output dir: ${outDir}`);
  console.log(`${"=".repeat(60)}\n`);

  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  const allResults = [];

  for (const brandKey of brands) {
    if (!BRANDS[brandKey]) {
      console.log(`Unknown brand: ${brandKey}`);
      console.log(`Available: ${Object.keys(BRANDS).join(", ")}`);
      continue;
    }

    const result = await scrapeBrand(brandKey, batchSize, outDir);
    allResults.push(result);

    const jsonPath = path.join(outDir, `roms_${brandKey}.json`);
    fs.writeFileSync(jsonPath, JSON.stringify(result, null, 2));
    console.log(`Written: ${jsonPath}`);

    const rssXml = generateRss(result.brandName, result.files);
    const rssPath = path.join(outDir, `rss_${brandKey}.xml`);
    fs.writeFileSync(rssPath, rssXml);
    console.log(`Written: ${rssPath}`);
  }

  const combinedJson = path.join(outDir, "roms_all.json");
  fs.writeFileSync(combinedJson, JSON.stringify(allResults, null, 2));
  console.log(`\nWritten combined: ${combinedJson}`);

  const allFiles = allResults.flatMap((r) => r.files);
  const combinedRss = generateRss("All Brands", allFiles);
  const combinedRssPath = path.join(outDir, "rss_all.xml");
  fs.writeFileSync(combinedRssPath, combinedRss);
  console.log(`Written combined: ${combinedRssPath}`);

  console.log(`\n${"=".repeat(60)}`);
  console.log(` Summary`);
  console.log(`${"=".repeat(60)}`);
  for (const r of allResults) {
    console.log(`  ${r.brandName.padEnd(20)} ${r.files.length} files (accumulated)`);
  }
  console.log(`  ${"Total".padEnd(20)} ${allFiles.length} files`);
  console.log(`${"=".repeat(60)}\n`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
