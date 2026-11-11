'use strict';

// This route is intentionally a fixture-only safety check. It never fetches the
// source websites, calls a paid API, contacts a notification provider, or writes
// leads to a database. Keep this hard-coded true until a separately reviewed
// live-data design is approved.
const DRY_RUN_MODE = true;

const SOURCES = Object.freeze({
  aumass: {
    name: 'aumass.de',
    baseUrl: 'https://www.aumass.de/'
  },
  vergabeBayern: {
    name: 'vergabe.bayern.de',
    baseUrl: 'https://www.vergabe.bayern.de/'
  }
});

// Representative static HTML only. All entries are explicitly labeled as
// fixtures and must never be presented as current or real procurement notices.
const STATIC_HTML_FIXTURES = Object.freeze({
  aumass: `<article data-lead-id="fixture-aumass-001" data-visibility="public" data-region="Kempten, Bayern" data-category="Trockenbau">
    <h2 data-field="title">Fixture: Trockenbauarbeiten in Kempten</h2>
    <p data-field="description">Beispiel einer öffentlichen Ausschreibung für Ausbauarbeiten.</p>
    <time data-field="deadline">2030-01-30</time>
  </article>
  <article data-lead-id="fixture-aumass-002" data-visibility="public" data-region="Augsburg, Bayern" data-category="Badsanierung">
    <h2 data-field="title">Fixture: Badsanierung in Augsburg</h2>
    <p data-field="description">Beispiel einer öffentlichen Ausschreibung zur Badmodernisierung.</p>
    <time data-field="deadline">2030-02-15</time>
  </article>`,
  vergabeBayern: `<article data-lead-id="fixture-vergabe-001" data-visibility="public" data-region="München, Bayern" data-category="Elektriker">
    <h2 data-field="title">Fixture: Elektroarbeiten in München</h2>
    <p data-field="description">Beispiel einer öffentlichen Ausschreibung für Elektroarbeiten.</p>
    <time data-field="deadline">2030-03-01</time>
  </article>
  <article data-lead-id="fixture-vergabe-002" data-visibility="private" data-region="Nürnberg, Bayern" data-category="Trockenbau">
    <h2 data-field="title">Fixture: Nicht öffentlicher Eintrag</h2>
    <p data-field="description">Dieser Eintrag muss durch den Public-only Filter verworfen werden.</p>
    <time data-field="deadline">2030-03-15</time>
  </article>`
});

const CRAFT_CATEGORIES = Object.freeze([
  { name: 'Trockenbau', pattern: /trockenbau|drywall|innenausbau/i, msSupported: true },
  { name: 'Badsanierung', pattern: /bad.?sanierung|bad.?modernisierung|badsanierung/i, msSupported: false },
  { name: 'Elektriker', pattern: /elektriker|elektroarbeiten|elektro.?installation/i, msSupported: false },
  { name: 'Malerarbeiten', pattern: /malerarbeiten|innenanstrich|streichen/i, msSupported: true },
  { name: 'Bodenverlegung', pattern: /bodenverlegung|vinylboden|laminatboden/i, msSupported: true },
  { name: 'Kleinreparaturen', pattern: /kleinreparaturen|reparaturarbeiten/i, msSupported: true }
]);
const BAVARIA_PATTERN = /\b(bayern|bavaria|kempten|allgäu|augsburg|münchen|nürnberg|nuernberg|nürnberg|regensburg|würzburg|ingolstadt|bayreuth|bamberg|passau|rosenheim)\b/i;
const MAX_REQUESTS_PER_WINDOW = 30;
const WINDOW_MS = 10 * 60 * 1000;

function decodeHtml(value) {
  return String(value || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

function stripMarkup(value) {
  return decodeHtml(String(value || '').replace(/<[^>]*>/g, ' '))
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function readField(block, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = block.match(new RegExp(`<[^>]*data-field=["']${escaped}["'][^>]*>([\\s\\S]*?)<\\/`, 'i'));
  return match ? stripMarkup(match[1]) : '';
}

function parseStaticListings(sourceKey, html) {
  const source = SOURCES[sourceKey];
  if (!source) throw new Error('UNKNOWN_FIXTURE_SOURCE');
  if (typeof html !== 'string') throw new Error('INVALID_FIXTURE_HTML');

  const blocks = html.match(/<article\\b[^>]*>[\\s\\S]*?<\\/article>/gi) || [];
  return blocks.flatMap(block => {
    const attrs = {};
    for (const match of block.matchAll(/([a-z][a-z0-9-]*)=["']([^"']*)["']/gi)) attrs[match[1].toLowerCase()] = decodeHtml(match[2]);
    const leadId = String(attrs['data-lead-id'] || '');
    const visibility = String(attrs['data-visibility'] || '').toLowerCase();
    const region = String(attrs['data-region'] || '');
    const title = readField(block, 'title');
    const description = readField(block, 'description');
    const deadline = readField(block, 'deadline');

    // Public-only is enforced before classification. Private trade leads are
    // excluded even when they are in Bavaria and match a service.
    if (!leadId.startsWith('fixture-') || visibility !== 'public') return [];
    if (!BAVARIA_PATTERN.test(region)) return [];

    const searchable = [attrs['data-category'], title, description].join(' ');
    const crafts = CRAFT_CATEGORIES
      .filter(category => category.pattern.test(searchable))
      .map(category => ({ name: category.name, eligibleForMsHandwerk: category.msSupported }));
    if (!crafts.length) return [];

    return [{
      id: leadId,
      source: source.name,
      sourceUrl: source.baseUrl,
      title,
      description,
      region,
      deadline,
      crafts,
      eligibleForMsHandwerk: crafts.some(category => category.eligibleForMsHandwerk),
      fixture: true,
      liveNotice: false
    }];
  });
}

function buildDryRunResult() {
  if (DRY_RUN_MODE !== true) throw new Error('DRY_RUN_LOCK_MUST_REMAIN_TRUE');
  const leads = [
    ...parseStaticListings('aumass', STATIC_HTML_FIXTURES.aumass),
    ...parseStaticListings('vergabeBayern', STATIC_HTML_FIXTURES.vergabeBayern)
  ];
  return {
    ok: true,
    mode: 'DRY_RUN',
    generatedAt: new Date().toISOString(),
    fixtureOnly: true,
    liveDataFetched: false,
    notificationSent: false,
    databaseWrites: 0,
    networkRequests: 0,
    paidApiCalls: 0,
    estimatedCostEUR: 0,
    sourceCount: Object.keys(STATIC_HTML_FIXTURES).length,
    publicBavariaFixtureCount: leads.length,
    leads
  };
}

function registerMsHandwerkLeadsDryRun(app) {
  if (!app || typeof app.get !== 'function') throw new Error('EXPRESS_APP_REQUIRED');
  const windows = new Map();

  app.get('/api/leads/v1/dry-run', (req, res) => {
    try {
      const now = Date.now();
      const ip = req.ip || req.socket?.remoteAddress || 'unknown';
      let window = windows.get(ip);
      if (!window || window.resetAt <= now) window = { count: 0, resetAt: now + WINDOW_MS };
      window.count += 1;
      windows.set(ip, window);

      // Bound in-memory rate-limit state on a public, read-only endpoint.
      if (windows.size > 2000) {
        for (const [key, value] of windows) if (value.resetAt <= now) windows.delete(key);
      }
      if (window.count > MAX_REQUESTS_PER_WINDOW) {
        res.set('Retry-After', String(Math.max(1, Math.ceil((window.resetAt - now) / 1000))));
        return res.status(429).json({ ok: false, error: 'RATE_LIMITED', mode: 'DRY_RUN' });
      }

      const result = buildDryRunResult();
      // The log is intentionally structured, bounded to the small static
      // fixture set, and contains no user/customer personal information.
      console.info('[ms-handwerk-leads-dry-run] ' + JSON.stringify({
        at: result.generatedAt,
        mode: result.mode,
        sources: result.sourceCount,
        fixtureCount: result.publicBavariaFixtureCount,
        networkRequests: result.networkRequests,
        paidApiCalls: result.paidApiCalls,
        estimatedCostEUR: result.estimatedCostEUR,
        matchedCrafts: [...new Set(result.leads.flatMap(lead => lead.crafts.map(craft => craft.name)))],
        fixtureIds: result.leads.map(lead => lead.id)
      }));
      return res.status(200).json(result);
    } catch (error) {
      console.error('[ms-handwerk-leads-dry-run] FAILED ' + String(error?.message || 'UNKNOWN_ERROR'));
      return res.status(500).json({
        ok: false,
        mode: 'DRY_RUN',
        error: 'DRY_RUN_FAILED'
      });
    }
  });
}

module.exports = {
  DRY_RUN_MODE,
  STATIC_HTML_FIXTURES,
  parseStaticListings,
  buildDryRunResult,
  registerMsHandwerkLeadsDryRun
};
