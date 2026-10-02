'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { detectEuWarehouse } = require('../sourcing-evidence');

test('confirms supported EU countries from real Apify shipping and variant shapes', () => {
  for (const sample of [
    { shipping: { shipFromCountry: 'Germany' } },
    { logistics: { shipsFrom: { code: 'PL' } } },
    { variants: [{ warehouse: { country: 'France' } }] },
    { skus: [{ warehouse_country: 'Czech Republic' }] },
    { offers: [{ dispatchFrom: 'Belgium' }] },
    { shipping: { origin_country_code: 'NL' } },
    { warehouseLocation: 'Austria' },
    { delivery: { shippingFrom: 'Italy' } },
    { variants: [{ shipping: { ship_from_country: 'Spain' } }] }
  ]) assert.equal(detectEuWarehouse(sample).confirmed, true, JSON.stringify(sample));
});

test('never infers warehouse from product title, query, destination, or arbitrary booleans', () => {
  for (const sample of [
    { title: 'Ships from Germany kitchen cleaner' },
    { searchQuery: 'Poland warehouse gadget', keyword: 'DE stock' },
    { shipping: { shipToCountry: 'DE', destinationCountry: 'Germany' } },
    { euWarehouse: true, eu_stock: true },
    { shipping: { shipFromCountry: 'China' }, title: 'EU warehouse' }
  ]) assert.equal(detectEuWarehouse(sample).confirmed, false, JSON.stringify(sample));
});
