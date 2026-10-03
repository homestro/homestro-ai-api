'use strict';
const { isDeepStrictEqual } = require('node:util');
const { assertDraftProduct } = require('./shopify-safety');
const { normalizeSelectedDraftId } = require('./selected-draft');
const { aliExpressReference } = require('./aliexpress-reference');
const { fulfillmentCostEvidence } = require('./fulfillment-cost-evidence');

const PRODUCT_QUERY = 'query SupplierQuoteProduct($id:ID!){product(id:$id){id title status variants(first:250){nodes{id title sku inventoryItem{unitCost{amount currencyCode}}}pageInfo{hasNextPage}}metafields(first:100,namespace:"homestro"){nodes{key value type compareDigest}}}}';
const DEFINITIONS_QUERY = 'query SupplierQuoteDefinitions{metafieldDefinitions(first:100,ownerType:PRODUCT,namespace:"homestro"){nodes{key type{name}}pageInfo{hasNextPage}}}';
const DEFINITION_MUTATION = 'mutation SupplierQuoteDefinition($definition:MetafieldDefinitionInput!){metafieldDefinitionCreate(definition:$definition){createdDefinition{id}userErrors{field message code}}}';
const SAVE_MUTATION = 'mutation SupplierQuoteSave($metafields:[MetafieldsSetInput!]!){metafieldsSet(metafields:$metafields){metafields{key value}userErrors{field message code}}}';
const DEFINITIONS = [
  { key: 'aliexpress_url', name: 'AliExpress Lieferanten-URL', type: 'single_line_text_field' },
  { key: 'aliexpress_product_id', name: 'AliExpress Produkt-ID', type: 'single_line_text_field' },
  { key: 'fulfillment_cost_evidence', name: 'Lieferantenkosten und Versandnachweis', type: 'json' }
];

function fail(message, status = 400) { throw Object.assign(new Error(message), { status }); }
function validateQuote(product, input, now = Date.now()) {
  assertDraftProduct(product);
  const variants = product.variants?.nodes || [];
  if (product.variants?.pageInfo?.hasNextPage || !variants.length) fail('Every variant must be loaded before a quote can be saved.');
  if (!input || !['PRODUCT_ONLY', 'PRODUCT_AND_SHIPPING'].includes(input.shopifyUnitCostBasis)) fail('Specify whether DSers sent product cost only or product and shipping cost.');
  const ref = aliExpressReference({ url: input.sourceUrl });
  if (!ref.url || !ref.productId) fail('An actual AliExpress supplier URL is required; an option SKU is not a product ID.');
  if (!Array.isArray(input.variants)) fail('An explicit cost quote is required for every variant.');
  const quote = {
    schemaVersion: 2, source: 'DSERS_OPERATOR_QUOTE', currency: input.currency,
    destinationCountry: input.destinationCountry, quotedAt: input.quotedAt,
    shopifyUnitCostBasis: input.shopifyUnitCostBasis,
    variants: input.variants.map(row => ({
      variantId: row.variantId, shopifySku: row.shopifySku, supplierVariantId: row.supplierVariantId,
      sourceUrl: row.sourceUrl, supplierCostEur: row.supplierCostEur,
      shippingEur: row.shippingEur, procurementTaxEur: row.procurementTaxEur
    }))
  };
  const evidence = fulfillmentCostEvidence(quote, variants, ref.url, now);
  if (!evidence.verified) fail('Quote is incomplete, expired, or does not match the Shopify variants and costs: ' + evidence.reason, 422);
  return { ref, quote, evidence };
}

function errors(payload, operation) {
  if (!payload) fail(operation + ' returned no result.', 502);
  if (payload.userErrors?.length) fail(operation + ': ' + payload.userErrors.map(e => e.message).join('; '), 422);
}

async function ensureDefinitions(graphql, token) {
  const data = await graphql(DEFINITIONS_QUERY, {}, token);
  if (data.metafieldDefinitions?.pageInfo?.hasNextPage) fail('Too many Homestro definitions to validate safely.', 409);
  const existing = new Map((data.metafieldDefinitions?.nodes || []).map(d => [d.key, d.type.name]));
  for (const field of DEFINITIONS) {
    if (existing.has(field.key)) {
      if (existing.get(field.key) !== field.type) fail('Existing supplier definition has a conflicting type: ' + field.key, 409);
      continue;
    }
    const result = await graphql(DEFINITION_MUTATION, { definition: { ...field, ownerType: 'PRODUCT', namespace: 'homestro' } }, token);
    errors(result.metafieldDefinitionCreate, 'Supplier definition');
  }
}

async function readDraft(graphql, productId, token) {
  const data = await graphql(PRODUCT_QUERY, { id: normalizeSelectedDraftId(productId) }, token);
  if (!data.product) fail('Product not found.', 404);
  assertDraftProduct(data.product);
  if (data.product.variants?.pageInfo?.hasNextPage) fail('Products with more than 250 variants require a paginated import.', 422);
  return data.product;
}

async function saveSupplierQuote({ graphql, token, productId, input, now = Date.now() }) {
  let product = await readDraft(graphql, productId, token);
  validateQuote(product, input, now);
  await ensureDefinitions(graphql, token);
  product = await readDraft(graphql, productId, token);
  const { ref, quote, evidence } = validateQuote(product, input, now);
  const existing = new Map((product.metafields?.nodes || []).map(f => [f.key, f]));
  const values = [ref.url, ref.productId, JSON.stringify(quote)];
  const metafields = DEFINITIONS.map((field, i) => ({
    ownerId: product.id, namespace: 'homestro', key: field.key, type: field.type,
    value: values[i], compareDigest: existing.get(field.key)?.compareDigest ?? null
  }));
  const saved = await graphql(SAVE_MUTATION, { metafields }, token);
  errors(saved.metafieldsSet, 'Supplier quote');
  const verified = await readDraft(graphql, productId, token);
  const fields = new Map((verified.metafields?.nodes || []).map(f => [f.key, f.value]));
  for (let i = 0; i < DEFINITIONS.length; i++) {
    const key = DEFINITIONS[i].key;
    const actual = fields.get(key);
    const matches = key === 'fulfillment_cost_evidence' ? isDeepStrictEqual(JSON.parse(actual || 'null'), quote) : actual === values[i];
    if (!matches) fail('Supplier quote readback failed: ' + key, 502);
  }
  if (!fulfillmentCostEvidence(fields.get('fulfillment_cost_evidence'), verified.variants.nodes, fields.get('aliexpress_url'), now).verified) fail('Saved quote no longer matches Shopify costs.', 409);
  return { productId: product.id, status: verified.status, landedCostVerified: true, landedByVariant: evidence.landedByVariant, pricesChanged: false, published: false };
}

function registerSupplierQuoteBridge(app, { apiKey, graphql, getToken }) {
  app.get('/api/supplier-bridge/product', apiKey, async (req, res) => {
    try {
      const product = await readDraft(graphql, req.query.productId, await getToken());
      res.json({ ok: true, product, required: ['sourceUrl', 'shopifyUnitCostBasis', 'currency=EUR', 'destinationCountry=DE', 'quotedAt', 'all variant IDs, current SKUs, supplier variant IDs and explicit product/shipping/tax costs'], automaticDsersConnection: false });
    } catch (e) { res.status(e.status || 422).json({ ok: false, error: e.message }); }
  });
  app.post('/api/supplier-bridge/quote', apiKey, async (req, res) => {
    try {
      const result = await saveSupplierQuote({ graphql, token: await getToken(), productId: req.body?.productId, input: req.body?.quote });
      res.json({ ok: true, result });
    } catch (e) { res.status(e.status || 422).json({ ok: false, error: e.message }); }
  });
}

module.exports = { registerSupplierQuoteBridge, saveSupplierQuote, validateQuote, PRODUCT_QUERY, DEFINITIONS_QUERY, DEFINITION_MUTATION, SAVE_MUTATION };
