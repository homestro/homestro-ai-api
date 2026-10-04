'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {checkGallery} = require('../gallery-readiness');
test('a good first photo cannot approve a bad later variant or banner', async () => {
  const images = Array.from({length: 16}, (_, i) => ({id: String(i)}));
  const result = await checkGallery(images, image => image.id !== '15');
  assert.equal(result.verified, false);
  assert.equal(result.checked, 16);
  assert.deepEqual(result.failedIds, ['15']);
});
test('empty, partially fetched, and failed vision requests remain pending', async () => {
  assert.equal((await checkGallery([], () => true)).verified, false);
  assert.equal((await checkGallery([{id: 'a'}], () => true, {hasNextPage: true})).verified, false);
  assert.equal((await checkGallery([{id: 'a'}], () => {throw Error('vision unavailable');})).verified, false);
});
test('a complete gallery can pass without supplier pricing data', async () => {
  assert.equal((await checkGallery([{id: 'a'}, {id: 'b'}], () => true)).verified, true);
});
