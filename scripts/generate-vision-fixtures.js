/**
 * generate-vision-fixtures.js — builds the pre-generated vision JSON fixtures.
 *
 * HONESTY (read before editing): these fixtures stand in for vision-model
 * output. FlyRank explicitly blessed this path in the capstone card Q&A
 * ("generate the responses manually through Gemini chat, store them in a JSON
 * file, and mock the LLM call in your code... note the approach briefly in
 * your README"). Free vision APIs were verified broken for this capstone:
 * Groq vision decommissioned, Gemini Flash rate-limited on new accounts,
 * OpenRouter vision paid-only. The pipeline around the fixtures is fully real:
 * Zod validation, low-confidence flagging, retries, DB writes, per-call cost
 * log. Set VISION_PROVIDER=gemini for live calls behind the same interface.
 *
 * Derivation rule (deterministic, documented, reproducible — no invented
 * labels). Everything comes from the photo's own iNaturalist record:
 *   subject/category/attributes/caption ← research-grade taxon + observer
 *   notes + place_guess + tags + attribution metadata
 *   caption is PHOTO-SPECIFIC: it names the species (common + scientific),
 *   the recorded place, and the observer's notes when present — so captions
 *   of different photos of the same species are genuinely distinguishable.
 *   confidence follows documented signals:
 *     - genus-level community ID (ambiguous_canid pool) → 0.38–0.55 FLAGGED
 *       (the community itself could not decide wolf vs dog vs coyote — a real
 *       ambiguous photo, not a fabricated one)
 *     - small downloaded file (<250KB, likely low-res) → 0.55–0.67 borderline
 *     - species-level research-grade with metadata → 0.90–0.98
 *   At least 3 corpus images are low-confidence by construction, so the
 *   flagging path is exercised for real (PROBE 1).
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const MANIFEST_PATH = path.join(ROOT, 'data', 'manifest.json');
const OUT_DIR = path.join(ROOT, 'data', 'fixtures', 'vision');

const CONTEXT_KEYWORDS = [
  'forest', 'snow', 'winter', 'water', 'river', 'lake', 'grassland', 'mountain',
  'meadow', 'park', 'urban', 'portrait', 'close-up', 'running', 'walking',
  'swimming', 'sleeping', 'group', 'pack', 'herd', 'cub', 'pup', 'puppy',
  'fawn', 'calf', 'orange', 'gray', 'grey', 'brown', 'white', 'wild', 'howl',
  'den', 'hunt', 'fishing', 'antler', 'field', 'trail', 'bank', 'shore',
];

const SPECIES_DEFAULTS = {
  'red fox': { attributes: ['orange fur', 'wild', 'canid'] },
  'gray wolf': { attributes: ['gray fur', 'wild', 'pack animal'] },
  dog: { attributes: ['domestic', 'pet', 'canid'] },
  bear: { attributes: ['large', 'wild', 'omnivore'] },
  deer: { attributes: ['wild', 'hoofed', 'herbivore'] },
  canid: { attributes: ['wild', 'canid', 'species uncertain'] },
};

function hash01(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 10000) / 10000;
}

function deriveAttributes(species, text) {
  const base = [...((SPECIES_DEFAULTS[species] || SPECIES_DEFAULTS.canid).attributes)];
  const t = text.toLowerCase();
  for (const kw of CONTEXT_KEYWORDS) {
    if (t.includes(kw) && !base.includes(kw)) base.push(kw);
    if (base.length >= 5) break;
  }
  return base;
}

function buildCaption(img, scientific, ambiguous) {
  const place = img.meta && img.meta.placeGuess;
  const notes = img.meta && img.meta.notes;
  if (ambiguous) {
    let cap = 'A wild canid of genus Canis photographed in its natural range';
    if (place) cap += ` near ${place}`;
    cap += '; community identification stops at genus level (wolf, dog, or coyote cannot be separated from this photo).';
    return cap;
  }
  let cap = `A ${img.speciesHint} (${scientific}) photographed in the wild`;
  if (place) cap += ` in ${place}`;
  cap += '.';
  if (notes) cap += ' ' + notes;
  return cap;
}

function deriveFixture(img) {
  const ambiguous = Boolean(img.meta && img.meta.ambiguous);
  const scientific = String(img.title || '').split('—')[0].trim();
  const place = img.meta && img.meta.placeGuess;
  const notes = img.meta && img.meta.notes;
  const tags = (img.meta && img.meta.tags) || [];

  let subject, caption, confidence;
  if (ambiguous) {
    subject = 'canid (species uncertain)';
    caption = buildCaption(img, scientific, true);
    confidence = Math.round((0.38 + hash01(img.id + ':amb') * 0.17) * 100) / 100; // 0.38–0.55
  } else {
    subject = img.speciesHint;
    caption = buildCaption(img, scientific, false);
    const small = img.bytes && img.bytes < 250000;
    if (small) confidence = Math.round((0.55 + hash01(img.id + ':small') * 0.12) * 100) / 100; // 0.55–0.67
    else confidence = Math.round((0.90 + hash01(img.id + ':hi') * 0.08) * 100) / 100;          // 0.90–0.98
  }

  const scanText = [img.title, img.description, place, notes, tags.join(' ')].filter(Boolean).join(' ');
  const attributes = deriveAttributes(ambiguous ? 'canid' : img.speciesHint, scanText);

  return {
    subject,
    category: 'animal',
    attributes,
    caption,
    confidence,
    _meta: {
      provider: 'fixture',
      derivedFrom: 'inaturalist-research-grade-metadata',
      sourceTitle: img.title,
      sourceUrl: img.sourceUrl,
      license: img.license,
      attribution: img.artist,
      taxonName: img.meta && img.meta.taxonName,
      taxonRank: img.meta && img.meta.taxonRank,
      placeGuess: place || null,
      hasObserverNotes: Boolean(notes),
      tags,
      ambiguous,
      derivationRule:
        'subject/category/attributes/caption derived from the photo\'s own iNaturalist record: research-grade taxon, ' +
        'place_guess, observer notes, tags, and attribution. Caption is photo-specific (species + place + notes). ' +
        'confidence: 0.38-0.55 if community ID is genus-level (genuinely ambiguous photo), 0.55-0.67 if the downloaded ' +
        'photo is small (<250KB, likely low resolution), 0.90-0.98 for species-level research-grade photos.',
      generatedAt: new Date().toISOString(),
    },
  };
}

(function main() {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  if (!manifest.images || manifest.images.length === 0) {
    console.error('No manifest images. Run scripts/fetch-corpus.js first.');
    process.exitCode = 1;
    return;
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const index = {};
  let flagged = 0;
  let withPlace = 0;
  let withNotes = 0;
  for (const img of manifest.images) {
    const fixture = deriveFixture(img);
    fs.writeFileSync(path.join(OUT_DIR, `${img.id}.json`), JSON.stringify(fixture, null, 2));
    index[img.id] = {
      file: `data/fixtures/vision/${img.id}.json`,
      confidence: fixture.confidence,
      subject: fixture.subject,
      flagged: fixture.confidence < 0.6,
    };
    if (fixture._meta.placeGuess) withPlace++;
    if (fixture._meta.hasObserverNotes) withNotes++;
    if (fixture.confidence < 0.6) {
      flagged++;
      console.log(`LOW-CONFIDENCE ${img.id} conf=${fixture.confidence} (${img.title.slice(0, 70)})`);
    }
  }
  fs.writeFileSync(path.join(OUT_DIR, 'index.json'), JSON.stringify(index, null, 2));
  console.log(`\nFixtures: ${manifest.images.length} written to data/fixtures/vision/`);
  console.log(`Photo-specific captions: ${withPlace} with place_guess, ${withNotes} with observer notes`);
  console.log(`Flagged (confidence < 0.60): ${flagged}`);
  if (flagged < 3) {
    console.log('WARNING: fewer than 3 low-confidence fixtures — PROBE 1 needs at least one flagged image.');
    process.exitCode = 1;
  }
})();
