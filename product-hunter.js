'use strict';

function targetSellingPrice(cost, isHeadphone, rules) {
  const minRatio = isHeadphone ? rules.headphoneMinRatio : rules.minRatio;
  return Math.max(rules.minSellingPrice, Math.ceil(Number(cost) * minRatio * 100) / 100);
}

function externalCandidateRejection(candidate, rules) {
  if (String(candidate.source_role || 'supplier') === 'market_reference') return '';
  if (candidate.euWarehouse !== true) return 'eu-warehouse-not-confirmed';
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
  const minRatio = isHeadphone ? rules.headphoneMinRatio : rules.minRatio;
  const targetPrice = targetSellingPrice(cost, isHeadphone, rules);
  const economics = profitability({ selling_price: targetPrice, landed_cost_eur: cost });
  if (Number(economics.estimatedProfitEur || 0) < rules.minNetProfit) return 'profit-under-' + rules.minNetProfit + ':' + String(Math.round(economics.estimatedProfitEur || 0));
  if (targetPrice / cost < minRatio) return 'ratio-too-low';
  return '';
}

module.exports = { catalogCandidateRejection, externalCandidateRejection, targetSellingPrice, amazonComparison, chooseBestSource };
