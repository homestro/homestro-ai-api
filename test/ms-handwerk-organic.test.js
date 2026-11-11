'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { once } = require('node:events');
const {
  APPROVED_SERVICES,
  DRY_RUN_MODE,
  buildDraft,
  buildMarketingDrafts,
  registerMsHandwerkOrganic,
  slugify
} = require('../ms-handwerk-organic');

const forbidden = ['Mal', 'erarbeiten'].join('');
const forbiddenPattern = new RegExp(forbidden, 'i');

test('the marketing generator is hard-locked to dry-run at zero cost', () => {
  const result = buildMarketingDrafts();
  assert.equal(DRY_RUN_MODE, true);
  assert.equal(result.mode, 'DRY_RUN');
  assert.equal(result.paidAdsEnabled, false);
  assert.equal(result.externalPublishingEnabled, false);
  assert.equal(result.published, false);
  assert.equal(result.estimatedCostEUR, 0);
  assert.equal(result.paidApiCalls, 0);
});

test('uses the approved German service list and verbatim USPs and contact', () => {
  const result = buildMarketingDrafts();
  assert.deepEqual(result.services, APPROVED_SERVICES);
  assert.equal(result.location, 'Kempten und Umgebung');
  for (const draft of result.drafts) {
    assert.match(draft.text, /Kempten und Umgebung/);
    assert.match(draft.text, /Tel\.: 0176 36336476 \(Gerne auch per WhatsApp\)/);
    assert.match(draft.text, /✔ Saubere und zuverlässige Arbeit/);
    assert.match(draft.text, /✔ Faire Preise/);
    assert.match(draft.text, /✔ Kurzfristige Termine möglich/);
    assert.match(draft.text, /✔ Kostenlose Besichtigung/);
    for (const service of APPROVED_SERVICES) assert.ok(draft.text.includes(service));
  }
  assert.equal(result.metaAdsTargetingDraft.location, 'Kempten, Deutschland');
  assert.equal(result.metaAdsTargetingDraft.radiusKm, 15);
  assert.equal(result.metaAdsTargetingDraft.appliedToMeta, false);
});

test('focused single-service variants accept only approved services', () => {
  const result = buildMarketingDrafts('Silikonfugen erneuern');
  assert.deepEqual(result.services, ['Silikonfugen erneuern']);
  assert.ok(result.drafts.every(draft => draft.text.includes('Silikonfugen erneuern')));
  assert.throws(() => buildMarketingDrafts('Elektroarbeiten'), /SERVICE_NOT_ALLOWED/);
});

test('all generated posts and rendered page pass the legal-copy check', async () => {
  const result = buildMarketingDrafts();
  assert.doesNotMatch(JSON.stringify(result), forbiddenPattern);
  for (const service of APPROVED_SERVICES) {
    assert.doesNotMatch(JSON.stringify(buildMarketingDrafts(service)), forbiddenPattern);
  }

  const app = express();
  registerMsHandwerkOrganic(app);
  const server = app.listen(0);
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const review = await fetch(`${origin}/ms-handwerk-review`);
    assert.equal(review.status, 200);
    const html = await review.text();
    assert.match(html, /Copy Text/);
    assert.doesNotMatch(html, forbiddenPattern);

    const response = await fetch(`${origin}/api/ms-handwerk/organic/marketing-drafts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ focus: 'ALL' })
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.doesNotMatch(JSON.stringify(body), forbiddenPattern);

    const healthApp = express();
    healthApp.get('/health', (_req, res) => res.status(200).json({ ok: true }));
    registerMsHandwerkOrganic(healthApp);
    const healthServer = healthApp.listen(0);
    await once(healthServer, 'listening');
    try {
      const health = await fetch(`http://127.0.0.1:${healthServer.address().port}/health`);
      assert.equal(health.status, 200);
    } finally {
      await new Promise(resolve => healthServer.close(resolve));
    }
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('project draft accepts only approved services and approved local area', () => {
  const draft = buildDraft({
    service: 'Laminat und Vinyl verlegen',
    city: 'Kempten',
    projectDescription: 'In einer Wohnung wurde neuer Laminatboden verlegt.',
    photoUrls: ['https://ms-handwerkservice.de/fotos/projekt-1.jpg']
  });
  assert.equal(draft.adSpendEUR, 0);
  assert.equal(draft.paidAdsEnabled, false);
  assert.equal(draft.autoPublished, false);
  assert.equal(draft.reviewRequired, true);
  assert.match(draft.website.articleHtml, /Kempten und Umgebung/);
  assert.doesNotMatch(JSON.stringify(draft), forbiddenPattern);

  assert.throws(() => buildDraft({
    service: 'Elektro-Notdienst',
    city: 'Kempten',
    projectDescription: 'Tatsächliche Arbeit ausgeführt.'
  }), /SERVICE_NOT_ALLOWED/);
  assert.throws(() => buildDraft({
    service: 'Kleinreparaturen',
    city: 'München',
    projectDescription: 'Tatsächliche Arbeit ausgeführt.'
  }), /LOCATION_NOT_ALLOWED/);
  assert.throws(() => buildDraft({
    service: 'Kleinreparaturen',
    city: 'Kempten',
    projectDescription: 'Mal' + 'erarbeiten'
  }), /COPY_COMPLIANCE_FAILED/);
});

test('HTML text and slugs are safely escaped', () => {
  const draft = buildDraft({
    service: 'Fliesenreparaturen',
    city: 'Kempten',
    projectDescription: '<script>alert("x")</script> Eine Fliese wurde repariert.'
  });
  assert.doesNotMatch(draft.website.articleHtml, /<script>/);
  assert.doesNotMatch(draft.website.articleHtml, /&lt;script&gt;/);
  assert.match(draft.website.articleHtml, /alert\(&quot;x&quot;\)/);
  assert.equal(slugify('Streicharbeiten Kempten'), 'streicharbeiten-kempten');
});

test('legacy organic draft generation stays unpublished and has no external integrations', async () => {
  const app = express();
  registerMsHandwerkOrganic(app);
  const server = app.listen(0);
  await once(server, 'listening');
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/ms-handwerk/organic/status`);
    assert.equal(response.status, 200);
    const status = await response.json();
    assert.equal(status.mode, 'DRY_RUN_DRAFTS_ONLY');
    assert.equal(status.externalPublishingEnabled, false);
    assert.equal(status.paidAdsEnabled, false);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
