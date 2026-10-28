/**
 * API boundary schemas (shared requirement #2: validation at the boundary —
 * bad input → clean 4xx, never a 500).
 */
const { z } = require('zod');

const matchQuerySchema = z.object({
  top: z.coerce.number().int().min(1).max(50).default(5),
  force_image: z.string().min(1).max(120).optional(),
});

const jobStartSchema = z.object({
  force: z.boolean().optional().default(false),
});

const reviewApproveSchema = z.object({
  reviewer: z.string().min(1).max(120).optional(),
});

const reviewRejectSchema = z.object({
  reviewer: z.string().min(1).max(120).optional(),
  reason: z.string().min(3, 'reject requires a reason (min 3 chars)').max(500),
});

const tagQuerySchema = z.object({
  force: z.coerce.boolean().optional().default(false),
});

module.exports = {
  matchQuerySchema,
  jobStartSchema,
  reviewApproveSchema,
  reviewRejectSchema,
  tagQuerySchema,
};
