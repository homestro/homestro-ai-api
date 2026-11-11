'use strict';

const DRY_RUN_MODE = true;
const AREA = 'Kempten und Umgebung';
const CONTACT = 'Tel.: 0176 36336476 (Gerne auch per WhatsApp)';
const USP_BLOCK = [
  '✔ Saubere und zuverlässige Arbeit',
  '✔ Faire Preise',
  '✔ Kurzfristige Termine möglich',
  '✔ Kostenlose Besichtigung'
].join('\n');

const APPROVED_SERVICES = Object.freeze([
  'Streicharbeiten',
  'Türen und Rahmen lackieren',
  'Spachtelarbeiten',
  'Schleifen und Vorbereitung der Flächen',
  'Verputzarbeiten',
  'Ausbesserungen aller Art',
  'Tapezierarbeiten',
  'Kleinreparaturen',
  'Laminat und Vinyl verlegen',
  'Sockelleisten montieren',
  'Bodenreparaturen',
  'Fliesenreparaturen',
  'Silikonfugen erneuern',
  'Möbelaufbau',
  'Terrassenreinigung und Terrassenverlegung',
  'Haus- und Wohnungsrenovierungen'
]);

const FORBIDDEN_TERM = ['Mal', 'erarbeiten'].join('');
const MAX_DRAFT_REQUESTS = 30;
const RATE_WINDOW_MS = 10 * 60 * 1000;

function cleanText(value, max, field) {
  const text = String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text || text.length > max) throw new Error(`INVALID_${field.toUpperCase()}`);
  return text;
}

function plainPostText(value) {
  return String(value ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function assertLegalOutput(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (new RegExp(FORBIDDEN_TERM, 'i').test(text)) throw new Error('COPY_COMPLIANCE_FAILED');
  return value;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[char]);
}

function slugify(value) {
  return String(value).normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 72);
}

function selectedServices(focus = 'ALL') {
  if (focus === 'ALL' || focus === '' || focus == null) return [...APPROVED_SERVICES];
  const service = String(focus);
  if (!APPROVED_SERVICES.includes(service)) throw new Error('SERVICE_NOT_ALLOWED');
  return [service];
}

function serviceBlock(services) {
  return services.map(service => `• ${service}`).join('\n');
}

function buildMarketingDrafts(focus = 'ALL') {
  if (DRY_RUN_MODE !== true) throw new Error('DRY_RUN_LOCK_MUST_REMAIN_TRUE');
  const services = selectedServices(focus);
  const offering = serviceBlock(services);
  const serviceLabel = focus === 'ALL' || !focus ? 'Hausmeisterservice und Renovierungen' : focus;
  const common = [offering, USP_BLOCK, AREA, CONTACT].join('\n\n');
  const socialIntro = focus === 'ALL' || !focus
    ? `MS Handwerk & Service ist für Sie da – in ${AREA}.`
    : `${serviceLabel} von MS Handwerk & Service – in ${AREA}.`;

  const drafts = [
    {
      channel: 'Google Unternehmensprofil',
      format: 'Update',
      title: `Google Unternehmensprofil – ${serviceLabel}`,
      text: assertLegalOutput(`${socialIntro}\n\n${common}`)
    },
    {
      channel: 'Facebook',
      format: 'Lokaler Beitrag',
      title: `Facebook – ${serviceLabel}`,
      text: assertLegalOutput(`${socialIntro}\n\n${common}`)
    },
    {
      channel: 'eBay Kleinanzeigen',
      format: 'Lokale Anzeige',
      title: `${serviceLabel} in ${AREA}`,
      text: assertLegalOutput(`${socialIntro}\n\n${common}`)
    },
    {
      channel: 'Instagram',
      format: 'Lokaler Beitrag',
      title: `Instagram – ${serviceLabel}`,
      text: assertLegalOutput(`${socialIntro}\n\n${common}`)
    },
    {
      channel: 'Meta Ads',
      format: 'Lead-Anzeigentext (nur Entwurf)',
      title: `Meta Ads – ${serviceLabel}`,
      text: assertLegalOutput(`${socialIntro}\n\n${offering}\n\n${USP_BLOCK}\n\nRufen Sie an oder schreiben Sie per WhatsApp.\n${CONTACT}`)
    }
  ];

  const result = {
    ok: true,
    mode: 'DRY_RUN',
    generatedAt: new Date().toISOString(),
    focus: focus === 'ALL' || !focus ? 'ALL' : focus,
    services,
    location: AREA,
    contact: CONTACT,
    metaAdsTargetingDraft: {
      location: 'Kempten, Deutschland',
      radiusKm: 15,
      appliedToMeta: false
    },
    paidAdsEnabled: false,
    externalPublishingEnabled: false,
    published: false,
    estimatedCostEUR: 0,
    paidApiCalls: 0,
    drafts
  };
  return assertLegalOutput(result);
}

function buildDraft(input = {}) {
  const service = cleanText(input.service, 100, 'service');
  if (!APPROVED_SERVICES.includes(service)) throw new Error('SERVICE_NOT_ALLOWED');
  if (input.city && !['Kempten', AREA].includes(cleanText(input.city, 100, 'city'))) {
    throw new Error('LOCATION_NOT_ALLOWED');
  }
  const projectDescription = cleanText(plainPostText(input.projectDescription), 1400, 'project_description');
  const photoUrls = Array.isArray(input.photoUrls) ? input.photoUrls : [];
  if (photoUrls.length > 6) throw new Error('TOO_MANY_PHOTOS');
  const photos = photoUrls.map(value => {
    let url;
    try { url = new URL(String(value)); } catch { throw new Error('INVALID_PHOTO_URL'); }
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error('INVALID_PHOTO_URL');
    return url.toString();
  });

  const slug = slugify(`${service}-kempten`);
  const title = `${service} in ${AREA} | MS Handwerk & Service`;
  const metaDescription = `${service} in ${AREA}. MS Handwerk & Service: saubere und zuverlässige Arbeit, faire Preise und kostenlose Besichtigung.`.slice(0, 160);
  const websiteUrl = 'https://ms-handwerkservice.de/';
  const googleUrl = new URL(websiteUrl);
  googleUrl.searchParams.set('utm_source', 'google');
  googleUrl.searchParams.set('utm_medium', 'organic');
  googleUrl.searchParams.set('utm_campaign', 'ms_handwerk_projekt');
  googleUrl.searchParams.set('utm_content', slug);

  const articleHtml = `<article lang="de"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(projectDescription)}</p><p>${escapeHtml(service)} in ${escapeHtml(AREA)}.</p><p>${escapeHtml(USP_BLOCK).replace(/\n/g, '<br>')}</p><p>${escapeHtml(CONTACT)}</p><p><a href="https://ms-handwerkservice.de/">Kontakt und weitere Informationen</a></p>${photos.map(url => `<figure><img src="${escapeHtml(url)}" alt="${escapeHtml(service)} in ${escapeHtml(AREA)}" loading="lazy"></figure>`).join('')}</article>`;
  const localText = [
    `${service} in ${AREA}.`,
    projectDescription,
    USP_BLOCK,
    CONTACT
  ].join('\n\n');

  const draft = {
    business: 'MS Handwerk & Service',
    service,
    location: AREA,
    adSpendEUR: 0,
    paidAdsEnabled: false,
    autoPublished: false,
    reviewRequired: true,
    website: { suggestedPath: `/projekte/${slug}/`, title, metaDescription, articleHtml, published: false },
    googleBusinessProfile: { text: localText, link: googleUrl.toString(), published: false },
    localSocial: { text: localText, photoUrls: photos, published: false },
    notes: ['Vor Veröffentlichung Fakten und Bildrechte manuell prüfen. Dieser Entwurf wurde nicht veröffentlicht.']
  };
  return assertLegalOutput(draft);
}

function registerMsHandwerkOrganic(app, _apiKey, _integrations = {}) {
  const requestWindows = new Map();
  const draftRateLimit = (req, res, next) => {
    const now = Date.now();
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';
    let window = requestWindows.get(ip);
    if (!window || window.resetAt <= now) window = { count: 0, resetAt: now + RATE_WINDOW_MS };
    window.count += 1;
    requestWindows.set(ip, window);
    if (requestWindows.size > 2000) {
      for (const [key, value] of requestWindows) if (value.resetAt <= now) requestWindows.delete(key);
    }
    if (window.count > MAX_DRAFT_REQUESTS) {
      res.set('Retry-After', String(Math.max(1, Math.ceil((window.resetAt - now) / 1000))));
      return res.status(429).json({ ok: false, error: 'RATE_LIMITED' });
    }
    return next();
  };

  app.get('/ms-handwerk-review', (_req, res) => {
    try {
      const nonce = require('node:crypto').randomBytes(16).toString('base64');
      const options = ['ALL', ...APPROVED_SERVICES]
        .map(value => `<option value="${escapeHtml(value)}">${value === 'ALL' ? 'Gesamtangebot' : escapeHtml(value)}</option>`)
        .join('');
      const initial = buildMarketingDrafts('ALL');
      const cards = initial.drafts.map((draft, index) => `
        <article class="card"><h2>${escapeHtml(draft.channel)} · ${escapeHtml(draft.format)}</h2>
        <label for="draft-${index}">${escapeHtml(draft.title)}</label>
        <textarea id="draft-${index}" data-draft-text rows="12" spellcheck="true">${escapeHtml(draft.text)}</textarea>
        <button type="button" data-copy="${index}">Copy Text</button></article>`).join('');
      res.set('Cache-Control', 'no-store').set('Content-Security-Policy',
        `default-src 'self'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; img-src 'self' https:; base-uri 'none'; frame-ancestors 'none'`);
      return res.type('html').send(`<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>MS Handwerk & Service – lokale Textentwürfe</title>
        <style nonce="${nonce}">body{font:16px system-ui;margin:0;background:#f5f6f4;color:#1d2822}main{max-width:960px;margin:24px auto;padding:18px}.card,header{background:#fff;border:1px solid #d9e0da;border-radius:12px;padding:18px;margin:14px 0}label{display:block;font-weight:650;margin:10px 0}select,textarea,button{font:inherit;box-sizing:border-box;max-width:100%}select,textarea{width:100%;padding:10px;border:1px solid #aeb8b0;border-radius:7px}textarea{min-height:190px;white-space:pre-wrap}button{padding:10px 16px;border:0;border-radius:7px;background:#235d3b;color:white;font-weight:700;cursor:pointer}button:hover{background:#18462c}.muted{color:#56645a;font-size:14px}#status{min-height:1.4em}</style></head><body><main>
        <header><h1>MS Handwerk &amp; Service</h1><p>Deutsche lokale Marketingentwürfe für ${AREA}. Kosten: 0 EUR. Entwürfe werden nicht veröffentlicht und Meta Ads werden nicht angelegt.</p>
        <label for="focus">Angebot auswählen</label><select id="focus">${options}</select><button id="generate" type="button">Entwürfe erstellen</button><p id="status" class="muted" role="status">DRY_RUN_MODE = true · Nur prüfen und manuell kopieren.</p></header>
        <section id="drafts">${cards}</section></main><script nonce="${nonce}">
        const statusNode=document.getElementById('status');
        function bindCopyButtons(){document.querySelectorAll('[data-copy]').forEach(button=>{button.onclick=async()=>{const text=button.closest('article').querySelector('[data-draft-text]').value;try{await navigator.clipboard.writeText(text);statusNode.textContent='Text kopiert.';}catch{const area=button.closest('article').querySelector('[data-draft-text]');area.focus();area.select();statusNode.textContent='Text markieren und kopieren.';}};});}
        bindCopyButtons();
        document.getElementById('generate').onclick=async()=>{statusNode.textContent='Entwürfe werden lokal erstellt …';try{const response=await fetch('/api/ms-handwerk/organic/marketing-drafts',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({focus:document.getElementById('focus').value})});const data=await response.json();if(!response.ok)throw Error(data.error||'Entwurfserstellung fehlgeschlagen');const section=document.getElementById('drafts');section.replaceChildren();data.drafts.forEach((draft,index)=>{const card=document.createElement('article');card.className='card';const heading=document.createElement('h2');heading.textContent=draft.channel+' · '+draft.format;const label=document.createElement('label');label.textContent=draft.title;const area=document.createElement('textarea');area.rows=12;area.value=draft.text;area.setAttribute('data-draft-text','');const copy=document.createElement('button');copy.type='button';copy.textContent='Copy Text';copy.dataset.copy=String(index);card.append(heading,label,area,copy);section.append(card);});bindCopyButtons();statusNode.textContent='Entwürty hotovy. Nebyly zveřejněny; výdaje: 0 EUR.';}catch(error){statusNode.textContent=error.message||'Entwurfserstellung fehlgeschlagen.';}};
        </script></body></html>`);
    } catch (error) {
      console.error('[ms-handwerk-review] RENDER_FAILED ' + String(error?.message || 'UNKNOWN_ERROR'));
      return res.status(500).type('text').send('Entwurf konnte nicht geladen werden.');
    }
  });

  app.get('/api/ms-handwerk/organic/status', (_req, res) => res.json({
    ok: true,
    business: 'MS Handwerk & Service',
    mode: 'DRY_RUN_DRAFTS_ONLY',
    adSpendEUR: 0,
    paidAdsEnabled: false,
    externalPublishingEnabled: false,
    autoPublished: false,
    contentGeneration: 'rule-based; no paid API'
  }));

  app.post('/api/ms-handwerk/organic/marketing-drafts', draftRateLimit, (req, res) => {
    try {
      return res.status(200).json(buildMarketingDrafts(req.body?.focus));
    } catch (error) {
      const invalid = error.message === 'SERVICE_NOT_ALLOWED' || error.message === 'COPY_COMPLIANCE_FAILED';
      return res.status(invalid ? 400 : 500).json({ ok: false, error: error.message || 'DRAFT_GENERATION_FAILED' });
    }
  });

  app.post('/api/ms-handwerk/organic/draft', draftRateLimit, (req, res) => {
    try {
      return res.status(200).json({ ok: true, draft: buildDraft(req.body) });
    } catch (error) {
      return res.status(400).json({ ok: false, error: error.message || 'INVALID_INPUT' });
    }
  });
}

module.exports = {
  APPROVED_SERVICES,
  DRY_RUN_MODE,
  buildDraft,
  buildMarketingDrafts,
  registerMsHandwerkOrganic,
  slugify
};
