/**
 * fetch-corpus.js — downloads ~54 licensed-free wildlife photos from the
 * iNaturalist API (keyless, per-photo CC license + attribution, taxon ground
 * truth).
 *
 * Source decision (documented honestly): Wikimedia Commons was the first
 * choice, but commons.wikimedia.org resets connections from this network
 * (ECONNRESET — verified with curl and node, while npmjs/wikipedia/iNaturalist
 * all respond). iNaturalist is keyless, purpose-built for species photos, and
 * carries per-photo license + attribution metadata.
 *
 * Categories: red fox (Vulpes vulpes), gray wolf (Canis lupus), dog
 * (Canis familiaris), brown bear (Ursus arctos), white-tailed deer
 * (Odocoileus virginianus) — 10 each, species-level research-grade — plus 4
 * genus-level "Canis" photos from needs-ID observations (the community itself
 * could not separate wolf/dog/coyote) as GENUINELY ambiguous images for the
 * low-confidence flagging path.
 *
 * Usage: node scripts/fetch-corpus.js [categoryKey]   (no arg = all)
 * Idempotent + merge-safe: existing files skipped; running one category
 * rewrites only that category's manifest entries.
 */
const fs = require('fs');
const path = require('path');

const API = 'https://api.inaturalist.org/v1';
const UA = 'FlyRankCapstoneImageRelevance/1.0 (student capstone; contact: abdullah2684511@gmail.com)';
const PER_CATEGORY = 10;
const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'images');
const MANIFEST_PATH = path.join(ROOT, 'data', 'manifest.json');

const SPECIES = [
  { key: 'red_fox', species: 'red fox', scientific: 'Vulpes vulpes', taxonId: 42069, grade: 'research' },
  { key: 'wolf', species: 'gray wolf', scientific: 'Canis lupus', taxonId: 42048, grade: 'research' },
  { key: 'dog', species: 'dog', scientific: 'Canis familiaris', taxonId: 47144, grade: 'research' },
  { key: 'bear', species: 'bear', scientific: 'Ursus arctos', taxonId: 41641, grade: 'research' },
  { key: 'deer', species: 'deer', scientific: 'Odocoileus virginianus', taxonId: 42223, grade: 'research' },
  {
    key: 'ambiguous_canid', species: 'canid',
    scientific: 'Canis (genus — species uncertain)', taxonId: 42044, grade: 'needs_id', ambiguous: true,
  },
];

// Only CC / public-domain photos. 'copyright' and null are excluded.
const CC_LICENSES = new Set(['cc0', 'cc-by', 'cc-by-nc', 'cc-by-sa', 'cc-by-nc-sa', 'cc-by-nd', 'cc-by-nc-nd', 'pd']);
const LICENSE_NAMES = {
  cc0: 'CC0 1.0 (public domain dedication)',
  pd: 'Public domain',
  'cc-by': 'CC BY 4.0',
  'cc-by-nc': 'CC BY-NC 4.0',
  'cc-by-sa': 'CC BY-SA 4.0',
  'cc-by-nc-sa': 'CC BY-NC-SA 4.0',
  'cc-by-nd': 'CC BY-ND 4.0',
  'cc-by-nc-nd': 'CC BY-NC-ND 4.0',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(pathname) {
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(`${API}${pathname}`, {
        headers: { 'User-Agent': UA },
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.json();
    } catch (e) {
      lastErr = e;
      if (attempt < 3) await sleep(1500 * attempt);
    }
  }
  throw lastErr;
}

async function download(url, dest) {
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(20000) });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 15000) throw new Error('suspiciously small file (' + buf.length + ' bytes)');
      fs.writeFileSync(dest, buf);
      return buf.length;
    } catch (e) {
      lastErr = e;
      if (attempt < 3) await sleep(1500 * attempt);
    }
  }
  throw lastErr;
}

function largeUrl(squareUrl) {
  // iNat photo URLs: .../photos/<id>/square.jpg — request the large variant.
  return String(squareUrl).replace(/\/(square|thumb|small)\.(jpe?g)$/i, '/large.$2');
}

// Purity rule: species categories accept only species-level IDs; the ambiguous
// pool accepts only genus-level Canis IDs (community could not go further).
function keepObservation(sp, obs) {
  const taxon = obs.taxon || {};
  if (sp.ambiguous) return taxon.rank === 'genus' && taxon.name === 'Canis';
  return taxon.rank === 'species';
}

async function fetchCategory(sp, existingImages) {
  const catDir = path.join(OUT_DIR, sp.key);
  fs.mkdirSync(catDir, { recursive: true });

  const j = await api(
    `/observations?taxon_id=${sp.taxonId}&photos=true&quality_grade=${sp.grade}&per_page=100`
  );

  let saved = 0;
  const entries = [];
  for (const obs of j.results || []) {
    if (saved >= PER_CATEGORY) break;
    if (!keepObservation(sp, obs)) continue;
    const op = (obs.observation_photos || [])[0];
    const photo = op && op.photo;
    if (!photo || !photo.url) continue;
    const license = (photo.license_code || '').toLowerCase();
    if (!CC_LICENSES.has(license)) continue; // skip copyrighted / unknown

    const id = `img-${sp.key}-${String(saved).padStart(2, '0')}`;
    const localPath = path.join(catDir, `${String(saved).padStart(2, '0')}-obs${obs.id}-photo${photo.id}.jpg`);
    let bytes = 0;
    try {
      if (fs.existsSync(localPath)) {
        bytes = fs.statSync(localPath).size; // idempotent re-run
      } else {
        bytes = await download(largeUrl(photo.url), localPath);
        await sleep(250);
      }
    } catch (e) {
      console.error(`[${sp.key}] download failed obs=${obs.id}: ${e.message}`);
      continue;
    }

    const descriptionText = [
      `Taxon: ${obs.taxon.name || 'unknown'}${obs.taxon.preferred_common_name ? ' (' + obs.taxon.preferred_common_name + ')' : ''}.`,
      obs.description ? `Observer notes: ${String(obs.description).slice(0, 300)}` : '',
      `Photo: ${photo.attribution || 'unknown'} — ${LICENSE_NAMES[license] || license}.`,
    ].filter(Boolean).join(' ');

    entries.push({
      id,
      categoryKey: sp.key,
      speciesHint: sp.species,
      title: `${obs.taxon.name || sp.scientific} — ${sp.grade} observation ${obs.id}`,
      localPath: path.relative(ROOT, localPath).split(path.sep).join('/'),
      sourceUrl: `https://www.inaturalist.org/observations/${obs.id}`,
      license: LICENSE_NAMES[license] || license,
      licenseCode: license,
      artist: photo.attribution || 'unknown',
      description: descriptionText,
      width: photo.width || null,
      height: photo.height || null,
      bytes,
      meta: {
        photoId: photo.id,
        observationId: obs.id,
        taxonName: obs.taxon.name,
        taxonRank: obs.taxon.rank,
        qualityGrade: obs.quality_grade,
        identifications: Array.isArray(obs.identifications) ? obs.identifications.length : null,
        ambiguous: Boolean(sp.ambiguous),
      },
    });
    saved++;
    process.stdout.write('.');
  }
  return entries;
}

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.mkdirSync(path.dirname(MANIFEST_PATH), { recursive: true });

  const only = process.argv[2];
  const targets = only ? SPECIES.filter((s) => s.key === only) : SPECIES;
  if (only && targets.length === 0) {
    console.error(`Unknown category key "${only}". Valid: ${SPECIES.map((s) => s.key).join(', ')}`);
    process.exitCode = 1;
    return;
  }

  // Merge mode: keep images from categories we are NOT re-fetching.
  let manifest = { images: [], categories: [] };
  if (fs.existsSync(MANIFEST_PATH)) {
    try {
      const prev = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
      const keepKeys = new Set(targets.map((t) => t.key));
      prev.images = prev.images.filter((i) => !keepKeys.has(i.categoryKey));
      prev.categories = prev.categories.filter((c) => !keepKeys.has(c.key));
      manifest = prev;
    } catch { /* corrupted manifest → rebuild */ }
  }
  manifest.source =
    'iNaturalist API v1. Wikimedia Commons was unreachable from the build network (ECONNRESET). ' +
    'Species categories: research-grade, species-level IDs. ambiguous_canid: needs-ID observations, genus-level Canis IDs (community could not separate wolf/dog/coyote).';
  manifest.licenseNote =
    'All photos carry a Creative Commons or public-domain license recorded per file with attribution. ' +
    'CC BY-NC files are included under fair-use educational terms; verify before any reuse.';
  manifest.generatedAt = new Date().toISOString();

  for (const sp of targets) {
    const entries = await fetchCategory(sp, manifest.images);
    manifest.images.push(...entries);
    manifest.categories.push({ key: sp.key, species: sp.species, scientific: sp.scientific, count: entries.length });
    console.log(`\n[${sp.key}] ${entries.length} images saved`);
  }

  manifest.images.sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
  const cc = manifest.images.filter((i) => i.licenseCode && CC_LICENSES.has(i.licenseCode)).length;
  console.log(`\nManifest: ${manifest.images.length} images (${cc} CC/PD) -> data/manifest.json`);
})().catch((e) => {
  console.error('CORPUS FETCH FAILED:', e);
  process.exitCode = 1;
});
