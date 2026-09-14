export default () => {
  const asId = value => String(value || '').trim();
  const cleanTags = value => Array.isArray(value)
    ? [...new Set(value.flatMap(t => String(t).split(',').map(x => x.trim()).filter(Boolean)))]
    : [];

  shopify.tools.register('homestro_product_search', async ({ query = '', limit = 20 }) => {
    const safeLimit = Math.min(Math.max(Number(limit) || 20, 1), 50);
    const queryPart = query ? `query: ${JSON.stringify(query)}` : '';
    const gql = `query HomestroProducts {
      products(first: ${safeLimit}${queryPart ? `, ${queryPart}` : ''}) {
        nodes {
          id title handle status vendor productType tags totalInventory
          category { id name fullName }
          priceRangeV2 { minVariantPrice { amount currencyCode } maxVariantPrice { amount currencyCode } }
          variants(first: 50) { nodes { id title price compareAtPrice sku inventoryQuantity selectedOptions { name value } } }
          media(first: 50) { nodes { ... on MediaImage { id alt image { url width height } } } }
          seo { title description }
          collections(first: 20) { nodes { id title handle } }
        }
        pageInfo { hasNextPage endCursor }
      }
    }`;
    return shopify.query(gql);
  });

  shopify.tools.register('homestro_price_check', async ({ cost, selling_price }) => {
    const c = Number(cost);
    const p = Number(selling_price);
    const ratio = c > 0 ? p / c : 0;
    return {
      valid: Number.isFinite(c) && Number.isFinite(p) && c <= 10 && p >= 34.9 && ratio >= 3,
      cost_eur: c,
      selling_price_eur: p,
      ratio: Number(ratio.toFixed(2)),
      rules: { max_cost_eur: 10, min_selling_price_eur: 34.9, min_ratio: 3 }
    };
  });

  shopify.tools.register('homestro_create_draft', async ({ title, description_html = '', vendor = '', product_type = '', category_id = '', handle = '', seo_title = '', seo_description = '', tags = [], price = '', compare_at_price = '' }) => {
    if (!String(title || '').trim()) throw new Error('Product title is required.');
    const product = {
      title: String(title).trim(),
      descriptionHtml: String(description_html || '').trim(),
      status: 'DRAFT',
      ...(vendor ? { vendor: String(vendor).trim() } : {}),
      ...(product_type ? { productType: String(product_type).trim() } : {}),
      ...(category_id ? { category: asId(category_id) } : {}),
      ...(handle ? { handle: String(handle).trim() } : {}),
      ...(seo_title || seo_description ? { seo: { ...(seo_title ? { title: String(seo_title).trim() } : {}), ...(seo_description ? { description: String(seo_description).trim() } : {}) } } : {}),
      ...(cleanTags(tags).length ? { tags: cleanTags(tags) } : {})
    };
    const gql = `mutation HomestroCreateDraft($product: ProductCreateInput!) {
      productCreate(product: $product) {
        product { id title handle status vendor productType tags seo { title description } }
        userErrors { field message }
      }
    }`;
    const result = await shopify.query(gql, { variables: { product } });
    const payload = result?.productCreate;
    if (payload?.userErrors?.length) return { ok: false, userErrors: payload.userErrors };
    const created = payload?.product;
    if (created?.id && price !== '') {
      const variantResult = await shopify.query(`mutation HomestroSetInitialPrice($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
        productVariantsBulkUpdate(productId: $productId, variants: $variants) {
          productVariants { id price compareAtPrice }
          userErrors { field message }
        }
      }`, { variables: { productId: created.id, variants: [{ id: null, price: String(price), ...(compare_at_price !== '' ? { compareAtPrice: String(compare_at_price) } : {}) }] } });
      if (variantResult?.productVariantsBulkUpdate?.userErrors?.length) return { ok: false, product: created, userErrors: variantResult.productVariantsBulkUpdate.userErrors };
    }
    return { ok: true, product: created, status: 'DRAFT' };
  });

  shopify.tools.register('homestro_optimize_product', async ({ product_id, title = '', description_html = '', vendor = '', product_type = '', category_id = '', handle = '', seo_title = '', seo_description = '', tags = [], status = 'DRAFT', collection_ids = [], variants = [], media = [] }) => {
    const id = asId(product_id);
    if (!id) throw new Error('product_id is required.');
    if (status !== 'DRAFT') throw new Error('Homestro AI Control only allows DRAFT status.');

    const update = {
      id,
      status: 'DRAFT',
      ...(title ? { title: String(title).trim() } : {}),
      ...(description_html ? { descriptionHtml: String(description_html).trim() } : {}),
      ...(vendor ? { vendor: String(vendor).trim() } : {}),
      ...(product_type ? { productType: String(product_type).trim() } : {}),
      ...(category_id ? { category: asId(category_id) } : {}),
      ...(handle ? { handle: String(handle).trim() } : {}),
      ...(seo_title || seo_description ? { seo: { ...(seo_title ? { title: String(seo_title).trim() } : {}), ...(seo_description ? { description: String(seo_description).trim() } : {}) } } : {}),
      ...(cleanTags(tags).length ? { tags: cleanTags(tags) } : {})
    };

    const result = await shopify.query(`mutation HomestroOptimizeProduct($product: ProductUpdateInput!) {
      productUpdate(product: $product) {
        product { id title handle status vendor productType tags category { id name fullName } seo { title description } }
        userErrors { field message }
      }
    }`, { variables: { product: update } });
    const payload = result?.productUpdate;
    if (payload?.userErrors?.length) return { ok: false, stage: 'product', userErrors: payload.userErrors };

    const output = { ok: true, product: payload?.product || null, status: 'DRAFT', warnings: [] };

    if (Array.isArray(variants) && variants.length) {
      const variantInputs = variants.map(v => ({
        id: asId(v.id),
        ...(v.price !== undefined && v.price !== '' ? { price: String(v.price) } : {}),
        ...(v.compare_at_price !== undefined && v.compare_at_price !== '' ? { compareAtPrice: String(v.compare_at_price) } : {}),
        ...(v.sku !== undefined ? { inventoryItem: { sku: String(v.sku) } } : {})
      })).filter(v => v.id);
      if (variantInputs.length) {
        const vr = await shopify.query(`mutation HomestroUpdateVariants($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
          productVariantsBulkUpdate(productId: $productId, variants: $variants) {
            productVariants { id title price compareAtPrice sku }
            userErrors { field message }
          }
        }`, { variables: { productId: id, variants: variantInputs } });
        if (vr?.productVariantsBulkUpdate?.userErrors?.length) output.warnings.push({ stage: 'variants', userErrors: vr.productVariantsBulkUpdate.userErrors });
      }
    }

    if (Array.isArray(collection_ids) && collection_ids.length) {
      const cr = await shopify.query(`mutation HomestroAddCollections($productId: ID!, $collectionIds: [ID!]!) {
        collectionsAddProducts(productIds: [$productId], collectionIds: $collectionIds) {
          userErrors { field message }
        }
      }`, { variables: { productId: id, collectionIds: collection_ids.map(asId).filter(Boolean) } });
      if (cr?.collectionsAddProducts?.userErrors?.length) output.warnings.push({ stage: 'collections', userErrors: cr.collectionsAddProducts.userErrors });
    }

    if (Array.isArray(media) && media.length) {
      const mediaInputs = media.map(m => ({
        originalSource: String(m.original_source || '').trim(),
        mediaContentType: 'IMAGE',
        ...(m.alt ? { alt: String(m.alt).trim() } : {})
      })).filter(m => m.originalSource);
      if (mediaInputs.length) {
        const mr = await shopify.query(`mutation HomestroAddMedia($productId: ID!, $media: [CreateMediaInput!]!) {
          productCreateMedia(productId: $productId, media: $media) {
            media { ... on MediaImage { id alt status } }
            mediaUserErrors { field message }
          }
        }`, { variables: { productId: id, media: mediaInputs } });
        if (mr?.productCreateMedia?.mediaUserErrors?.length) output.warnings.push({ stage: 'media', userErrors: mr.productCreateMedia.mediaUserErrors });
      }
    }

    return output;
  });
};
