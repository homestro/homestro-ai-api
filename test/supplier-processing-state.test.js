'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { supplierProcessingState } = require('../supplier-processing-state');

test('DSers DRAFT without a supplier reference remains processable with supplier QA pending', () => {
  const dsersDraft = { status: 'DRAFT', vendor: 'DSers', title: 'Imported product' };
  const state = supplierProcessingState({ url: '', productId: '' });

  assert.equal(dsersDraft.status, 'DRAFT');
  assert.equal(state.available, false);
  assert.equal(state.reason, 'verified-supplier-reference-missing');
  for (const check of ['supplier-verification', 'variant-landed-cost', 'destination-shipping', 'matched-market-price']) {
    assert.ok(state.pendingChecks.includes(check), check);
  }
});

test('draft processor soft-pends missing supplier evidence instead of returning a skip', () => {
  const source = fs.readFileSync(require.resolve('../server.js'), 'utf8');
  const processor = source.slice(source.indexOf('async function processExistingDraftProduct'), source.indexOf('\nasync function processExistingDrafts'));

  assert.doesNotMatch(processor, /if\s*\(!src\|\|!reference\.productId\)\s*return/);
  assert.match(processor, /processed:true,skipped:false,reason:supplierState\.reason,pendingChecks/);
  assert.match(processor, /supplierState\.available&&landedEvidence\.verified/);
});
