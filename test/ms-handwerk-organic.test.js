'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildDraft, slugify } = require('../ms-handwerk-organic');

test('builds a zero-ad draft from supplied real project details without publishing', () => {
  const draft = buildDraft({
    service: 'Innenanstrich',
    city: 'Kempten',
    projectDescription: 'Wände und Decken in einer Wohnung wurden neu gestrichen.',
    photoUrls: ['https://ms-handwerkservice.de/fotos/projekt-1.jpg']
  });
  assert.equal(draft.adSpendEUR, 0);
  assert.equal(draft.paidAdsEnabled, false);
  assert.equal(draft.autoPublished, false);
  assert.equal(draft.reviewRequired, true);
  assert.match(draft.website.articleHtml, /Wände und Decken in einer Wohnung wurden neu gestrichen/);
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
  assert.match(draft.website.articleHtml, /&lt;script&gt;/);
  assert.equal(slugify('Vinylboden verlegen Füssen'), 'vinylboden-verlegen-fussen');
});
