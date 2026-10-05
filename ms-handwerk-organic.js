'use strict';

const SERVICES = new Set([
  'Innenanstrich',
  'Spachtelarbeiten',
  'Trockenbau-Reparaturen',
  'Vinylboden verlegen',
  'Laminatboden verlegen',
  'Möbelmontage',
  'Kleinreparaturen',
  'Hausmeisterservice'
]);

function cleanText(value, max, field) {
  const text = String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
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

function removeDuplicateLead(description, service, city) {
  const prefixes = [
    `Ein weiteres Projekt in ${city}:`,
    `Ein Projekt aus ${city}: ${service}.`,
    `${service} in ${city}:`
  ];
  const prefix = prefixes.find(value => description.toLowerCase().startsWith(value.toLowerCase()));
  return prefix ? description.slice(prefix.length).trim() : description;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[c]);
}

function slugify(value) {
  return String(value).normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 72);
}

function buildDraft(input = {}) {
  const service = cleanText(input.service, 80, 'service');
  if (!SERVICES.has(service)) throw new Error('SERVICE_NOT_ALLOWED');
  const city = cleanText(input.city, 80, 'city');
  const projectDescription = removeDuplicateLead(
    cleanText(plainPostText(input.projectDescription), 1400, 'project_description'), service, city
  );
  const photoUrls = Array.isArray(input.photoUrls) ? input.photoUrls : [];
  if (photoUrls.length > 6) throw new Error('TOO_MANY_PHOTOS');
  const photos = photoUrls.map(value => {
    let url;
    try { url = new URL(String(value)); } catch { throw new Error('INVALID_PHOTO_URL'); }
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error('INVALID_PHOTO_URL');
    return url.toString();
  });

  const slug = slugify(`${service}-${city}`);
  const title = `${service} in ${city} | MS Handwerk & Service`;
  const metaDescription = `${service} in ${city}: Einblicke in ein Projekt von MS Handwerk & Service. Fragen Sie Ihr Renovierungs- oder Hausserviceprojekt in Kempten und Umgebung an.`.slice(0, 160);
  const websiteUrl = 'https://ms-handwerkservice.de/';
  const googleUrl = new URL(websiteUrl);
  googleUrl.searchParams.set('utm_source', 'google');
  googleUrl.searchParams.set('utm_medium', 'organic');
  googleUrl.searchParams.set('utm_campaign', 'ms_handwerk_projekt');
  googleUrl.searchParams.set('utm_content', slug);

  const intro = `Ein Projekt aus ${city}: ${service}.`;
  const articleHtml = `<article lang="de"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(intro)}</p><p>${escapeHtml(projectDescription)}</p><p>MS Handwerk &amp; Service unterstützt Privatkunden, Vermieter und Eigentümer in Kempten und Umgebung. Besprechen Sie Ihr Vorhaben telefonisch, per E-Mail oder WhatsApp.</p><p><a href="https://ms-handwerkservice.de/">Kontakt und weitere Informationen</a></p>${photos.map(url => `<figure><img src="${escapeHtml(url)}" alt="Projektfoto: ${escapeHtml(service)} in ${escapeHtml(city)}" loading="lazy"></figure>`).join('')}</article>`;
  const relatedServices = service === 'Innenanstrich' || service === 'Spachtelarbeiten'
    ? 'Innenanstriche, Spachtel- und Schleifarbeiten'
    : `${service}, Renovierungs- und Hausservice`;
  const googlePost = `${service} in ${city}\n\n${projectDescription}\n\nMS Handwerk & Service übernimmt ${relatedServices} in ${city} und Umgebung. Saubere und zuverlässige Ausführung, faire Preise, kurzfristige Termine und kostenlose Besichtigung.\n\nTelefon und WhatsApp: 0176 36336476.`;
  const localPost = `${intro}\n\n${projectDescription}\n\nMS Handwerk & Service aus Kempten ist für Renovierungen und Hausservice in der Umgebung erreichbar. Informationen: https://ms-handwerkservice.de`;

  return {
    business: 'MS Handwerk & Service',
    service,
    city,
    adSpendEUR: 0,
    paidAdsEnabled: false,
    autoPublished: false,
    reviewRequired: true,
    website: { suggestedPath: `/projekte/${slug}/`, title, metaDescription, articleHtml, published: false },
    googleBusinessProfile: { text: googlePost, link: googleUrl.toString(), published: false, automationAvailable: false },
    localSocial: { text: localPost, photoUrls: photos, published: false },
    notes: [
      'Entwurf používá pouze zadaný popis zakázky; před zveřejněním ho zkontrolujte.',
      'Příspěvek v Google profilu je zatím připravený k ručnímu vložení.',
      'Stránka projektu se na webu vytvoří až po nasazení; navržená cesta zatím neexistuje.'
    ]
  };
}

function registerMsHandwerkOrganic(app) {
  const requestWindows = new Map();
  const draftRateLimit = (req, res, next) => {
    const now = Date.now();
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';
    let window = requestWindows.get(ip);
    if (!window || window.resetAt <= now) window = { count: 0, resetAt: now + 10 * 60 * 1000 };
    window.count += 1;
    requestWindows.set(ip, window);
    if (requestWindows.size > 2000) {
      for (const [key, value] of requestWindows) if (value.resetAt <= now) requestWindows.delete(key);
    }
    if (window.count > 30) {
      res.set('Retry-After', String(Math.max(1, Math.ceil((window.resetAt - now) / 1000))));
      return res.status(429).json({ ok: false, error: 'RATE_LIMITED' });
    }
    return next();
  };
  app.get('/ms-handwerk-review', (_req, res) => {
    const nonce = require('node:crypto').randomBytes(16).toString('base64');
    const services = [...SERVICES].map(service => `<option>${escapeHtml(service)}</option>`).join('');
    res.set('Cache-Control', 'no-store').set('Content-Security-Policy',
      `default-src 'self'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; img-src 'self' https:; base-uri 'none'; frame-ancestors 'none'`);
    res.type('html').send(`<!doctype html><html lang="cs"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>MS Handwerk · organický marketing</title>
      <style nonce="${nonce}">body{font:16px system-ui;margin:0;background:#f7f7f4;color:#222}main{max-width:820px;margin:32px auto;padding:20px}section,article{background:#fff;border:1px solid #ddd;border-radius:12px;padding:20px;margin:16px 0}label{display:block;font-weight:650;margin-top:14px}input,select,textarea,button{font:inherit;padding:10px;margin:5px 0;max-width:100%;box-sizing:border-box}input,select,textarea{width:100%;border:1px solid #bbb;border-radius:6px}textarea{min-height:120px}button{border:0;border-radius:6px;background:#f80;color:#fff;font-weight:700;cursor:pointer}button.copy{background:#305d48;margin-left:8px}small,.muted{color:#666}#error{color:#a21}pre{white-space:pre-wrap;overflow-wrap:anywhere}</style>
      <main><h1>MS Handwerk &amp; Service</h1><p><strong>Organický marketing bez reklamního rozpočtu.</strong> Nástroj připraví návrhy; nic automaticky nezveřejní. Generování nepoužívá OpenAI API.</p>
      <section>
      <label>Služba<select id="service">${services}</select></label><label>Město<input id="city" maxlength="80" value="Kempten"></label>
      <label>Popis skutečně dokončené zakázky v němčině<textarea id="description" maxlength="1400" placeholder="Např. In einer Wohnung wurden die Wände und Decken gespachtelt und anschließend gestrichen."></textarea></label>
      <label>Odkazy na vlastní fotografie (nepovinné, jeden odkaz na řádek)<textarea id="photos" placeholder="https://…"></textarea></label>
      <button id="generate">Připravit návrhy</button><p id="error" role="alert"></p></section><div id="results"></div></main>
      <script nonce="${nonce}">
      const $=id=>document.getElementById(id), results=$('results');
      function addOutput(title,value){const box=document.createElement('article'),h=document.createElement('h2'),area=document.createElement('textarea'),copy=document.createElement('button');h.textContent=title;area.readOnly=true;area.value=String(value||'');copy.className='copy';copy.textContent='Kopírovat';copy.onclick=()=>navigator.clipboard.writeText(area.value);box.append(h,area,copy);results.append(box);}
      $('generate').onclick=async()=>{results.replaceChildren();$('error').textContent='';try{const response=await fetch('/api/ms-handwerk/organic/draft',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({service:$('service').value,city:$('city').value,projectDescription:$('description').value,photoUrls:$('photos').value.split(/\\r?\\n/).map(x=>x.trim()).filter(Boolean)})});const data=await response.json();if(!response.ok)throw Error(data.error||'Návrh se nepodařilo vytvořit');const d=data.draft;addOutput('Google profil – text příspěvku',d.googleBusinessProfile.text);addOutput('Google profil – odkaz pro tlačítko „Mehr erfahren“',d.googleBusinessProfile.link);addOutput('Návrh textu pro web (HTML)',d.website.articleHtml);addOutput('Nebenan / Facebook',d.localSocial.text);$('error').textContent='Hotovo jako návrh. Použij jen pravdivý popis skutečné zakázky a ověř práva k fotografiím. Nic nebylo zveřejněno.';}catch(e){$('error').textContent=e.message;}};
      </script></html>`);
  });
  app.get('/api/ms-handwerk/organic/status', (_req, res) => res.json({
    ok: true,
    business: 'MS Handwerk & Service',
    mode: 'DRAFT_ONLY',
    adSpendEUR: 0,
    paidAdsEnabled: false,
    autoPublishingEnabled: false,
    contentGeneration: 'template-based; no OpenAI call'
  }));
  app.post('/api/ms-handwerk/organic/draft', draftRateLimit, (req, res) => {
    try { return res.json({ ok: true, draft: buildDraft(req.body) }); }
    catch (error) { return res.status(400).json({ ok: false, error: error.message || 'INVALID_INPUT' }); }
  });
}

module.exports = { buildDraft, registerMsHandwerkOrganic, slugify };
