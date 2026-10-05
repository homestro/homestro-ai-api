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
  const projectDescription = cleanText(input.projectDescription, 1400, 'project_description');
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
  const googlePost = `${intro}\n\n${projectDescription}\n\nSie planen ein ähnliches Vorhaben? Kontaktieren Sie MS Handwerk & Service aus Kempten: 0176 36336476. Auch per WhatsApp erreichbar.`;
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

function registerMsHandwerkOrganic(app, apiKey) {
  app.get('/api/ms-handwerk/organic/status', apiKey, (_req, res) => res.json({
    ok: true,
    business: 'MS Handwerk & Service',
    mode: 'DRAFT_ONLY',
    adSpendEUR: 0,
    paidAdsEnabled: false,
    autoPublishingEnabled: false,
    contentGeneration: 'template-based; no OpenAI call'
  }));
  app.post('/api/ms-handwerk/organic/draft', apiKey, (req, res) => {
    try { return res.json({ ok: true, draft: buildDraft(req.body) }); }
    catch (error) { return res.status(400).json({ ok: false, error: error.message || 'INVALID_INPUT' }); }
  });
}

module.exports = { buildDraft, registerMsHandwerkOrganic, slugify };
