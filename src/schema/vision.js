/**
 * Zod schema for the vision model's structured output (brief §4.1).
 * Every vision response — live API or fixture — is safeParse'd through here.
 * Invalid output is never trusted: it is retried, then flagged, never accepted.
 */
const { z } = require('zod');

const visionOutputSchema = z.object({
  subject: z.string().min(1, 'subject is required'),
  category: z.enum(['animal', 'landscape', 'object', 'person', 'plant', 'other']),
  attributes: z.array(z.string().min(1)).min(1, 'at least one attribute required'),
  caption: z.string().min(10, 'caption must be at least 10 characters'),
  confidence: z.number().min(0).max(1, 'confidence must be between 0 and 1'),
});

/**
 * Validate a vision response. Never throws — returns a discriminated result.
 * @returns {{ok:true, data:object}|{ok:false, error:string}}
 */
function validateVisionOutput(input) {
  const parsed = visionOutputSchema.safeParse(input);
  if (parsed.success) return { ok: true, data: parsed.data };
  const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
  return { ok: false, error: `schema validation failed — ${issues.join('; ')}` };
}

module.exports = { visionOutputSchema, validateVisionOutput };
