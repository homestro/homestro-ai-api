'use strict';

const CATALOG_TTL_MS = 3 * 60 * 1000;
const RATE_WINDOW_MS = 5 * 60 * 1000;
const MAX_REQUESTS_PER_WINDOW = 20;
let catalogCache = { expiresAt: 0, products: [], policies: [] };
const rateMap = new Map();

function cleanHtml(html) {
  return String(html || '').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'").replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/\s+/g, ' ').trim();
}

function languageOf(message) {
  const text = String(message || '').toLowerCase();
  if (/\b(doprava|vrácen|vratit|kolik|dostupnost|skladem|cena|produkt|objednáv|zboží|jak|kdy)\b/.test(text)) return 'cs';
  if (/\b(versand|lieferung|retoure|rückgabe|kostet|preis|verfügbar|lagernd|produkt|bestellung|wann|wie)\b/.test(text)) return 'de';
  if (/\b(shipping|delivery|return|refund|price|available|stock|product|order|how|when)\b/.test(text)) return 'en';
  return 'de';
}

function words(text) {
  return new Set(String(text || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').match(/[a-z0-9]{3,}/g) || []);
}

function scoreProduct(product, message) {
  const query = words(message);
  const title = words(product.title);
  const haystack = words(`${product.title} ${product.handle} ${cleanHtml(product.descriptionHtml)}`);
  let score = 0;
  for (const token of query) {
    if (title.has(token)) score += 4;
    else if (haystack.has(token)) score += 1;
  }
  return score;
}

function formatPrice(product) {
  const values = (product.variants?.nodes || []).map(v => Number(v.price)).filter(v => Number.isFinite(v) && v >= 0);
  if (!values.length) return '';
  const min = Math.min(...values);
  const max = Math.max(...values);
  const fmt = value => new Intl.NumberFormat('de-DE', { style: 'currency', currency: product.currencyCode || 'EUR' }).format(value);
  return min === max ? fmt(min) : `${fmt(min)}–${fmt(max)}`;
}

function allowedOrigin(origin) {
  if (!origin) return true;
  let hostname;
  try { hostname = new URL(origin).hostname.toLowerCase(); } catch { return false; }
  const shopHost = String(process.env.SHOPIFY_STORE_DOMAIN || '').trim().replace(/^https?:\/\//i, '').replace(/\/$/, '').toLowerCase();
  const permitted = new Set(['homestro.de', 'www.homestro.de']);
  if (shopHost) permitted.add(shopHost);
  return permitted.has(hostname);
}

function registerShopifyCustomerChat(app, { graphql }) {
  async function getStoreData() {
    if (catalogCache.expiresAt > Date.now()) return catalogCache;
    let after = null;
    const products = [];
    let policies = [];
    for (let page = 0; page < 5; page++) {
      const data = await graphql(
        'query($first:Int!,$after:String){shop{shopPolicies{type title body url}} products(first:$first,after:$after,query:"status:active"){nodes{id title handle descriptionHtml onlineStoreUrl priceRangeV2{minVariantPrice{currencyCode}} variants(first:50){nodes{price availableForSale inventoryQuantity}}}} pageInfo{hasNextPage endCursor}}',
        { first: 100, after }
      );
      if (page === 0) policies = data.shop?.shopPolicies || [];
      for (const product of data.products?.nodes || []) {
        product.currencyCode = product.priceRangeV2?.minVariantPrice?.currencyCode || 'EUR';
        products.push(product);
      }
      if (!data.products?.pageInfo?.hasNextPage || !data.products.pageInfo.endCursor) {
        catalogCache = { expiresAt: Date.now() + CATALOG_TTL_MS, products, policies };
        return catalogCache;
      }
      after = data.products.pageInfo.endCursor;
    }
    catalogCache = { expiresAt: Date.now() + CATALOG_TTL_MS, products, policies };
    return catalogCache;
  }

  function policyFor(policies, typeMatch) {
    return (policies || []).find(policy => String(policy.type || '').toLowerCase().includes(typeMatch));
  }

  function fallbackAnswer(message, products, policies) {
    const lang = languageOf(message);
    const terms = /shipping|delivery|versand|liefer|doprava/i.test(message);
    const returns = /return|refund|retour|rück|zurück|vrác|reklam/i.test(message);
    const ranked = products.map(product => ({ product, score: scoreProduct(product, message) })).sort((a, b) => b.score - a.score);
    const match = ranked[0]?.score > 0 ? ranked[0].product : null;
    let answer = '';
    if (match) {
      const price = formatPrice(match);
      const available = (match.variants?.nodes || []).some(v => v.availableForSale === true);
      const description = cleanHtml(match.descriptionHtml).slice(0, 420);
      const url = match.onlineStoreUrl || `https://homestro.de/products/${match.handle}`;
      if (lang === 'cs') answer = `V obchodě jsem našel: ${match.title}${price ? ` — ${price}` : ''}. ${available ? 'Je dostupný k nákupu.' : 'Dostupnost momentálně není potvrzena.'}${description ? ` ${description}` : ''} Odkaz: ${url}`;
      else if (lang === 'en') answer = `I found this in the shop: ${match.title}${price ? ` — ${price}` : ''}. ${available ? 'It is available to buy.' : 'Availability is not currently confirmed.'}${description ? ` ${description}` : ''} Link: ${url}`;
      else answer = `Im Shop gefunden: ${match.title}${price ? ` — ${price}` : ''}. ${available ? 'Der Artikel ist bestellbar.' : 'Die Verfügbarkeit ist derzeit nicht bestätigt.'}${description ? ` ${description}` : ''} Zum Produkt: ${url}`;
    } else {
      const list = ranked.slice(0, 3).map(({ product }) => `${product.title}${formatPrice(product) ? ` (${formatPrice(product)})` : ''}: ${product.onlineStoreUrl || `https://homestro.de/products/${product.handle}`}`).join(' | ');
      if (lang === 'cs') answer = list ? `Produkt jsem nedokázal přesně určit. Tady jsou dostupné možnosti z obchodu: ${list}. Napište prosím přesný název.` : 'Produkt se mi nepodařilo najít. Napište prosím jeho přesný název.';
      else if (lang === 'en') answer = list ? `I couldn't identify the exact product. Here are a few shop options: ${list}. Please send the exact product name.` : 'I could not find that product. Please provide its exact name.';
      else answer = list ? `Ich konnte das Produkt nicht eindeutig zuordnen. Hier sind passende Artikel aus dem Shop: ${list}. Bitte nennen Sie den genauen Produktnamen.` : 'Ich konnte das Produkt nicht finden. Bitte nennen Sie den genauen Produktnamen.';
    }
    if (terms || returns) {
      const requestedPolicies = [];
      if (terms) requestedPolicies.push({ policy: policyFor(policies, 'shipping'), label: lang === 'cs' ? 'Doprava' : lang === 'en' ? 'Shipping' : 'Versand', missing: lang === 'cs' ? 'informace o dopravě' : lang === 'en' ? 'shipping details' : 'Versandinformationen' });
      if (returns) requestedPolicies.push({ policy: policyFor(policies, 'refund') || policyFor(policies, 'return'), label: lang === 'cs' ? 'Vrácení zboží' : lang === 'en' ? 'Returns' : 'Rückgabe', missing: lang === 'cs' ? 'informace o vrácení' : lang === 'en' ? 'return details' : 'Rückgabeinformationen' });
      for (const item of requestedPolicies) {
        if (item.policy) {
          const body = cleanHtml(item.policy.body).slice(0, 900);
          answer += `\n\n${item.label}: ${body}${item.policy.url ? ` (${item.policy.url})` : ''}`;
        } else {
          answer += lang === 'cs' ? `\n\nAktuální ${item.missing} nejsou v Shopify zveřejněné, takže je nechci odhadovat.` : lang === 'en' ? `\n\nCurrent ${item.missing} are not published in Shopify, so I don't want to guess.` : `\n\nAktuelle ${item.missing} sind in Shopify nicht hinterlegt; ich möchte dazu nichts vermuten.`;
        }
      }
    }
    return answer;
  }

  async function aiAnswer(message, catalog, fallback) {
    const key = String(process.env.OPENAI_API_KEY || '').trim();
    if (!key) return null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const context = {
        products: catalog.products.map(product => ({ product, score: scoreProduct(product, message) })).sort((a, b) => b.score - a.score).slice(0, 8).map(({ product }) => ({ title: product.title, price: formatPrice(product), description: cleanHtml(product.descriptionHtml).slice(0, 350), available: (product.variants?.nodes || []).some(v => v.availableForSale), url: product.onlineStoreUrl || `https://homestro.de/products/${product.handle}` })),
        policies: catalog.policies.map(policy => ({ type: policy.type, title: policy.title, body: cleanHtml(policy.body).slice(0, 900), url: policy.url }))
      };
      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST', signal: controller.signal,
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: process.env.OPENAI_MODEL || 'gpt-4o-mini', temperature: 0.2, max_tokens: 350, messages: [
          { role: 'system', content: 'You are the Homestro shop assistant. Reply in the language of the customer. Use only the Shopify product and policy facts in the supplied JSON. Never invent a price, stock status, shipping promise, or return rule. If a fact is missing, say so and point to the official shop policy.' },
          { role: 'user', content: `Shopify facts: ${JSON.stringify(context)}\nCustomer question: ${message}\nFallback facts-based answer: ${fallback}` }
        ] })
      });
      if (!response.ok) return null;
      const body = await response.json();
      return String(body.choices?.[0]?.message?.content || '').trim() || null;
    } catch { return null; }
    finally { clearTimeout(timer); }
  }

  app.get('/shopify-chat-widget.js', (_req, res) => {
    res.set('Cache-Control', 'public, max-age=3600').type('application/javascript').send(widgetSource());
  });

  app.post('/api/shopify/chat', async (req, res) => {
    const origin = req.get('origin');
    if (!allowedOrigin(origin)) return res.status(403).json({ ok: false, error: 'origin-not-allowed' });
    const message = String(req.body?.message || '').trim().slice(0, 600);
    if (!message) return res.status(400).json({ ok: false, error: 'message-required' });
    const now = Date.now();
    const key = String(req.ip || req.socket?.remoteAddress || 'unknown');
    const bucket = (rateMap.get(key) || []).filter(at => now - at < RATE_WINDOW_MS);
    if (bucket.length >= MAX_REQUESTS_PER_WINDOW) return res.status(429).json({ ok: false, error: 'rate-limit' });
    bucket.push(now); rateMap.set(key, bucket);
    if (rateMap.size > 5000) for (const [ip, times] of rateMap) if (!times.length || now - times[times.length - 1] > RATE_WINDOW_MS) rateMap.delete(ip);
    try {
      const catalog = await getStoreData();
      const fallback = fallbackAnswer(message, catalog.products, catalog.policies);
      const answer = await aiAnswer(message, catalog, fallback) || fallback;
      return res.json({ ok: true, answer, mode: answer === fallback ? 'shopify-fallback-free' : 'openai', products: catalog.products.length });
    } catch (error) {
      return res.status(error.status || 502).json({ ok: false, error: 'shop-data-unavailable', answer: 'Ich kann die aktuellen Shop-Daten gerade nicht abrufen. Bitte versuchen Sie es gleich noch einmal.' });
    }
  });
}

function widgetSource() {
  return `(()=>{if(document.getElementById('homestro-chat-root'))return;const script=document.currentScript;const endpoint=new URL('/api/shopify/chat',script.src).href;const root=document.createElement('div');root.id='homestro-chat-root';document.body.appendChild(root);const shadow=root.attachShadow({mode:'open'});shadow.innerHTML='<style>:host{all:initial;font-family:Arial,sans-serif}.launcher{position:fixed;right:20px;bottom:20px;z-index:2147483000;border:0;border-radius:999px;background:#153d2b;color:white;padding:14px 18px;font-size:15px;font-weight:700;box-shadow:0 4px 18px #0003;cursor:pointer}.panel{position:fixed;right:20px;bottom:78px;z-index:2147483000;width:min(360px,calc(100vw - 32px));height:440px;max-height:70vh;background:#fff;color:#17241c;border:1px solid #d6e0d9;border-radius:16px;box-shadow:0 8px 30px #0003;display:none;grid-template-rows:auto 1fr auto}.panel.open{display:grid}.head{background:#153d2b;color:white;padding:14px 16px;border-radius:15px 15px 0 0;font-weight:700;display:flex;justify-content:space-between}.close{border:0;background:transparent;color:white;font-size:21px;cursor:pointer}.messages{padding:12px;overflow:auto;display:flex;flex-direction:column;gap:8px}.bubble{padding:9px 11px;border-radius:12px;background:#f1f4f2;max-width:90%;font-size:14px;line-height:1.4;white-space:pre-wrap;overflow-wrap:anywhere}.bubble.user{background:#dff1e5;align-self:flex-end}.form{display:flex;padding:10px;border-top:1px solid #e3e8e4;gap:8px}.input{flex:1;min-width:0;border:1px solid #ccd7cf;border-radius:9px;padding:10px;font-size:14px}.send{border:0;border-radius:9px;background:#153d2b;color:white;padding:0 14px;font-weight:700;cursor:pointer}</style><section class="panel" aria-label="Homestro Kundenservice"><header class="head"><span>Homestro Kundenservice</span><button class="close" aria-label="Schließen">×</button></header><div class="messages" aria-live="polite"><div class="bubble">Hallo! Ich helfe bei Fragen zu Produkten, Verfügbarkeit, Versand und Rückgabe.</div></div><form class="form"><input class="input" maxlength="600" placeholder="Ihre Frage …" aria-label="Ihre Frage"><button class="send" type="submit">Senden</button></form></section><button class="launcher" type="button">Frage stellen</button>';const panel=shadow.querySelector('.panel'),messages=shadow.querySelector('.messages'),input=shadow.querySelector('.input');shadow.querySelector('.launcher').onclick=()=>{panel.classList.add('open');input.focus()};shadow.querySelector('.close').onclick=()=>panel.classList.remove('open');function bubble(text,who){const el=document.createElement('div');el.className='bubble '+(who||'');el.textContent=text;messages.appendChild(el);messages.scrollTop=messages.scrollHeight;return el}shadow.querySelector('.form').addEventListener('submit',async e=>{e.preventDefault();const message=input.value.trim();if(!message)return;input.value='';bubble(message,'user');const wait=bubble('Einen Moment …');try{const response=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({message})});const data=await response.json();wait.textContent=data.answer||'Entschuldigung, die Antwort ist gerade nicht verfügbar.'}catch{wait.textContent='Die Verbindung ist gerade nicht verfügbar. Bitte versuchen Sie es erneut.'}})})();`;
}

module.exports = { registerShopifyCustomerChat, languageOf, cleanHtml, widgetSource };
