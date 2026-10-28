/**
 * enrich-corpus.js — merges per-observation detail (place_guess, observer
 * notes, tags, date) from the iNaturalist API into data/manifest.json.
 *
 * Why: vision captions and eval posts must be PHOTO-SPECIFIC, not species-
 * generic, or exact-image top-1 precision measures noise (10 near-identical
 * fox captions are indistinguishable). All enrichment comes from the photo's
 * own iNaturalist record — real metadata, nothing invented.
 *
 * Idempotent + merge-safe: only refreshes the fields it owns.
 */
const fs = require('fs');
const path = require('path');

const API = 'https://api.inaturalist.org/v1';
const UA = 'FlyRankCapstoneImageRelevance/1.0 (student capstone; contact: abdullah2684511@gmail.com)';
const ROOT = path.join(__dirname, '..');
const MANIFEST_PATH = path.join(ROOT, 'data', 'manifest.json');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getObservation(obsId) {
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(`${API}/observations/${obsId}`, {
        headers: { 'User-Agent': UA },
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const j = await res.json();
      // v1 envelopes even single-resource GETs: results is an array of one.
      const obs = Array.isArray(j.results) ? j.results[0] : j.results;
      if (!obs) throw new Error('empty results');
      return obs;
    } catch (e) {
      lastErr = e;
      if (attempt < 3) await sleep(1200 * attempt);
    }
  }
  throw lastErr;
}

function clean(text, max = 240) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

(async () => {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  let enriched = 0;
  let withPlace = 0;
  let withNotes = 0;
  let withTags = 0;

  for (const img of manifest.images) {
    const obsId = img.meta && img.meta.observationId;
    if (!obsId) continue;
    let obs;
    try {
      obs = await getObservation(obsId);
    } catch (e) {
      console.error(`enrich failed obs=${obsId}: ${e.message}`);
      continue;
    }
    const place = obs.place_guess ? clean(obs.place_guess, 80) : null;
    const notes = obs.description ? clean(obs.description) : null;
    const tags = Array.isArray(obs.tags) ? obs.tags.slice(0, 8) : [];

    img.meta.placeGuess = place;
    img.meta.notes = notes;
    img.meta.tags = tags;
    img.meta.observedTime = obs.time_observed_at || null;
    if (place) withPlace++;
    if (notes) withNotes++;
    if (tags.length) withTags++;

    // Rebuild the stored description: observer notes (if any) + taxon + attribution.
    const parts = [];
    if (notes) parts.push(`Observer notes: ${notes}`);
    parts.push(`Taxon: ${obs.taxon ? obs.taxon.name : img.title} — ${img.title.split('—')[0].trim()}.`);
    if (place) parts.push(`Location: ${place}.`);
    parts.push(`Photo: ${img.artist} — ${img.license}.`);
    img.description = parts.join(' ');
    enriched++;
    process.stdout.write('.');
    await sleep(220); // polite to the keyless API
  }

  manifest.enrichedAt = new Date().toISOString();
  manifest.enrichmentNote =
    'Per-observation detail (place_guess, description/observer notes, tags, observed_time) merged from the iNaturalist API by scripts/enrich-corpus.js. Used to make vision captions and eval posts photo-specific.';
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
  console.log(`\nenriched ${enriched}/${manifest.images.length} images`);
  console.log(`with place_guess: ${withPlace} | with notes: ${withNotes} | with tags: ${withTags}`);
})().catch((e) => {
  console.error('ENRICH FAILED:', e);
  process.exitCode = 1;
});
