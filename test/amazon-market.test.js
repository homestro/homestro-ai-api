'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { amazonProductMatch, selectAmazonMatch } = require('../amazon-market');

test('matches the same Amazon product/model and extracts its EUR price', () => {
  const candidate = { title: 'Baseus Bowie MA10 wireless noise cancelling earbuds' };
  const rows = [
    { title: 'Generic wireless earbuds model X20', price: 12 },
    { title: 'Baseus Bowie MA10 Bluetooth Noise Cancelling Earbuds', price: { value: 39.99 }, url: 'https://amazon.de/dp/X' }
  ];
  const match = selectAmazonMatch(candidate, rows, Number);
  assert.equal(match.offer.url, 'https://amazon.de/dp/X');
  assert.equal(match.priceEur, 39.99);
  assert.equal(match.modelMatch, true);
});

test('rejects a superficially similar title when model numbers conflict', () => {
  const result = amazonProductMatch({ title: 'Baseus Bowie MA10 wireless earbuds' }, { title: 'Baseus Bowie M2 wireless earbuds' });
  assert.equal(result.matches, false);
  assert.equal(result.modelConflict, true);
});
