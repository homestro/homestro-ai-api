'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildDraft, registerMsHandwerkOrganic, slugify } = require('../ms-handwerk-organic');

test('builds a zero-ad draft from supplied real project details without publishing', () => {
  const draft = buildDraft({
    service: 'Innenanstrich',
    city: 'Kempten',
    projectDescription: 'Ein weiteres Projekt in Kempten: Wände und Decken in einer Wohnung wurden neu gestrichen.',
    photoUrls: ['https://ms-handwerkservice.de/fotos/projekt-1.jpg']
  });
  assert.equal(draft.adSpendEUR, 0);
  assert.equal(draft.paidAdsEnabled, false);
  assert.equal(draft.autoPublished, false);
  assert.equal(draft.reviewRequired, true);
  assert.match(draft.website.articleHtml, /Wände und Decken in einer Wohnung wurden neu gestrichen/);
  assert.doesNotMatch(draft.googleBusinessProfile.text, /Ein weiteres Projekt|Ein Projekt aus/);
  assert.match(draft.googleBusinessProfile.text, /^Innenanstrich in Kempten\n\nWände und Decken/);
  assert.doesNotMatch(draft.googleBusinessProfile.text, /<[^>]+>|[\u{1F000}-\u{1FAFF}]/u);
  assert.match(draft.googleBusinessProfile.link, /utm_source=google/);
  assert.deepEqual(draft.localSocial.photoUrls, ['https://ms-handwerkservice.de/fotos/projekt-1.jpg']);
});

test('rejects unknown services, missing project facts, unsafe photo URLs and excessive photos', () => {
  const base = { service: 'Innenanstrich', city: 'Kempten', projectDescription: 'Ein echter Projektbericht mit ausgeführten Arbeiten.' };
  assert.throws(() => buildDraft({ ...base, service: 'Elektro-Notdienst' }), /SERVICE_NOT_ALLOWED/);
  assert.throws(() => buildDraft({ ...base, projectDescription: '' }), /INVALID_PROJECT_DESCRIPTION/);
  assert.throws(() => buildDraft({ ...base, photoUrls: ['javascript:alert(1)'] }), /INVALID_PHOTO_URL/);
  assert.throws(() => buildDraft({ ...base, photoUrls: Array(7).fill('https://example.org/a.jpg') }), /TOO_MANY_PHOTOS/);
});

test('escapes customer supplied text and creates stable German slugs', () => {
  const draft = buildDraft({
    service: 'Vinylboden verlegen', city: 'Füssen',
    projectDescription: '<script>alert("x")</script> Boden in einer Wohnung verlegt.'
  });
  assert.doesNotMatch(draft.website.articleHtml, /<script>/);
  assert.doesNotMatch(draft.website.articleHtml, /&lt;script&gt;/);
  assert.match(draft.website.articleHtml, /alert\(&quot;x&quot;\)/);
  assert.equal(slugify('Vinylboden verlegen Füssen'), 'vinylboden-verlegen-fussen');
});

test('serves a usable no-key draft form and rate-limits the public draft endpoint', () => {
  const routes = new Map();
  const app = {
    get: (path, ...handlers) => routes.set(`GET ${path}`, handlers),
    post: (path, ...handlers) => routes.set(`POST ${path}`, handlers)
  };
  registerMsHandwerkOrganic(app);

  let html = '';
  const pageResponse = {
    set() { return this; },
    type() { return this; },
    send(value) { html = value; return this; }
  };
  routes.get('GET /ms-handwerk-review')[0]({}, pageResponse);
  assert.match(html, /Připravit návrhy/);
  assert.match(html, /Google profil – odkaz pro tlačítko/);
  assert.match(html, /Vymazat text/);
  assert.doesNotMatch(html, /area\.readOnly\s*=\s*true/);
  assert.doesNotMatch(html, /Soukromý API klíč|id="key"/);

  const [limit] = routes.get('POST /api/ms-handwerk/organic/draft');
  let allowed = 0;
  let limited = 0;
  const response = { set() { return this; }, status(code) { this.code = code; return this; }, json() { limited += 1; } };
  for (let i = 0; i < 31; i++) {
    limit({ ip: '203.0.113.7' }, response, () => { allowed += 1; });
  }
  assert.equal(allowed, 30);
  assert.equal(limited, 1);
  assert.equal(response.code, 429);
});
