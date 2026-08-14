#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const https = require("https");
const cheerio = require("cheerio");

const BASE = "https://device-forum.com";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    outDir: "./feed",
    maxPages: null,
    startPage: 1,
    categoryId: null,
    downloadImages: false,
    baseUrl: null,
    delayMs: 200,
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--out-dir") options.outDir = args[++i];
    else if (arg === "--max-pages") options.maxPages = Number.parseInt(args[++i], 10);
    else if (arg === "--start-page") options.startPage = Number.parseInt(args[++i], 10);
    else if (arg === "--category") options.categoryId = args[++i];
    else if (arg === "--download-images") options.downloadImages = true;
    else if (arg === "--base-url") options.baseUrl = args[++i].replace(/\/+$/, "");
    else if (arg === "--delay") options.delayMs = Number.parseInt(args[++i], 10);
  }

  return options;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function escapeXml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function absoluteUrl(value) {
  if (!value) return "";
  try {
    return new URL(value, BASE).toString();
  } catch {
    return "";
  }
}

function isImageUrl(value) {
  return /\.(?:jpe?g|png|webp|gif|bmp|avif)(?:[?#].*)?$/i.test(value || "");
}

function normalizeImageUrl(value) {
  const url = absoluteUrl(value);
  return isImageUrl(url) ? url : "";
}

function imageCandidates($, img) {
  const values = [
    $(img).attr("data-full"),
    $(img).attr("data-original"),
    $(img).attr("data-image"),
    $(img).attr("data-src"),
    $(img).attr("src"),
  ];

  const srcset = $(img).attr("srcset") || $(img).attr("data-srcset") || "";
  for (const entry of srcset.split(",")) values.push(entry.trim().split(/\s+/)[0]);

  return values.map(normalizeImageUrl).filter(Boolean);
}

function deriveFullFromThumbnail(thumbnailUrl) {
  if (!thumbnailUrl) return "";
  return thumbnailUrl.replace(/\/xfmg\/thumbnail\//i, "/xfmg/full/");
}

function chooseImageUrl($, img, anchor) {
  const candidates = imageCandidates($, img);
  const anchorUrl = normalizeImageUrl($(anchor).attr("href"));
  if (anchorUrl) candidates.unshift(anchorUrl);

  const fullImage = candidates.find((url) => !/\/thumbnail\//i.test(url));
  if (fullImage) return fullImage;

  const thumbnail = candidates[0];
  if (!thumbnail) return "";
  return deriveFullFromThumbnail(thumbnail) || thumbnail;
}

function fetchHtml(url) {
  return new Promise((resolve, reject) => {
    const request = https.get(
      url,
      { headers: { "User-Agent": USER_AGENT, Accept: "text/html,application/xhtml+xml" } },
      (response) => {
        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          response.resume();
          fetchHtml(absoluteUrl(response.headers.location)).then(resolve, reject);
          return;
        }
        if (response.statusCode !== 200) {
          response.resume();
          reject(new Error(`HTTP ${response.statusCode} for ${url}`));
          return;
        }

        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.on("end", () => resolve(body));
      }
    );
    request.on("error", reject);
  });
}

function downloadFile(url, destination) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, { headers: { "User-Agent": USER_AGENT } }, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        downloadFile(absoluteUrl(response.headers.location), destination).then(resolve, reject);
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`HTTP ${response.statusCode} for ${url}`));
        return;
      }

      const file = fs.createWriteStream(destination);
      response.pipe(file);
      file.on("finish", () => file.close(resolve));
      file.on("error", (error) => {
        file.destroy();
        fs.unlink(destination, () => {});
        reject(error);
      });
    });

    request.on("error", (error) => {
      fs.unlink(destination, () => {});
      reject(error);
    });
  });
}

function sanitizeFilename(value) {
  return String(value || "image")
    .replace(/[\\/:*?"<>|]+/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
}

function shardForId(id) {
  const number = Number.parseInt(id, 10);
  if (!Number.isFinite(number) || number < 0) return "other";
  const start = Math.floor(number / 1000) * 1000;
  return `${String(start).padStart(4, "0")}-${String(start + 999).padStart(4, "0")}`;
}

function filenameForItem(item) {
  let filename = sanitizeFilename(item.title || `media_${item.id}`);
  if (!/\.(?:jpe?g|png|webp|gif|bmp|avif)$/i.test(filename)) filename += ".jpg";
  return path.join(shardForId(item.id), `${item.id}_${filename}`);
}

function loadManifest(filename) {
  if (!fs.existsSync(filename)) return new Map();
  try {
    return new Map(Object.entries(JSON.parse(fs.readFileSync(filename, "utf8"))));
  } catch (error) {
    console.warn(`  ! Could not read image manifest: ${error.message}`);
    return new Map();
  }
}

function saveManifest(filename, manifest) {
  fs.writeFileSync(filename, JSON.stringify(Object.fromEntries(manifest), null, 2));
}

function imageMimeType(url) {
  const extension = path.extname(new URL(url).pathname).toLowerCase();
  const types = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".bmp": "image/bmp",
    ".avif": "image/avif",
  };
  return types[extension] || "image/jpeg";
}

function generateRss(items) {
  const now = new Date().toUTCString();
  const xmlItems = items
    .map((item) => {
      const imageUrl = item.published_image_url || item.image_url || item.thumbnail_url;
      if (!imageUrl) return "";

      const date = item.date_added ? new Date(item.date_added) : null;
      const pubDate = date && !Number.isNaN(date.getTime()) ? date.toUTCString() : now;
      const category = item.category_name
        ? `<br/>Category: ${escapeXml(item.category_name)}`
        : "";

      return `    <item>
      <title>${escapeXml(item.title || `Media ${item.id}`)}</title>
      <link>${escapeXml(imageUrl)}</link>
      <guid isPermaLink="false">${escapeXml(imageUrl)}</guid>
      <pubDate>${pubDate}</pubDate>
      <description><![CDATA[${category}<br/><img src="${escapeXml(imageUrl)}" alt="${escapeXml(item.title)}" />]]></description>
      <enclosure url="${escapeXml(imageUrl)}" type="${imageMimeType(imageUrl)}" />
    </item>`;
    })
    .filter(Boolean)
    .join("\n");

  return `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0">
  <channel>
    <generator>fetch_deviceforum.js</generator>
    <title>Device Forum Media Gallery</title>
    <link>${BASE}/media/</link>
    <description>Testpoint, pinout, schematic and board image archive.</description>
    <language>en</language>
    <lastBuildDate>${now}</lastBuildDate>
${xmlItems}
  </channel>
</rss>
`;
}

function findLastPage(html) {
  let lastPage = 1;
  const pattern = /\/page-(\d+)/g;
  let match;
  while ((match = pattern.exec(html))) lastPage = Math.max(lastPage, Number.parseInt(match[1], 10));
  return lastPage;
}

function parseListingPage(html) {
  const $ = cheerio.load(html);
  const items = [];
  const seenIds = new Set();

  $("img").each((_, image) => {
    const $image = $(image);
    const $anchor = $image.closest("a[href]");
    const href = $anchor.attr("href") || "";
    const idMatch = href.match(/\/media\/(\d+)(?:\/|$|[?#])/i);
    if (!idMatch) return;

    const id = idMatch[1];
    if (seenIds.has(id)) return;

    let $card = $anchor;
    for (let level = 0; level < 10; level += 1) {
      const $parent = $card.parent();
      if (!$parent.length) break;
      $card = $parent;
      if (/view count|date added|comments?/i.test($card.text())) break;
    }

    let title = "";
    $card.find("a").each((__, link) => {
      const linkHref = $(link).attr("href") || "";
      const text = $(link).text().replace(/\s+/g, " ").trim();
      if (!title && /\/media\/(\d+)(?:\/|$|[?#])/i.test(linkHref) && text) title = text;
    });
    title = title || ($image.attr("alt") || "").trim() || `Media ${id}`;

    const $category = $card.find('a[href*="/media/categories/"]').last();
    const categoryHref = $category.attr("href") || "";
    const categoryMatch = categoryHref.match(/\/media\/categories\/(\d+)/i);
    const blockText = $card.text().replace(/\s+/g, " ").trim();
    const dateMatch = blockText.match(/Date added\s*([A-Za-z]{3,9}\s+\d{1,2},\s+\d{4})/i);
    const viewMatch = blockText.match(/View count\s*([\d,]+)/i);
    const commentMatch = blockText.match(/Comments?\s*([\d,]+)/i);
    const imageUrl = chooseImageUrl($, image, $anchor);

    if (!imageUrl) return;
    seenIds.add(id);
    items.push({
      id,
      title,
      category_id: categoryMatch ? categoryMatch[1] : null,
      category_name: $category.text().replace(/\s+/g, " ").trim() || null,
      page_url: absoluteUrl(href),
      thumbnail_url: absoluteUrl(
        $image.attr("src") || $image.attr("data-src") || $image.attr("data-original") || ""
      ),
      image_url: imageUrl,
      date_added: dateMatch ? dateMatch[1] : null,
      view_count: viewMatch ? Number.parseInt(viewMatch[1].replace(/,/g, ""), 10) : null,
      comment_count: commentMatch ? Number.parseInt(commentMatch[1].replace(/,/g, ""), 10) : null,
    });
  });

  return items;
}

function parseCategoryTree(html) {
  const $ = cheerio.load(html);
  const categories = new Map();
  $('a[href*="/media/categories/"]').each((_, link) => {
    const href = $(link).attr("href") || "";
    const match = href.match(/\/media\/categories\/(\d+)/i);
    const name = $(link).text().replace(/\s+/g, " ").trim();
    if (match && name) categories.set(match[1], { name, url: absoluteUrl(href) });
  });
  return categories;
}

function pageUrl(basePath, page) {
  return page <= 1 ? `${BASE}${basePath}` : `${BASE}${basePath}page-${page}`;
}

async function main() {
  const options = parseArgs();
  const { outDir, maxPages, startPage, categoryId, downloadImages, baseUrl, delayMs } = options;
  const basePath = categoryId ? `/media/categories/${categoryId}/` : "/media/";

  fs.mkdirSync(path.join(outDir, "deviceforum"), { recursive: true });
  if (downloadImages) fs.mkdirSync(path.join(outDir, "deviceforum", "images"), { recursive: true });

  const firstUrl = pageUrl(basePath, 1);
  console.log(`Fetching ${firstUrl}`);
  const firstHtml = await fetchHtml(firstUrl);
  const advertisedLastPage = findLastPage(firstHtml);
  const lastPage = maxPages
    ? Math.min(startPage + maxPages - 1, advertisedLastPage)
    : advertisedLastPage;
  const categories = parseCategoryTree(firstHtml);
  const itemsById = new Map();
  let pagesFetched = 0;
  let pagesFailed = 0;

  for (let page = startPage; page <= lastPage; page += 1) {
    let html;
    try {
      html = page === 1 && startPage === 1 ? firstHtml : await fetchHtml(pageUrl(basePath, page));
    } catch (error) {
      pagesFailed += 1;
      console.warn(`  ! Failed to fetch page ${page}: ${error.message}`);
      continue;
    }

    for (const item of parseListingPage(html)) {
      if (!itemsById.has(item.id)) itemsById.set(item.id, item);
    }
    for (const [id, category] of parseCategoryTree(html)) categories.set(id, category);
    pagesFetched += 1;
    if (page < lastPage) await sleep(delayMs);
    console.log(`  Page ${page}/${lastPage}: ${itemsById.size} item(s)`);
  }

  const items = [...itemsById.values()];
  if (!items.length) throw new Error("No media items found; the gallery markup may have changed.");

  if (downloadImages) {
    const imageRoot = path.join(outDir, "deviceforum");
    const manifestPath = path.join(imageRoot, "images", "images-manifest.json");
    const manifest = loadManifest(manifestPath);
    let downloaded = 0;
    let skipped = 0;
    let failed = 0;

    for (const item of items) {
      const sourceUrl = item.image_url;
      const relativePath = path.join("images", filenameForItem(item));
      const existing = manifest.get(sourceUrl);
      const existingPath = existing ? path.join(imageRoot, existing) : "";
      const destination = path.join(imageRoot, relativePath);

      if ((existing && fs.existsSync(existingPath)) || fs.existsSync(destination)) {
        manifest.set(sourceUrl, existing || relativePath);
        skipped += 1;
        continue;
      }

      try {
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        await downloadFile(sourceUrl, destination);
        manifest.set(sourceUrl, relativePath);
        downloaded += 1;
      } catch (error) {
        failed += 1;
        console.warn(`  ! Failed to download ${sourceUrl}: ${error.message}`);
      }
      await sleep(delayMs);
    }

    saveManifest(manifestPath, manifest);
    const pagesPrefix = outDir.replace(/^\.\/?/, "").split(path.sep).filter(Boolean).join("/");
    for (const item of items) {
      const relativePath = manifest.get(item.image_url);
      if (!relativePath) continue;
      const posixPath = relativePath.split(path.sep).join("/");
      item.local_image_path = `deviceforum/${posixPath}`;
      if (baseUrl) item.published_image_url = [baseUrl, pagesPrefix, item.local_image_path].filter(Boolean).join("/");
    }
    console.log(`Images: ${downloaded} downloaded, ${skipped} skipped, ${failed} failed.`);
  }

  fs.writeFileSync(path.join(outDir, "deviceforum_all.json"), JSON.stringify(items, null, 2));
  fs.writeFileSync(path.join(outDir, "deviceforum_categories.json"), JSON.stringify(Object.fromEntries(categories), null, 2));
  fs.writeFileSync(
    path.join(outDir, "deviceforum_coverage.json"),
    JSON.stringify(
      {
        source: `${BASE}${basePath}`,
        advertised_last_page: advertisedLastPage,
        pages_fetched: pagesFetched,
        pages_failed: pagesFailed,
        items_collected: items.length,
      },
      null,
      2
    )
  );
  fs.writeFileSync(path.join(outDir, "rss_deviceforum.xml"), generateRss(items));
  console.log(`Done. ${items.length} item(s) written.`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
