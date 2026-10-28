/**
 * Vector utilities — L2 normalization + cosine similarity.
 * Vectors are stored L2-normalized, so cosine similarity is a dot product.
 */

function l2Normalize(vec) {
  let sum = 0;
  for (let i = 0; i < vec.length; i++) sum += vec[i] * vec[i];
  const norm = Math.sqrt(sum);
  if (norm === 0) return vec.map(() => 0);
  return vec.map((x) => x / norm);
}

/** Cosine similarity in [-1, 1]. Returns 0 for empty/mismatched vectors. */
function cosine(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot; // valid because both sides are stored normalized
}

function meanVector(vectors) {
  if (!vectors.length) return null;
  const dim = vectors[0].length;
  const out = new Array(dim).fill(0);
  for (const v of vectors) for (let i = 0; i < dim; i++) out[i] += v[i];
  return out.map((x) => x / vectors.length);
}

module.exports = { l2Normalize, cosine, meanVector };
