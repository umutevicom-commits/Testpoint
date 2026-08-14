#!/usr/bin/env node
/**
 * migrate_shard_images.js
 *
 * One-off migration: reorganizes an existing flat
 *   <out-dir>/deviceforum/images/*.ext
 * layout (produced by older fetch_deviceforum.js runs) into the new
 * sharded layout
 *   <out-dir>/deviceforum/images/<shard>/*.ext
 * where <shard> groups media ids into blocks of 1000 (e.g. "1000-1999"),
 * matching the shardForId()/filenameForItem() logic now used in
 * fetch_deviceforum.js. This is what fixes GitHub's "directory truncated
 * to 1,000 files" listing warning for repos that already have thousands
 * of images sitting flat in one folder.
 *
 * What it does:
 *   1. Reads images-manifest.json (url -> relative path).
 *   2. For every entry still pointing at a flat "images/<file>" path,
 *      moves the file on disk into "images/<shard>/<file>" and rewrites
 *      that manifest entry.
 *   3. Also sweeps the images/ directory for any stray files not (yet)
 *      in the manifest (defensive — shouldn't normally happen) and
 *      shards those too, matching id from the "<id>_..." filename prefix.
 *   4. Rewrites images-manifest.json once, at the end.
 *
 * Safe to re-run: already-sharded files (already inside a "NNNN-NNNN/"
 * subfolder) are left alone.
 *
 * Usage:
 *   node migrate_shard_images.js --out-dir ./feed
 */

const fs = require("fs");
const path = require("path");

function parseArgs() {
  const args = process.argv.slice(2);
  let outDir = "./feed";
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--out-dir") outDir = args[++i];
  }
  return { outDir };
}

function shardForId(id) {
  const n = parseInt(id, 10);
  if (!Number.isFinite(n) || n < 0) return "other";
  const start = Math.floor(n / 1000) * 1000;
  return `${String(start).padStart(4, "0")}-${String(start + 999).padStart(4, "0")}`;
}

/** True if relPath already looks like "<shard>/<file>" (has exactly one path separator, shard-shaped). */
function isAlreadySharded(relPath) {
  const parts = relPath.split(path.sep);
  return parts.length === 2 && (/^\d{4}-\d{4}$/.test(parts[0]) || parts[0] === "other");
}

function idFromFilename(filename) {
  const m = filename.match(/^(\d+)_/);
  return m ? m[1] : null;
}

function main() {
  const { outDir } = parseArgs();
  const imagesDir = path.join(outDir, "deviceforum", "images");
  const manifestPath = path.join(imagesDir, "images-manifest.json");

  if (!fs.existsSync(imagesDir)) {
    console.error(`No such directory: ${imagesDir}`);
    process.exit(1);
  }

  let manifest = {};
  if (fs.existsSync(manifestPath)) {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } else {
    console.warn(`No manifest at ${manifestPath} — will still shard files by filename, but can't update a manifest.`);
  }

  let moved = 0;
  let alreadySharded = 0;
  let skippedNoId = 0;

  // Pass 1: move files referenced by the manifest.
  for (const [url, relPath] of Object.entries(manifest)) {
    if (isAlreadySharded(relPath)) {
      alreadySharded++;
      continue;
    }
    const filename = path.basename(relPath);
    const id = idFromFilename(filename);
    if (!id) {
      skippedNoId++;
      continue;
    }
    const shard = shardForId(id);
    const srcAbs = path.join(outDir, "deviceforum", relPath);
    const newRel = path.join("images", shard, filename);
    const destAbs = path.join(outDir, "deviceforum", newRel);

    if (!fs.existsSync(srcAbs)) {
      // Already moved (e.g. re-run), or file missing — just fix up the manifest if the new path exists.
      if (fs.existsSync(destAbs)) {
        manifest[url] = newRel;
      }
      continue;
    }

    fs.mkdirSync(path.dirname(destAbs), { recursive: true });
    fs.renameSync(srcAbs, destAbs);
    manifest[url] = newRel;
    moved++;
  }

  // Pass 2: sweep for stray flat files directly under images/ not covered above.
  const entries = fs.readdirSync(imagesDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue; // skip subfolders and the manifest itself is a file, exclude below
    if (entry.name === "images-manifest.json") continue;
    const id = idFromFilename(entry.name);
    if (!id) {
      skippedNoId++;
      continue;
    }
    const shard = shardForId(id);
    const srcAbs = path.join(imagesDir, entry.name);
    const destAbs = path.join(imagesDir, shard, entry.name);
    fs.mkdirSync(path.dirname(destAbs), { recursive: true });
    fs.renameSync(srcAbs, destAbs);
    moved++;
  }

  if (fs.existsSync(manifestPath) || Object.keys(manifest).length) {
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  }

  console.log(`Done. Moved ${moved} file(s) into shard subfolders.`);
  console.log(`Already sharded (skipped): ${alreadySharded}`);
  if (skippedNoId) console.warn(`Skipped ${skippedNoId} file(s): couldn't parse an id from the filename.`);
  console.log(`Manifest updated: ${manifestPath}`);
}

main();
