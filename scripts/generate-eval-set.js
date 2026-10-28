/**
 * generate-eval-set.js — builds the labeled eval set AND the blog posts from
 * the enriched corpus manifest.
 *
 * Design (why exact-image top-1 is measurable here): a post describes ONE
 * specific photo — its species, its recorded place_guess, and its observer
 * notes/tags — so the labeled image's caption is semantically closer to its
 * post than the other same-species photos (different places/notes). If the
 * system can't tell them apart, precision honestly drops. No invented facts:
 * every place/notes phrase comes from the photo's own iNaturalist record.
 *
 * Output:
 *   seeds/posts.json     15 photo-specific posts (3 per species) + 1 out-of-
 *                        corpus post (snow leopard) that must get "no match"
 *   seeds/eval-set.json  15 labels: postId -> correctImageId
 *
 * Deterministic: richest-metadata images first, then id order. Re-runnable.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const MANIFEST_PATH = path.join(ROOT, 'data', 'manifest.json');
const POSTS_PATH = path.join(ROOT, 'seeds', 'posts.json');
const EVAL_PATH = path.join(ROOT, 'seeds', 'eval-set.json');

const SPECIES = [
  {
    key: 'red_fox', slug: 'fox', common: 'red fox', scientific: 'Vulpes vulpes',
    facts: [
      'Red foxes are the largest of the true foxes and live on every continent except Antarctica.',
      'A red fox can hear a mouse move under a meter of snow and pounces in a high arc to catch it.',
      'Fox kits are born blind in spring dens and emerge at about one month old.',
    ],
  },
  {
    key: 'wolf', slug: 'wolf', common: 'gray wolf', scientific: 'Canis lupus',
    facts: [
      'Gray wolves live in family packs led by a breeding pair, and their howls can carry for miles.',
      'Wolves were reintroduced to Yellowstone in 1995, and elk herds changed their behavior within years.',
      "A wolf's paws are larger than a domestic dog's, an adaptation for traveling snow.",
    ],
  },
  {
    key: 'dog', slug: 'dog', common: 'dog', scientific: 'Canis familiaris',
    facts: [
      'Domestic dogs descended from wolves and were the first animals humans tamed.',
      'Dogs read human gestures like pointing better than any other species, including chimpanzees.',
      'Puppies open their eyes at about two weeks, and early socialization shapes a calm adult.',
    ],
  },
  {
    key: 'bear', slug: 'bear', common: 'brown bear', scientific: 'Ursus arctos',
    facts: [
      'Brown bears are omnivores that fatten on salmon, berries, and roots before winter dens.',
      'A bear\'s heart rate drops sharply during winter sleep, and cubs are born while the mother dozes.',
      'Despite their size, brown bears can sprint at speeds over 30 miles per hour.',
    ],
  },
  {
    key: 'deer', slug: 'deer', common: 'white-tailed deer', scientific: 'Odocoileus virginianus',
    facts: [
      'Male white-tailed deer grow and shed antlers each year, clashing during the autumn rut.',
      'A startled deer bounds away in explosive zigzags, and its white tail flags the danger to others.',
      'Deer ears swivel independently toward every rustle in the underbrush.',
    ],
  },
];

const PER_SPECIES = 3;

function richness(img) {
  const m = img.meta || {};
  return (m.placeGuess ? 2 : 0) + (m.notes ? 2 : 0) + ((m.tags && m.tags.length) ? 1 : 0);
}

function clean(text, max = 220) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

function buildPost(sp, img, idx) {
  const place = img.meta && img.meta.placeGuess;
  const notes = img.meta && img.meta.notes;
  const tags = (img.meta && img.meta.tags) || [];
  const placePhrase = place ? `in ${place}` : 'in the wild';

  const title = place
    ? `${cap(sp.common)} near ${place.split(',')[0]}`
    : `${cap(sp.common)} ${['at dusk', 'in its range', 'up close'][idx % 3]}`;

  const s1 = `A ${sp.common} (${sp.scientific}) photographed ${placePhrase}.`;
  let s2;
  if (notes) s2 = `Field notes from the observation: ${clean(notes)}.`;
  else if (tags.length) s2 = `Recorded field tags: ${tags.slice(0, 6).join(', ')}.`;
  else s2 = 'The observation record carries no extra notes — the photo speaks for itself.';
  const s3 = sp.facts[idx % sp.facts.length];

  return {
    id: `p-${sp.slug}-${idx + 1}`,
    title,
    body: `${s1} ${s2} ${s3}`,
    categoryHint: 'animal',
    speciesHint: sp.common,
  };
}

function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

// Greedy selection: richest metadata first, but PREFER DISTINCT place_guess
// values. Two same-species photos from the same place with no observer notes
// are textually indistinguishable — any system would fail one of them, so the
// labeled set must be distinguishable by its own real metadata.
function selectEvalImages(images, n) {
  const pool = images
    .map((i) => ({ img: i, r: richness(i) }))
    .sort((a, b) => b.r - a.r || a.img.id.localeCompare(b.img.id));
  const picked = [];
  const places = new Set();
  for (const c of pool) {
    if (picked.length >= n) break;
    const place = c.img.meta.placeGuess || '';
    if (!places.has(place)) { picked.push(c.img); places.add(place); }
  }
  for (const c of pool) {
    if (picked.length >= n) break;
    if (!picked.some((p) => p.id === c.img.id)) picked.push(c.img);
  }
  return picked;
}

(function main() {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  const posts = [];
  const evalSet = [];

  for (const sp of SPECIES) {
    const pool = selectEvalImages(manifest.images.filter((i) => i.categoryKey === sp.key), PER_SPECIES);

    if (pool.length < PER_SPECIES) {
      console.error(`NOT ENOUGH enriched images for ${sp.key} (${pool.length}/${PER_SPECIES}) — run enrich-corpus.js first.`);
      process.exitCode = 1;
      return;
    }

    pool.forEach((img, idx) => {
      const post = buildPost(sp, img, idx);
      posts.push(post);
      evalSet.push({
        postId: post.id,
        correctImageId: img.id,
        expectedSpecies: sp.common,
        note: `post describes iNaturalist observation ${img.meta.observationId}${img.meta.placeGuess ? ' (' + img.meta.placeGuess + ')' : ''}; labeled correct image: ${img.id}`,
      });
    });
  }

  // Out-of-corpus post: no image should clear the bar (PROBE 4).
  posts.push({
    id: 'p-other-1',
    title: 'Snow leopards of the high Himalaya',
    body: 'The snow leopard stalks cliff faces above 3,000 meters, ghost-gray against the rock. Few big cats are so hard to photograph in the wild.',
    categoryHint: 'animal',
    speciesHint: 'snow leopard',
  });

  fs.mkdirSync(path.dirname(POSTS_PATH), { recursive: true });
  fs.writeFileSync(POSTS_PATH, JSON.stringify(posts, null, 2));
  fs.writeFileSync(EVAL_PATH, JSON.stringify(evalSet, null, 2));

  console.log(`Eval set: ${evalSet.length} labeled posts -> seeds/eval-set.json`);
  console.log(`Posts: ${posts.length} (15 photo-specific + 1 out-of-corpus) -> seeds/posts.json`);
  for (const e of evalSet) {
    const p = posts.find((x) => x.id === e.postId);
    console.log(`  ${e.postId} -> ${e.correctImageId} | "${p.title}"`);
  }
})();
