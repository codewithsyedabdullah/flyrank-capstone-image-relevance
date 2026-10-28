/**
 * server.js — Express bootstrap. Layered: routes (HTTP/Zod boundary) →
 * services (logic) → repositories (SQLite). The error middleware is the last
 * line of defense: coded errors → clean 4xx/5xx JSON; anything unexpected →
 * generic 500, stack NEVER leaked (shared requirement #2).
 *
 * On boot it also self-provisions an empty database (migrate → seed → tag →
 * embed, all zero-cost providers only — see src/services/provision.js), so
 * `npm start` works on a fresh clone. Set AUTO_PROVISION=0 to disable.
 */
require('./config');
const express = require('express');
const apiRoutes = require('./routes/api');
const config = require('./config');
const { migrate } = require('./db/migrate');
const { provision } = require('./services/provision');

function createApp() {
  const app = express();
  app.use(express.json({ limit: '1mb' }));

  app.get('/', (req, res) => {
    res.json({
      name: 'flyrank-capstone-image-relevance',
      description: 'AI Image Understanding & Content Matching Engine — FlyRank BE capstone',
      health: '/api/health',
    });
  });

  app.use('/api', apiRoutes);

  app.use((req, res) => res.status(404).json({ error: 'not found', path: req.path }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err && err.name === 'ZodError') {
      return res.status(400).json({
        error: 'validation failed',
        details: err.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
      });
    }
    if (err && (err.type === 'entity.parse.failed' || err.type === 'entity.too.large')) {
      return res.status(400).json({ error: 'request body must be valid JSON (max 1mb)' });
    }
    if (err && typeof err.status === 'number' && err.status >= 400 && err.status < 500) {
      return res.status(err.status).json({ error: err.message || 'bad request' });
    }
    const code = err && err.code;
    if (code === 'NOT_FOUND') return res.status(404).json({ error: err.message });
    if (code === 'BAD_FORCE_IMAGE' || code === 'VALIDATION') return res.status(400).json({ error: err.message });
    if (code === 'ALREADY_TAGGED' || code === 'NO_EMBEDDING' || code === 'NO_CANDIDATES' || code === 'BUDGET_EXCEEDED') {
      return res.status(409).json({ error: err.message });
    }
    if (code === 'SCHEMA_INVALID' || code === 'PROVIDER_INVALID_JSON') return res.status(422).json({ error: err.message });
    if (code === 'PROVIDER_HTTP' || code === 'FIXTURE_MISSING') return res.status(502).json({ error: err.message });
    console.error('[server] unhandled error:', err);
    return res.status(500).json({ error: 'internal error' });
  });

  return app;
}

if (require.main === module) {
  (async () => {
    if (process.env.AUTO_PROVISION === '0') {
      migrate();
      console.log('[server] auto-provision disabled (AUTO_PROVISION=0); database must be bootstrapped manually');
    } else {
      const counts = await provision();
      console.log('[server] provisioned counts:', JSON.stringify(counts));
    }
    createApp().listen(config.port, () => {
      console.log(`[server] listening on http://localhost:${config.port} (tenant=${config.tenantId})`);
      console.log(`[server] vision=${config.visionProvider} embedding=${config.embeddingProvider}/${config.embeddingModel}`);
      console.log(`[server] thresholds: similarity=${config.similarityThreshold} lowConfidence=${config.lowConfidenceThreshold}`);
    });
  })().catch((e) => {
    console.error('[server] boot failed:', e);
    process.exit(1);
  });
}

module.exports = { createApp };
