// Phase 2: copy manifest images into the pegbed dirs with the collision rule
// (identical bytes -> skip; different -> keep incoming KV image, record overwrite).
// Phase 3: emit per-site SQL UPDATE files into each repo's scripts/output/.
// Usage: node copy-and-sql.mjs <site>     (writes stats to migration/<site>-copy-stats.json)
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = '/Users/linyuan/workspace/ohmy';
const PEGBED = path.join(ROOT, 'movies-pegbed');
const TAG = 'v2.0.0';
const CDN = `https://cdn.jsdelivr.net/gh/lyuanx/movies-pegbed@${TAG}`;

const SITES = {
  video: { table: 'movies', col: 'poster_url', dir: 'posters', repo: 'ohmyvideo' },
  games: { table: 'games', col: 'cover_url', dir: 'game-covers', repo: 'ohmygame' },
  books: { table: 'books', col: 'cover_url', dir: 'book-covers', repo: 'ohmybook' },
  specs: { table: 'products', col: 'cover_url', dir: 'spec-covers', repo: 'ohmyspecs' },
  cook: { table: 'recipes', col: 'cover_url', dir: 'cook-photos', repo: 'ohmycook' },
};

const site = process.argv[2];
const cfg = SITES[site];
if (!cfg) throw new Error(`unknown site ${site}`);

const manifest = JSON.parse(await readFile(path.join(PEGBED, 'migration', `${site}-manifest.json`), 'utf8'));
const targetDir = path.join(PEGBED, cfg.dir);
await mkdir(targetDir, { recursive: true });

const stats = { copied: 0, skippedIdentical: 0, overwrites: [] };
const sql = ['begin;'];
for (const [slug, m] of Object.entries(manifest)) {
  const target = path.join(targetDir, `${slug}.${m.ext}`);
  if (existsSync(target)) {
    const [a, b] = await Promise.all([readFile(m.file), readFile(target)]);
    if (a.equals(b)) {
      stats.skippedIdentical++;
    } else {
      await copyFile(m.file, target);
      stats.copied++;
      stats.overwrites.push(slug);
    }
  } else {
    await copyFile(m.file, target);
    stats.copied++;
  }
  const cdn = `${CDN}/${cfg.dir}/${slug}.${m.ext}`;
  sql.push(
    `update public.${cfg.table} set ${cfg.col} = '${cdn}' where slug = '${slug.replaceAll("'", "''")}' and ${cfg.col} like '%/posters/%';`
  );
}
sql.push('commit;');

const outDir = path.join(ROOT, cfg.repo, 'scripts', 'output');
await mkdir(outDir, { recursive: true });
const sqlPath = path.join(outDir, 'cdn-migration.sql');
await writeFile(sqlPath, sql.join('\n') + '\n');
await writeFile(path.join(PEGBED, 'migration', `${site}-copy-stats.json`), JSON.stringify(stats, null, 2) + '\n');
console.log(
  `[${site}] copied ${stats.copied}, skipped-identical ${stats.skippedIdentical}, overwrites ${stats.overwrites.length}, sql -> ${sqlPath} (${Object.keys(manifest).length} updates)`
);
if (stats.overwrites.length) console.log(`  overwrites: ${stats.overwrites.slice(0, 20).join(', ')}${stats.overwrites.length > 20 ? ' ...' : ''}`);
