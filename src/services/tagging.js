/**
 * tagging service — turns a raw vision response into trusted, persisted
 * metadata. The core lesson of the capstone: the model is an
 * unreliable-but-useful component. Its output is Zod-validated here; invalid
 * output is NEVER trusted (it propagates as SCHEMA_INVALID so the batch job
 * retries, then flags). Low confidence is flagged, not accepted silently.
 */
const { validateVisionOutput } = require('../schema/vision');
const repos = require('../repositories');
const config = require('../config');

/**
 * Validate + persist one image's vision output.
 * @throws with code 'SCHEMA_INVALID' when the model output fails the schema.
 * @returns {{metadata:object, flagged:boolean}}
 */
function processVisionResponse(imageId, rawResponse) {
  const v = validateVisionOutput(rawResponse);
  if (!v.ok) {
    const err = new Error(v.error);
    err.code = 'SCHEMA_INVALID';
    throw err;
  }
  const data = v.data;
  repos.upsertMetadata(imageId, data, rawResponse);
  repos.replaceTags(imageId, data);

  const flagged = data.confidence < config.lowConfidenceThreshold;
  repos.updateImageStatus(imageId, flagged ? 'flagged' : 'tagged', { lowConfidence: flagged });
  return { metadata: data, flagged };
}

module.exports = { processVisionResponse };
