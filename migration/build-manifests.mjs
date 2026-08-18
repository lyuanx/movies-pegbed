// Phase 1: build per-site slug -> { file, ext, bytes } manifests for the KV->pegbed migration.
// Fetches KV-backed rows from Supabase REST, resolves images from local caches first,
// downloads missing ones from the public /posters/ URLs, writes migration/<site>-manifest.json.
// Usage: node build-manifests.mjs [site ...]   (default: all)
import { readdir, stat, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const ROOT = '/Users/linyuan/workspace/ohmy';
const API = 'https://bkelnrabcisftwnfuath.supabase.co/rest/v1';
const KEY = 'sb_publishable_fxrkxfhu_hF47_J-5_xAwQ_KwnU218N';
const EXTS = ['jpg', 'png', 'webp', 'gif'];
const CT_EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };

const SITES = {
  video: { table: 'movies', col: 'poster_url', dir: 'posters', cache: 'ohmyvideo/scripts/.cache/covers' },
  games: { table: 'games', col: 'cover_url', dir: 'game-covers', cache: 'ohmygame/scripts/.cache/covers' },
  books: { table: 'books', col: 'cover_url', dir: 'book-covers', cache: 'ohmybook/scripts/.cache/covers' },
  specs: { table: 'products', col: 'cover_url', dir: 'spec-covers', cache: 'ohmyspecs/scripts/.cache/covers' },
  cook: { table: 'recipes', col: 'cover_url', dir: 'cook-photos', cache: 'ohmycook/scripts/.cache/dish-photos' },
};

async function fetchDbRows(site) {
  const { table, col } = SITES[site];
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const url = `${API}/${table}?select=slug,${col}&${col}=like.*ohmygp.com%2Fposters%2F*&order=slug`;
    const res = await fetch(url, {
      headers: { apikey: KEY, 'Range-Unit': 'items', Range: `${from}-${from + 999}` },
    });
    if (!res.ok) throw new Error(`${site} REST ${res.status}: ${await res.text()}`);
    const batch = await res.json();
    rows.push(...batch);
    if (batch.length < 1000) break;
  }
  return rows;
}

async function download(url, destBase) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      const ext = CT_EXT[res.headers.get('content-type')?.split(';')[0].trim()] || 'jpg';
      const file = `${destBase}.${ext}`;
      await writeFile(file, buf);
      return { file, ext, bytes: buf.length };
    } catch (e) {
      if (attempt === 2) throw e;
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
    }
  }
}

async function run(site) {
  const cfg = SITES[site];
  const cacheDir = path.join(ROOT, cfg.cache);
  const rows = await fetchDbRows(site);
  console.log(`[${site}] DB KV-backed rows: ${rows.length}`);

  const cacheFiles = new Set(await readdir(cacheDir));
  const manifest = {};
  const toDownload = [];
  for (const row of rows) {
    const hit = EXTS.map((e) => `${row.slug}.${e}`).find((f) => cacheFiles.has(f));
    if (hit) {
      const fp = path.join(cacheDir, hit);
      manifest[row.slug] = { file: fp, ext: path.extname(hit).slice(1), bytes: (await stat(fp)).size, source: 'cache' };
    } else {
      toDownload.push(row);
    }
  }
  console.log(`[${site}] cache hits: ${Object.keys(manifest).length}, to download: ${toDownload.length}`);

  const failed = [];
  let done = 0;
  const workers = Array.from({ length: 8 }, async () => {
    while (toDownload.length) {
      const row = toDownload.pop();
      try {
        const r = await download(row[cfg.col], path.join(cacheDir, row.slug));
        manifest[row.slug] = { file: r.file, ext: r.ext, bytes: r.bytes, source: 'download' };
      } catch (e) {
        failed.push({ slug: row.slug, url: row[cfg.col], error: String(e) });
      }
      if (++done % 200 === 0) console.log(`[${site}] downloaded ${done}`);
    }
  });
  await Promise.all(workers);

  for (const m of Object.values(manifest)) delete m.source;
  const out = path.join(ROOT, 'movies-pegbed/migration', `${site}-manifest.json`);
  await mkdir(path.dirname(out), { recursive: true });
  await writeFile(out, JSON.stringify(manifest, null, 1) + '\n');
  console.log(
    `[${site}] manifest: ${Object.keys(manifest).length} entries (DB ${rows.length}), failed: ${failed.length} -> ${out}`
  );
  if (failed.length) {
    await writeFile(out.replace('-manifest.json', '-failed.json'), JSON.stringify(failed, null, 2) + '\n');
    for (const f of failed) console.log(`  FAILED ${f.slug} ${f.url} ${f.error}`);
  }
}

const sites = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(SITES);
for (const s of sites) await run(s);
