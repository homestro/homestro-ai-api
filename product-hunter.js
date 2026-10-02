'use strict';

// Conservative eBay fee + advertising model. Supplier cost alone is not landed cost.
function targetSellingPrice(cost, isHeadphone, rules, env = process.env) {
  const commission = Number(env.EBAY_COMMISSION_RATE || 0.14);
  const feeVat = Number(env.EBAY_FEE_VAT_RATE || 0.19);
  const adRate = Number(env.EBAY_MAX_AD_RATE || 0.15);
  const orderFee = Number(env.EBAY_ORDER_FEE_EUR || 0.45);
  const denominator = 1 - commission * (1 + feeVat) - adRate;
  if (!Number.isFinite(denominator) || denominator <= 0) return Infinity;
  const floor = (Number(cost) + orderFee * (1 + feeVat) + rules.minNetProfit) / denominator;
  return Math.max(rules.minSellingPrice, Math.ceil(floor * 100) / 100);
}

function candidateProfitEvidence(candidate) {
  // Discovery currently has a supplier price, not verified destination shipping/tax costs.
  return {
    profitStatus: 'PROVISIONAL_BEFORE_SHIPPING_AND_TAX',
    profitModel: 'EBAY_FEES_PLUS_ADVERTISING',
    landedCostVerified: false,
    sellReady: false,
    pendingChecks: ['variant-supplier-cost', 'destination-shipping', 'applicable-tax', 'matched-market-price']
  };
}

function euWarehouseSearchSignal(candidate) {
  // Apify's AliExpress actor often exposes the warehouse intent only in the
  // originating search term (for example "Germany Warehouse kitchen tool")
  // while omitting shipFromCountry/warehouseCountry from the result row.
  // Treat this only as a sourcing CANDIDATE signal, never as final proof.
  let context = candidate?.context;
  if (typeof context === 'string') {
    try { context = JSON.parse(context); } catch { context = {}; }
  }
  const values = [
    candidate?.searchKeyword, candidate?.search_keyword, candidate?.keyword,
    context?.searchKeyword, context?.search_keyword, context?.keyword,
    context?.searchTerm, context?.search_term, context?.foundBySearchTerm
  ].filter(Boolean).map(String);
  const joined = values.join(' ');
  return /\b(?:EU\s*(?:Stock|Warehouse)|Germany\s*Warehouse|France\s*Warehouse|Poland\s*Warehouse|German\s*Warehouse|French\s*Warehouse|Polish\s*Warehouse)\b/i.test(joined);
}

function externalCandidateRejection(candidate, rules) {
  if (String(candidate.source_role || 'supplier') === 'market_reference') return '';
  // Explicit structured warehouse evidence remains preferred. Search-term
  // evidence only allows the already-paid row into evaluation; downstream
  // sourcing verification must still confirm the actual variant/warehouse.
  if (candidate.euWarehouse !== true && !euWarehouseSearchSignal(candidate)) return 'eu-warehouse-not-confirmed';
  if (candidate.euWarehouse !== true) {
    candidate.euWarehouseCandidate = true;
    candidate.euWarehouseVerificationRequired = true;
  }
  const cost = Number(candidate.costEur ?? candidate.cost);
  if (!Number.isFinite(cost) || cost <= 0) return 'invalid-cost';
  if (Number(candidate.sold || 0) < rules.minSold) return 'external-sales-under-threshold';
  return '';
}

function amazonComparison(candidate, rules) {
  const supplierCost = Number(candidate.costEur ?? candidate.cost);
  const amazonPrice = Number(candidate.amazonPriceEur ?? candidate.amazon_price_eur);
  const matchConfidence = Number(candidate.amazonMatchConfidence ?? candidate.amazon_match_confidence ?? 0);
  if (!Number.isFinite(amazonPrice) || amazonPrice <= 0) return { checked:false, reject:'', reason:'amazon-price-missing' };
  if (matchConfidence < rules.amazonMinMatchConfidence) return { checked:true, reject:'', reason:'amazon-match-unconfirmed', amazonPrice, matchConfidence };
  const requiredMarketPrice = targetSellingPrice(supplierCost, Boolean(candidate.isHeadphone), rules);
  if (amazonPrice < requiredMarketPrice) return { checked:true, reject:'amazon-market-too-cheap', reason:'amazon-below-required-selling-price', amazonPrice, requiredMarketPrice, matchConfidence };
  return { checked:true, reject:'', reason:'amazon-market-ok', amazonPrice, requiredMarketPrice, matchConfidence };
}

function chooseBestSource(candidate, rules) {
  const ali = Number(candidate.costEur ?? candidate.cost);
  const amazon = Number(candidate.amazonBuyPriceEur ?? candidate.amazon_buy_price_eur);
  const amazonUsable = candidate.amazonUsableAsSource === true && Number.isFinite(amazon) && amazon > 0;
  if (amazonUsable && (!Number.isFinite(ali) || amazon < ali)) return { source:'amazon-de', cost:amazon };
  return { source:String(candidate.source || 'aliexpress'), cost:ali };
}

function catalogCandidateRejection(candidate, rules, profitability) {
  const selectedSource=chooseBestSource(candidate,rules);
  const cost = Number(selectedSource.cost);
  const title = String(candidate.title || '').toLowerCase();
  if (!String(candidate.source_url || '').trim() || !String(candidate.id || '').trim()) return 'missing-id-or-url';
  const isHeadphone = /(earphone|earbuds?|headphone|headset|bluetooth headphones?|wireless headphones?|ai headphones?|kopfhörer|ohrhörer)/i.test(title);
  candidate.isHeadphone=isHeadphone;
  const blockedElectronics = /(smartwatch|watch phone|charger|cable|usb|led strip|camera|drone|gaming|projector|power bank|electronic|elektronik|speaker|lautsprecher)/i.test(title);
  if (blockedElectronics && !isHeadphone) return 'blocked-electronics';
  const junk = /(hook|hooks|hanging hook|adhesive hook|haken|box|boxes|storage box|organizer|organiser|aufbewahrung|rack|shelf|shelves|regal|holder|halter|stand|case|cover|bag|pouch|tasche|etui|hülle|keychain|key ring|schlüsselanhänger|sticker|decal|ornament|decoration|decor|deko|wall art|phone case|cable holder|clip|clamp|bracket)/i.test(title);
  if (junk) return 'junk-generic-accessory';
  const isKnife = /(kitchen knives?|chef knives?|cooking knives?|kitchen knife|messer küche|küchenmesser)/i.test(title);
  const practical = /(clean|cleaning|reinig|kitchen|küche|cook|kochen|knife|messer|laundry|wäsche|car|auto|garden|garten|tool|werkzeug|repair|repar|pet|hund|dog|cat|katze|fitness|sport|baby|beauty|pflege|travel|reise|camping|office|büro|headphone|earphone|earbud|kopfhörer|ohrhörer|bluetooth|wireless|ai)/i.test(title);
  if (!practical) return 'not-practical';
  const maxCost = isHeadphone ? rules.headphoneMaxCost : rules.maxCost;
  const minCost = isHeadphone ? rules.headphoneMinCost : 3;
  if (!Number.isFinite(cost) || cost < minCost || cost > maxCost) return 'cost-outside-range:' + String(cost);
  if (Number(candidate.sold || 0) < rules.minSold) return 'sold-under-' + rules.minSold + ':' + String(candidate.sold || 0);
  if (/(clothing|shoe|shoes|dress|jacket|shirt|pants|bra|underwear|swimwear|battery|laser|weapon|hunting knife|tactical knife|survival knife|pocket knife|butterfly knife|switchblade|medical|supplement|toy|plush|jewelry|necklace|ring|bracelet|wallet|mug|cup|bottle|towel|sock|slipper|curtain|pillow|flower|vase|generic|replacement|spare part)/i.test(title) && !isKnife) return 'blocked-category';
  const problem = /(clean|cleaning|reinig|stain|scrub|remove|repair|repar|fix|measure|cut|knife|messer|sharpen|organize|wash|laundry|pet hair|groom|training|pain relief|posture|exercise|grip|safety|protect|travel|camping|outdoor|car care|detailing|garden|prun|weed|drill|screw|paint|baking|cook|slice|peel|seal|vacuum|dust|steam|headphone|earphone|earbud|kopfhörer|ohrhörer|bluetooth|wireless|ai)/i.test(title);
  if (!problem) return 'no-problem-signal';
  const market=amazonComparison(candidate,rules);
  if(market.reject)return market.reject;
  const targetPrice = targetSellingPrice(cost, isHeadphone, rules);
  const economics = profitability({ selling_price: targetPrice, landed_cost_eur: cost });
  if (Number(economics.estimatedProfitEur || 0) < rules.minNetProfit) return 'profit-under-' + rules.minNetProfit + ':' + String(Math.round(economics.estimatedProfitEur || 0));
  return '';
}

module.exports = { catalogCandidateRejection, externalCandidateRejection, targetSellingPrice, amazonComparison, chooseBestSource, euWarehouseSearchSignal, candidateProfitEvidence };
