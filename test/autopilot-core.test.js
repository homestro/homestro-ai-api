'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeOptionName, normalizeVariantValue, priceForCost,
  canonicalImageUrl, selectImages, categoryKey, variantMediaAssociations, qaProduct
} = require('../autopilot-core');

const germanDescription = '<p>' + ('Dieses Produkt bietet eine praktische Anwendung für den Alltag und verbindet eine zuverlässige Ausführung mit einfacher Handhabung. Die Eigenschaften und technischen Daten sind übersichtlich beschrieben. '.repeat(7)) + '</p>';

function ready(overrides = {}) {
  return {
    status: 'DRAFT', title: 'Praktischer Küchenhelfer für den Alltag', description: germanDescription,
    seo: { title: 'Praktischer Küchenhelfer', description: 'Küchenhelfer für eine einfache und zuverlässige Anwendung.' },
    collections: { nodes: [{ id: 'gid://shopify/Collection/1' }] },
    variants: { nodes: [{ id: 'v1', price: '39.90', selectedOptions: [{ name: 'Farbe', value: 'Schwarz' }], image: { url: 'https://cdn.example/a.jpg' }, inventoryItem: { unitCost: { amount: '10' } } }] },
    media: { nodes: [{ image: { url: 'https://cdn.example/a.jpg', width: 1200, height: 1200 } }] },
    rules: { minSellingPrice: 34.9, minRatio: 3, minNetProfit: 12 }, ...overrides
  };
}

test('normalizes supplier variant and option labels into meaningful German', () => {
  assert.equal(normalizeOptionName('Color'), 'Farbe');
  assert.equal(normalizeVariantValue('A', { optionName: 'Ausführung' }), 'Ausführung A');
  assert.equal(normalizeVariantValue('As picture', { imageAlt: 'Schwarze Ausführung' }), 'Schwarze Ausführung');
  assert.equal(normalizeVariantValue('Elbow-1Pair'), 'Ellbogenbandage – 1 Paar');
  assert.equal(normalizeVariantValue('3PCS'), '3 Stück');
});

test('calculates per-variant price satisfying ratio and net-margin rules', () => {
  const price = priceForCost(10, 20, { minSellingPrice: 34.9, minRatio: 3, minNetProfit: 12, commissionRate: .14, feeVatRate: .19, adRate: .15, orderFee: .45 });
  assert.equal(price, 34.9);
  assert.ok(price / 10 >= 3);
  assert.equal(priceForCost(undefined, 20), null);
});

test('deduplicates images, rejects supplier graphics and chooses a square high-resolution hero', () => {
  const images = [
    { image: { url: 'https://cdn.example/item_100x100.jpg?v=1', width: 100, height: 100 } },
    { image: { url: 'https://cdn.example/hero.jpg?v=1', width: 1400, height: 1400 } },
    { image: { url: 'https://cdn.example/hero.jpg?v=2', width: 1400, height: 1400 } },
    { image: { url: 'https://cdn.example/size-chart.jpg', width: 1200, height: 1200 } }
  ];
  assert.equal(canonicalImageUrl(images[1].image.url), 'https://cdn.example/hero.jpg');
  assert.deepEqual(selectImages(images).map(x => x.image.url), ['https://cdn.example/hero.jpg?v=1']);
});

test('maps product semantics to the configured collection key', () => {
  assert.equal(categoryKey('Kochmesser für die Küche'), 'kueche');
  assert.equal(categoryKey('Hundebürste für Haustiere'), 'haustiere');
});

test('associates a variant image only when supplier alt text identifies one unambiguous variant', () => {
  const variants = [
    { id: 'red', selectedOptions: [{ name: 'Color', value: 'red' }] },
    { id: 'blue', selectedOptions: [{ name: 'Color', value: 'blue' }], image: { id: 'existing' } },
    { id: 'unknown', selectedOptions: [{ name: 'Style', value: 'A' }] }
  ];
  const media = [{ id: 'media-red', alt: 'Produkt in Rot' }, { id: 'generic', alt: 'Produktansicht' }];
  assert.deepEqual(variantMediaAssociations(variants, media), [{ variantId: 'red', mediaIds: ['media-red'] }]);
});

test('final QA accepts complete German DRAFT data with SEO, collection, margin and images', () => {
  assert.deepEqual(qaProduct(ready()), { ok: true, reasons: [] });
});

test('final QA blocks raw variants, missing variant images, bad margins and incomplete German/SEO', () => {
  const product = ready({
    description: '<p>Buy now</p>', seo: {}, collections: { nodes: [] },
    variants: { nodes: [
      { price: '12', selectedOptions: [{ name: 'Color', value: 'As picture' }], inventoryItem: { unitCost: { amount: '10' } } },
      { price: '35', selectedOptions: [{ name: 'Color', value: 'B' }], inventoryItem: { unitCost: { amount: '20' } } }
    ] }
  });
  const qa = qaProduct(product);
  assert.equal(qa.ok, false);
  for (const reason of ['german-content', 'seo', 'collection', 'variant-label:0', 'variant-margin:0', 'variant-image:0']) assert.ok(qa.reasons.includes(reason), reason);
});

test('DRAFT-only QA rejects ACTIVE products even when all quality fields pass', () => {
  const qa = qaProduct(ready({ status: 'ACTIVE' }));
  assert.equal(qa.ok, false);
  assert.ok(qa.reasons.includes('draft-only'));
});
