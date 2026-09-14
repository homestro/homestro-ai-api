export default () => {
  const asId = value => String(value || '').trim();
  const cleanTags = value => Array.isArray(value)
    ? [...new Set(value.flatMap(t => String(t).split(',').map(x => x.trim()).filter(Boolean)))]
    : [];

  const railway = async (path, options = {}) => {
    const response = await fetch(path, {
      ...options,
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }
    });
    const text = await response.text();
    let data;
    try { data = JSON.parse(text); } catch { throw new Error(`Railway returned invalid JSON (${response.status}).`); }
    if (!response.ok || data?.ok === false) throw new Error(data?.error || `Railway request failed (${response.status}).`);
    return data;
  };

  shopify.tools.register('homestro_product_search', async ({ query = '', limit = 20 }) => {
    const safeLimit = Math.min(Math.max(Number(limit) || 20, 1), 50);
    const queryPart = query ? `, query: ${JSON.stringify(query)}` : '';
    return shopify.query(`query HomestroProducts { products(first: ${safeLimit}${queryPart}) { nodes { id title handle status vendor productType tags totalInventory category { id name fullName } priceRangeV2 { minVariantPrice { amount currencyCode } maxVariantPrice { amount currencyCode } } variants(first: 100) { nodes { id title price compareAtPrice sku inventoryQuantity selectedOptions { name value } image { id url altText } } } media(first: 50) { nodes { ... on MediaImage { id alt image { url width height } } } } seo { title description } collections(first: 20) { nodes { id title handle } } } pageInfo { hasNextPage endCursor } } }`);
  });

  shopify.tools.register('homestro_read_variants', async ({ product_id }) => {
    const id = asId(product_id);
    if (!id) throw new Error('product_id is required.');
    return shopify.query(`query HomestroReadVariants($id: ID!) { product(id: $id) { id title status options { id name position optionValues { id name } } variants(first: 100) { nodes { id title sku selectedOptions { name value } price compareAtPrice image { id url altText } } } } }`, { variables: { id } });
  });

  shopify.tools.register('homestro_price_check', async ({ cost, selling_price }) => {
    const c = Number(cost); const p = Number(selling_price); const ratio = c > 0 ? p / c : 0;
    const valid = Number.isFinite(c) && Number.isFinite(p) && c <= 12 && p >= c * 3;
    return { valid, cost_eur: c, selling_price_eur: p, ratio: Number(ratio.toFixed(2)), rules: { max_cost_eur: 12, min_selling_price_formula: 'supplier cost × 3', min_ratio: 3 } };
  });

  shopify.tools.register('homestro_create_draft', async ({ title, description_html = '', vendor = '', product_type = '', category_id = '', handle = '', seo_title = '', seo_description = '', tags = [], price = '', compare_at_price = '' }) => {
    if (!String(title || '').trim()) throw new Error('Product title is required.');
    const product = { title: String(title).trim(), descriptionHtml: String(description_html || '').trim(), status: 'DRAFT', ...(vendor ? { vendor: String(vendor).trim() } : {}), ...(product_type ? { productType: String(product_type).trim() } : {}), ...(category_id ? { category: asId(category_id) } : {}), ...(handle ? { handle: String(handle).trim() } : {}), ...(seo_title || seo_description ? { seo: { ...(seo_title ? { title: String(seo_title).trim() } : {}), ...(seo_description ? { description: String(seo_description).trim() } : {}) } } : {}), ...(cleanTags(tags).length ? { tags: cleanTags(tags) } : {}) };
    const result = await shopify.query(`mutation HomestroCreateDraft($product: ProductCreateInput!) { productCreate(product: $product) { product { id title handle status vendor productType tags seo { title description } } userErrors { field message } } }`, { variables: { product } });
    const payload = result?.productCreate;
    if (payload?.userErrors?.length) return { ok: false, userErrors: payload.userErrors };
    const created = payload?.product;
    if (created?.id && price !== '') {
      const variantResult = await shopify.query(`mutation HomestroSetInitialPrice($productId: ID!, $variants: [ProductVariantsBulkInput!]!) { productVariantsBulkUpdate(productId: $productId, variants: $variants) { productVariants { id price compareAtPrice } userErrors { field message } } }`, { variables: { productId: created.id, variants: [{ id: null, price: String(price), ...(compare_at_price !== '' ? { compareAtPrice: String(compare_at_price) } : {}) }] } });
      if (variantResult?.productVariantsBulkUpdate?.userErrors?.length) return { ok: false, product: created, userErrors: variantResult.productVariantsBulkUpdate.userErrors };
    }
    return { ok: true, product: created, status: 'DRAFT' };
  });

  shopify.tools.register('homestro_optimize_product', async ({ product_id, title = '', description_html = '', vendor = '', product_type = '', category_id = '', handle = '', seo_title = '', seo_description = '', tags = [], status = 'DRAFT', collection_ids = [], variants = [], media = [], option_values = [] }) => {
    const id = asId(product_id);
    if (!id) throw new Error('product_id is required.');
    if (status !== 'DRAFT') throw new Error('Homestro AI Control only allows DRAFT status.');
    const update = { id, status: 'DRAFT', ...(title ? { title: String(title).trim() } : {}), ...(description_html ? { descriptionHtml: String(description_html).trim() } : {}), ...(vendor ? { vendor: String(vendor).trim() } : {}), ...(product_type ? { productType: String(product_type).trim() } : {}), ...(category_id ? { category: asId(category_id) } : {}), ...(handle ? { handle: String(handle).trim() } : {}), ...(seo_title || seo_description ? { seo: { ...(seo_title ? { title: String(seo_title).trim() } : {}), ...(seo_description ? { description: String(seo_description).trim() } : {}) } } : {}), ...(cleanTags(tags).length ? { tags: cleanTags(tags) } : {}) };
    const result = await shopify.query(`mutation HomestroOptimizeProduct($product: ProductUpdateInput!) { productUpdate(product: $product) { product { id title handle status vendor productType tags category { id name fullName } seo { title description } } userErrors { field message } } }`, { variables: { product: update } });
    const payload = result?.productUpdate;
    if (payload?.userErrors?.length) return { ok: false, stage: 'product', userErrors: payload.userErrors };
    const output = { ok: true, product: payload?.product || null, status: 'DRAFT', warnings: [] };
    if (Array.isArray(variants) && variants.length) {
      const variantInputs = variants.map(v => ({ id: asId(v.id), ...(v.price !== undefined && v.price !== '' ? { price: String(v.price) } : {}), ...(v.compare_at_price !== undefined && v.compare_at_price !== '' ? { compareAtPrice: String(v.compare_at_price) } : {}), ...(v.sku !== undefined ? { inventoryItem: { sku: String(v.sku) } } : {}) })).filter(v => v.id);
      if (variantInputs.length) {
        const vr = await shopify.query(`mutation HomestroUpdateVariants($productId: ID!, $variants: [ProductVariantsBulkInput!]!) { productVariantsBulkUpdate(productId: $productId, variants: $variants) { productVariants { id title price compareAtPrice sku selectedOptions { name value } image { id url altText } } userErrors { field message } } }`, { variables: { productId: id, variants: variantInputs } });
        if (vr?.productVariantsBulkUpdate?.userErrors?.length) output.warnings.push({ stage: 'variants', userErrors: vr.productVariantsBulkUpdate.userErrors });
      }
    }
    if (Array.isArray(option_values) && option_values.length) {
      const optionInputs = option_values.map(v => ({ id: asId(v.id), optionValues: Array.isArray(v.option_values) ? v.option_values.map(o => ({ optionName: String(o.option_name || '').trim(), name: String(o.name || '').trim() })).filter(o => o.optionName && o.name) : [] })).filter(v => v.id && v.optionValues.length);
      if (optionInputs.length) {
        const or = await shopify.query(`mutation HomestroUpdateVariantOptionValues($productId: ID!, $variants: [ProductVariantsBulkInput!]!) { productVariantsBulkUpdate(productId: $productId, variants: $variants, allowPartialUpdates: false) { product { id title options { id name optionValues { id name } } variants(first: 100) { nodes { id title selectedOptions { name value } image { id url altText } } } } userErrors { field message } } }`, { variables: { productId: id, variants: optionInputs } });
        if (or?.productVariantsBulkUpdate?.userErrors?.length) output.warnings.push({ stage: 'option_values', userErrors: or.productVariantsBulkUpdate.userErrors });
        else output.option_values_updated = optionInputs.length;
      }
    }
    if (Array.isArray(collection_ids) && collection_ids.length) {
      const cr = await shopify.query(`mutation HomestroAddCollections($productId: ID!, $collectionIds: [ID!]!) { collectionsAddProducts(productIds: [$productId], collectionIds: $collectionIds) { userErrors { field message } } }`, { variables: { productId: id, collectionIds: collection_ids.map(asId).filter(Boolean) } });
      if (cr?.collectionsAddProducts?.userErrors?.length) output.warnings.push({ stage: 'collections', userErrors: cr.collectionsAddProducts.userErrors });
    }
    if (Array.isArray(media) && media.length) {
      const mediaInputs = media.map(m => ({ originalSource: String(m.original_source || '').trim(), mediaContentType: 'IMAGE', ...(m.alt ? { alt: String(m.alt).trim() } : {}) })).filter(m => m.originalSource);
      if (mediaInputs.length) {
        const mr = await shopify.query(`mutation HomestroAddMedia($productId: ID!, $media: [CreateMediaInput!]!) { productCreateMedia(productId: $productId, media: $media) { media { ... on MediaImage { id alt status } } mediaUserErrors { field message } } }`, { variables: { productId: id, media: mediaInputs } });
        if (mr?.productCreateMedia?.mediaUserErrors?.length) output.warnings.push({ stage: 'media', userErrors: mr.productCreateMedia.mediaUserErrors });
      }
    }
    return output;
  });

  // Railway is the brain: Sidekick pulls the next queued instruction, executes it with Shopify tools, then reports the result.
  shopify.tools.register('homestro_next_railway_task', async () => railway('/api/sidekick/tasks/next'));
  shopify.tools.register('homestro_submit_railway_task_result', async ({ task_id, result = {} }) => {
    if (!task_id) throw new Error('task_id is required.');
    return railway(`/api/sidekick/tasks/${encodeURIComponent(task_id)}/result`, { method: 'POST', body: JSON.stringify(result) });
  });
  shopify.tools.register('homestro_railway_task_status', async () => railway('/api/sidekick/tasks/status'));

  shopify.tools.register('homestro_catalog_autopilot_run', async () => {
    return railway('/api/sidekick/automation/run', { method: 'POST', body: '{}' });
  });

  shopify.tools.register('homestro_catalog_autopilot_status', async () => {
    return railway('/api/sidekick/automation/status');
  });
};
