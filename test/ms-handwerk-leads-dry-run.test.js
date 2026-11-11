'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DRY_RUN_MODE,
  STATIC_HTML_FIXTURES,
  parseStaticListings,
  buildDryRunResult
} = require('../ms-handwerk-leads-dry-run');

test('the default safety lock is hardcoded to DRY_RUN', () => {
  assert.equal(DRY_RUN_MODE, true);
});

test('static aumass fixture parses only public Bavarian trade listings', () => {
  const leads = parseStaticListings('aumass', STATIC_HTML_FIXTURES.aumass);
  assert.equal(leads.length, 2);
  assert.equal(leads.every(lead => lead.fixture && lead.liveNotice === false), true);
  assert.equal(leads[0].crafts[0].name, 'Trockenbau');
  assert.equal(leads[0].eligibleForMsHandwerk, true);
  assert.equal(leads[1].crafts[0].name, 'Badsanierung');
  assert.equal(leads[1].eligibleForMsHandwerk, false);
});

test('vergabe.bayern fixture rejects private listings', () => {
  const leads = parseStaticListings('vergabeBayern', STATIC_HTML_FIXTURES.vergabeBayern);
  assert.equal(leads.length, 1);
  assert.equal(leads[0].crafts[0].name, 'Elektriker');
  assert.equal(leads[0].eligibleForMsHandwerk, false);
});

test('dry-run response reports zero external activity and zero cost', () => {
  const result = buildDryRunResult();
  assert.equal(result.mode, 'DRY_RUN');
  assert.equal(result.liveDataFetched, false);
  assert.equal(result.notificationSent, false);
  assert.equal(result.databaseWrites, 0);
  assert.equal(result.networkRequests, 0);
  assert.equal(result.paidApiCalls, 0);
  assert.equal(result.estimatedCostEUR, 0);
  assert.equal(result.publicBavariaFixtureCount, 3);
});

test('unknown source and invalid fixture inputs fail closed', () => {
  assert.throws(() => parseStaticListings('unknown', ''), /UNKNOWN_FIXTURE_SOURCE/);
  assert.throws(() => parseStaticListings('aumass', null), /INVALID_FIXTURE_HTML/);
});
