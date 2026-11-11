'use strict';

const DEFAULT_INTERVAL_MS = 12 * 60 * 60 * 1000;
const MAX_PRODUCTS_PER_RUN = 1000;

function plainText(html) {
  return String(html || '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

function safeSeoDescription(descriptionHtml) {
  const text = plainText(descriptionHtml);
  if (!text) return '';
  const clipped = text.slice(0, 157).replace(/[\s,;:–-]+$/u, '');
  return clipped ? `${clipped}${text.length > clipped.length ? '…' : ''}` : '';
}

function registerShopOptimizer(app, { graphql, apiKey }) {
  const state = { running: false, lastRun: null, lastError: null, report: null, totals: { scanned: 0, seoUpdated: 0, altUpdated: 0 } };
  const intervalMs = Math.min(Math.max(Number(process.env.HOMESTRO_SHOP_OPTIMIZER_INTERVAL_MS) || DEFAULT_INTERVAL_MS, 60 * 60 * 1000), 7 * 24 * 60 * 60 * 1000);

  async function run() {
    if (state.running) return { skipped: true, reason: 'already-running' };
    state.running = true;
    const report = { startedAt: new Date().toISOString(), scanned: 0, seoUpdated: 0, altUpdated: 0, needsBulletReview: 0, proposals: [], errors: [] };
    try {
      let after = null;
      let pages = 0;
      while (report.scanned < MAX_PRODUCTS_PER_RUN && pages < 10) {
        const data = await graphql(
          'query($first:Int!,$after:String){products(first:$first,after:$after,query:"status:active"){nodes{id title handle descriptionHtml seo{title description} media(first:100){nodes{__typename ... on MediaImage{id alt}}}} pageInfo{hasNextPage endCursor}}}',
          { first: 100, after }
        );
        const connection = data.products;
        for (const product of connection.nodes || []) {
          report.scanned++;
          const title = String(product.title || '').trim();
          const seoTitle = String(product.seo?.title || '').trim();
          const seoDescription = String(product.seo?.description || '').trim();
          const descriptionText = plainText(product.descriptionHtml);
          const changes = {};
          if (!seoTitle && title) changes.title = title.slice(0, 70);
          if (!seoDescription && descriptionText) changes.description = safeSeoDescription(product.descriptionHtml);

          if (Object.keys(changes).length) {
            try {
              const seo = { title: changes.title || seoTitle, description: changes.description || seoDescription };
              const updated = await graphql(
                'mutation($product:ProductUpdateInput!){productUpdate(product:$product){product{id seo{title description}} userErrors{field message}}}',
                { product: { id: product.id, seo } }
              );
              const payload = updated.productUpdate;
              if (payload.userErrors?.length || !payload.product) throw new Error((payload.userErrors || []).map(x => x.message).join('; ') || 'SEO update returned no product');
              report.seoUpdated++;
            } catch (error) {
              report.errors.push({ productId: product.id, operation: 'seo', error: String(error.message || error).slice(0, 180) });
            }
          }

          const missingAlts = (product.media?.nodes || []).filter(media => media.__typename === 'MediaImage' && !String(media.alt || '').trim());
          if (missingAlts.length) {
            const files = missingAlts.map(media => ({ id: media.id, alt: `${title} – Produktansicht`.slice(0, 512) }));
            try {
              for (let i = 0; i < files.length; i += 25) {
                const result = await graphql(
                  'mutation($files:[FileUpdateInput!]!){fileUpdate(files:$files){files{id} userErrors{field message}}}',
                  { files: files.slice(i, i + 25) }
                );
                const payload = result.fileUpdate;
                if (payload.userErrors?.length) throw new Error(payload.userErrors.map(x => x.message).join('; '));
                report.altUpdated += (payload.files || []).length;
              }
            } catch (error) {
              report.errors.push({ productId: product.id, operation: 'image-alt', error: String(error.message || error).slice(0, 180) });
            }
          }

          if (!/<(?:ul|ol)\b/i.test(String(product.descriptionHtml || ''))) {
            report.needsBulletReview++;
            if (report.proposals.length < 100) report.proposals.push({ productId: product.id, title, issue: 'Description has no bullet list; review for clearer benefits. Existing product text was left unchanged.' });
          }
        }
        pages++;
        if (!connection.pageInfo?.hasNextPage || !connection.pageInfo.endCursor) break;
        after = connection.pageInfo.endCursor;
      }
      report.finishedAt = new Date().toISOString();
      report.truncated = report.scanned >= MAX_PRODUCTS_PER_RUN;
      state.lastRun = report.finishedAt;
      state.lastError = null;
      state.report = report;
      state.totals.scanned += report.scanned;
      state.totals.seoUpdated += report.seoUpdated;
      state.totals.altUpdated += report.altUpdated;
      return report;
    } catch (error) {
      report.finishedAt = new Date().toISOString();
      state.lastRun = report.finishedAt;
      state.lastError = String(error.message || error).slice(0, 300);
      report.error = state.lastError;
      state.report = report;
      throw error;
    } finally {
      state.running = false;
    }
  }

  app.get('/api/shop-optimizer/status', apiKey, (_req, res) => res.json({ ok: true, enabled: true, intervalMs, themeWrites: false, ...state }));
  app.post('/api/shop-optimizer/run', apiKey, async (_req, res) => {
    try { res.json({ ok: true, report: await run() }); }
    catch (error) { res.status(error.status || 502).json({ ok: false, error: String(error.message || error) }); }
  });

  setTimeout(() => run().catch(error => console.error('SHOP_OPTIMIZER_START_FAILED', String(error.message || error))), 30000);
  setInterval(() => run().catch(error => console.error('SHOP_OPTIMIZER_AUTO_FAILED', String(error.message || error))), intervalMs);
  return { run, state };
}

module.exports = { registerShopOptimizer, plainText, safeSeoDescription };
