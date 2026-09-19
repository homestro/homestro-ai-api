const express = require('express');

const app = express();
const PORT = Number(process.env.PORT || 8090);
app.use(express.json({ limit: '2mb' }));

function apiKey(req, res, next) {
  const key = String(process.env.HOMESTRO_API_KEY || '').trim();
  if (!key) return res.status(503).json({ ok: false, error: 'HOMESTRO_API_KEY is not configured.' });
  const auth = req.get('authorization') || '';
  if (auth !== 'Bearer ' + key) return res.status(401).json({ ok: false, error: 'Unauthorized' });
  next();
}

function providerStatus() {
  return {
    meta: Boolean(process.env.META_ACCESS_TOKEN && process.env.META_AD_ACCOUNT_ID),
    google: Boolean(process.env.GOOGLE_ADS_DEVELOPER_TOKEN && process.env.GOOGLE_ADS_CUSTOMER_ID),
    microsoft: Boolean(process.env.MICROSOFT_ADS_CLIENT_ID && process.env.MICROSOFT_ADS_CUSTOMER_ID),
    openai: Boolean(process.env.OPENAI_API_KEY),
    video: Boolean(process.env.HOMESTRO_VIDEO_PROVIDER_API_KEY)
  };
}

app.get('/health', (_req, res) => res.json({
  ok: true,
  service: 'homestro-marketing-engine',
  timestamp: new Date().toISOString()
}));

app.get('/api/marketing/status', apiKey, (_req, res) => {
  const p = providerStatus();
  res.json({
    ok: true,
    mode: 'SAFE_DRY_RUN',
    liveCampaignWrites: false,
    providers: p,
    ready: Boolean(p.openai),
    missing: Object.entries(p).filter(([, v]) => !v).map(([k]) => k)
  });
});

function number(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function buildPlan(product, options = {}) {
  const price = number(product.selling_price ?? product.sellingPrice);
  const cost = number(product.cost);
  const shipping = number(product.shipping_cost ?? product.shippingCost);
  const fee = number(product.fees);
  const grossContribution = price - cost - shipping - fee;
  const dailyBudget = Math.max(1, number(options.daily_budget ?? options.dailyBudget, 10));
  const targetCpa = Math.max(1, number(options.target_cpa ?? options.targetCpa, grossContribution * 0.35));
  const minRoas = Math.max(1, number(options.min_roas ?? options.minRoas, 2.5));

  return {
    product_id: String(product.id || product.source_product_id || ''),
    title: String(product.title || '').trim(),
    price,
    economics: {
      cost,
      shipping,
      fees: fee,
      gross_contribution: Number(grossContribution.toFixed(2)),
      target_cpa: Number(targetCpa.toFixed(2)),
      minimum_roas: Number(minRoas.toFixed(2))
    },
    test: {
      daily_budget: Number(dailyBudget.toFixed(2)),
      test_days: 3,
      max_test_spend: Number((dailyBudget * 3).toFixed(2)),
      stop_rules: [
        'pause if spend exceeds the test budget without a purchase',
        'pause if CPA remains above target after sufficient conversion data',
        'pause if product becomes unavailable or price/economics change'
      ]
    },
    channels: ['META', 'GOOGLE'],
    creative_variants: 3,
    live_write: false
  };
}

async function generateCopy(product) {
  if (!process.env.OPENAI_API_KEY) {
    return {
      title: String(product.title || ''),
      primary_text: '',
      headline: '',
      description: '',
      note: 'OPENAI_API_KEY is not configured.'
    };
  }

  const model = process.env.OPENAI_MODEL || 'gpt-5-mini';
  const input = {
    title: product.title,
    description: String(product.description || '').replace(/<[^>]+>/g, ' ').slice(0, 5000),
    price: product.selling_price ?? product.sellingPrice,
    category: product.category
  };

  const prompt = [
    'Du bist der Werbetexter von Homestro.de.',
    'Erstelle deutsche, sachliche Performance-Werbung für Meta und Google.',
    'Verwende nur Angaben aus den Quelldaten. Keine erfundenen Versprechen.',
    'Gib ausschließlich JSON mit primary_text, headline, description und three_hooks zurück.',
    JSON.stringify(input)
  ].join('\n');

  const r = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + process.env.OPENAI_API_KEY
    },
    body: JSON.stringify({
      model,
      input: [{ role: 'user', content: [{ type: 'input_text', text: prompt }] }],
      text: { format: { type: 'json_object' } },
      max_output_tokens: 900
    })
  });

  const raw = await r.text();
  let data = {};
  try { data = JSON.parse(raw); } catch {
    throw new Error('OpenAI returned non-JSON HTTP ' + r.status);
  }
  if (!r.ok) throw new Error(data?.error?.message || 'OpenAI request failed');

  const text = data.output_text ||
    data.output?.flatMap(x => x.content || []).map(x => x.text || '').join('') || '';

  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('AI returned no JSON object');
  return JSON.parse(text.slice(start, end + 1));
}

app.post('/api/marketing/plan', apiKey, async (req, res) => {
  try {
    const products = Array.isArray(req.body?.products) ? req.body.products : [];
    if (!products.length) return res.status(400).json({ ok: false, error: 'products[] is required.' });

    const options = req.body?.options || {};
    const plans = products.slice(0, 50).map(p => buildPlan(p, options));
    const creatives = [];

    for (const p of products.slice(0, Math.min(10, products.length))) {
      try {
        creatives.push({ product_id: String(p.id || p.source_product_id || ''), ok: true, copy: await generateCopy(p) });
      } catch (e) {
        creatives.push({ product_id: String(p.id || p.source_product_id || ''), ok: false, error: e.message });
      }
    }

    res.json({
      ok: true,
      mode: 'SAFE_DRY_RUN',
      live_write: false,
      plans,
      creatives,
      providers: providerStatus()
    });
  } catch (e) {
    res.status(502).json({ ok: false, error: e.message });
  }
});

app.post('/api/marketing/campaign', apiKey, (_req, res) => {
  res.status(409).json({
    ok: false,
    live_write: false,
    error: 'Live campaign creation is intentionally disabled until Meta/Google credentials and explicit launch approval are configured.'
  });
});

app.listen(PORT, () => console.log('Homestro Marketing Engine listening on ' + PORT));
