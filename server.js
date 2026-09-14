const express = require('express');
const cors = require('cors');

const app = express();
const PORT = Number(process.env.PORT || 3000);

app.use(cors({ origin: true }));
app.use(express.json({ limit: '2mb' }));

function requireApiKey(req, res, next) {
  const configured = process.env.HOMESTRO_API_KEY;
  if (!configured) {
    return res.status(503).json({ ok: false, error: 'API key is not configured on the server.' });
  }
  const auth = req.get('authorization') || '';
  const supplied = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!supplied || supplied !== configured) {
    return res.status(401).json({ ok: false, error: 'Unauthorized' });
  }
  next();
}

app.get('/', (_req, res) => {
  res.type('html').send(`<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Homestro AI Control</title><style>body{font-family:system-ui,-apple-system,sans-serif;margin:0;padding:32px;background:#f6f8f7;color:#17352b}main{max-width:760px;margin:auto;background:#fff;border-radius:16px;padding:28px;box-shadow:0 4px 24px #00000012}h1{margin-top:0}p{line-height:1.55}.ok{font-weight:700}code{background:#eef3f0;padding:3px 6px;border-radius:5px}</style></head><body><main><h1>Homestro AI Control</h1><p class="ok">● Backend online</p><p>AI-Steuerung für Homestro.de ist bereit.</p><p>Die Shopify-Produktdaten werden erst nach Prüfung veröffentlicht. Neue Produkte bleiben <strong>DRAFT</strong>, bis Miroslav sie freigibt.</p><p>API: <code>/health</code> · AI: <code>/api/ai/product</code> · Prüfung: <code>/api/products/validate</code></p></main></body></html>`);
});

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'homestro-ai-api', timestamp: new Date().toISOString() });
});

app.get('/api/status', requireApiKey, (_req, res) => {
  res.json({
    ok: true,
    service: 'homestro-ai-api',
    shopifyConfigured: Boolean(process.env.SHOPIFY_STORE_DOMAIN && process.env.SHOPIFY_ACCESS_TOKEN),
    openaiConfigured: Boolean(process.env.OPENAI_API_KEY),
    timestamp: new Date().toISOString()
  });
});

app.post('/api/products/validate', requireApiKey, (req, res) => {
  const cost = Number(req.body?.cost);
  const sellingPrice = Number(req.body?.sellingPrice);
  const ratio = Number(req.body?.ratio);
  if (![cost, sellingPrice, ratio].every(Number.isFinite)) {
    return res.status(400).json({ ok: false, error: 'cost, sellingPrice and ratio must be numbers.' });
  }
  const rules = {
    maxCost: Number(process.env.MAX_PRODUCT_COST || 10),
    minSellingPrice: Number(process.env.MIN_SELLING_PRICE || 34.90),
    minRatio: Number(process.env.MIN_PRICE_COST_RATIO || 3)
  };
  const valid = cost <= rules.maxCost && sellingPrice >= rules.minSellingPrice && ratio >= rules.minRatio;
  res.json({ ok: true, valid, product: { cost, sellingPrice, ratio }, rules });
});

function cleanJson(text) {
  const trimmed = String(text || '').trim();
  const withoutFence = trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  return JSON.parse(withoutFence);
}

app.post('/api/ai/product', requireApiKey, async (req, res) => {
  if (!process.env.OPENAI_API_KEY) return res.status(503).json({ ok: false, error: 'OPENAI_API_KEY is not configured.' });
  const input = req.body?.product || req.body;
  if (!input || typeof input !== 'object') return res.status(400).json({ ok: false, error: 'A product object is required.' });
  const model = process.env.OPENAI_MODEL || 'gpt-5-mini';
  const system = `Du bist der deutsche E-Commerce-Redakteur von Homestro.de. Erstelle hochwertige, ehrliche und verkaufsstarke Produktdaten auf Deutsch. Keine erfundenen technischen Daten, Zertifikate, Garantien oder Lieferzeiten. Ausgabe ausschließlich als gültiges JSON mit diesen Feldern: title, description, shortDescription, bullets (Array mit 5 Einträgen), seoTitle, seoDescription, handle, tags (Array), category. Die Texte müssen für einen allgemeinen deutschen Alltagsshop geeignet sein.`;
  const user = `Verarbeite dieses Produkt:\n${JSON.stringify(input, null, 2)}`;
  try {
    const response = await fetch('https://api.openai.com/v1/responses', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}` }, body: JSON.stringify({ model, input: [{ role: 'system', content: [{ type: 'input_text', text: system }] }, { role: 'user', content: [{ type: 'input_text', text: user }] }], max_output_tokens: 1800 }) });
    const data = await response.json();
    if (!response.ok) return res.status(502).json({ ok: false, error: 'OpenAI request failed.', details: data?.error?.message || 'Unknown OpenAI error' });
    const outputText = data.output_text || data.output?.flatMap(item => item.content || []).map(c => c.text || '').join('') || '';
    let product;
    try { product = cleanJson(outputText); } catch { return res.status(502).json({ ok: false, error: 'OpenAI returned invalid JSON.', raw: outputText.slice(0, 4000) }); }
    res.json({ ok: true, model, product });
  } catch (error) {
    console.error(error);
    res.status(502).json({ ok: false, error: 'Unable to reach OpenAI.' });
  }
});

app.use((_req, res) => res.status(404).json({ ok: false, error: 'Not found' }));
app.use((err, _req, res, _next) => { console.error(err); res.status(500).json({ ok: false, error: 'Internal server error' }); });
app.listen(PORT, '0.0.0.0', () => console.log(`Homestro AI Control API listening on port ${PORT}`));
