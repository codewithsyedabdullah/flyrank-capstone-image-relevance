/**
 * Vision providers — same interface, two implementations.
 *
 *   tagImage(image) -> raw model output (NOT yet trusted; the service layer
 *   Zod-validates it. Invalid output is retried, then flagged — never accepted.)
 *
 * - FixtureVisionProvider: reads pre-generated JSON (data/fixtures/vision/).
 *   This is the FlyRank-blessed $0 path (capstone card Q&A, 8/6/2026): free
 *   vision APIs were verified broken (Groq vision decommissioned, Gemini Flash
 *   rate-limited to zero on new accounts, OpenRouter vision paid-only). The
 *   fixtures are derived from real iNaturalist research-grade metadata — no
 *   invented labels.
 * - GeminiVisionProvider: live Google AI Studio calls, env-selectable
 *   (VISION_PROVIDER=gemini + GEMINI_API_KEY). Implemented behind the same
 *   interface so the swap is one env var.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');

class FixtureVisionProvider {
  constructor() {
    this.name = 'fixture';
    this.model = 'fixtures derived from iNaturalist metadata (FlyRank-blessed mock)';
    this.priceUsdPerCall = 0; // local JSON — no API spend
  }

  async tagImage(image) {
    const file = path.join(ROOT, 'data', 'fixtures', 'vision', `${image.id}.json`);
    if (!fs.existsSync(file)) {
      const err = new Error(`no vision fixture for ${image.id}`);
      err.code = 'FIXTURE_MISSING';
      throw err;
    }
    // Return the fixture EXACTLY as a model would return it — the service
    // layer validates it with the same Zod schema as a live response.
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  }
}

class GeminiVisionProvider {
  constructor(apiKey) {
    if (!apiKey) throw new Error('GEMINI_API_KEY required for VISION_PROVIDER=gemini');
    this.apiKey = apiKey;
    this.name = 'gemini';
    this.model = 'gemini-2.0-flash';
    this.priceUsdPerCall = 0.0001; // documented list-price estimate: ~1k input tokens (image+prompt) at $0.10/1M input tokens
  }

  async tagImage(image) {
    const imgBytes = fs.readFileSync(path.join(ROOT, image.localPath));
    const inline = {
      inline_data: { mime_type: 'image/jpeg', data: imgBytes.toString('base64') },
    };
    const prompt =
      'You are an image cataloging assistant. Describe the MAIN animal in this photo. ' +
      'Respond with ONLY a JSON object (no markdown, no commentary) matching exactly: ' +
      '{"subject":"<species common name, e.g. red fox>","category":"animal",' +
      '"attributes":["<up to 5 short visual attributes>"],' +
      '"caption":"<one factual sentence>","confidence":<0.0-1.0 your certainty of the species>}. ' +
      'If you are not certain of the species, say so by lowering confidence — never guess.';

    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${this.apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(30000),
        body: JSON.stringify({
          contents: [{ parts: [inline, { text: prompt }] }],
          generationConfig: { temperature: 0.2 },
        }),
      }
    );
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const err = new Error(`gemini HTTP ${res.status}: ${body.slice(0, 200)}`);
      err.code = 'PROVIDER_HTTP';
      throw err;
    }
    const json = await res.json();
    const text = json.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '';
    const cleaned = text.replace(/```(?:json)?/g, '').trim();
    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch (e) {
      const err = new Error('gemini output was not valid JSON');
      err.code = 'PROVIDER_INVALID_JSON';
      throw err;
    }
    return parsed;
  }
}

function getVisionProvider(env = process.env) {
  const provider = (env.VISION_PROVIDER || 'fixture').toLowerCase();
  if (provider === 'gemini') return new GeminiVisionProvider(env.GEMINI_API_KEY);
  if (provider === 'fixture') return new FixtureVisionProvider();
  throw new Error(`unknown VISION_PROVIDER "${provider}" (expected fixture|gemini)`);
}

module.exports = { getVisionProvider, FixtureVisionProvider, GeminiVisionProvider };
