'use strict';

const DEFAULT_PRODUCT_RULES = Object.freeze({
  maxCost: 15,
  minSellingPrice: 34.9,
  minRatio: 3,
  minSold: 1000,
  minNetProfit: 10,
  headphoneMinCost: 10,
  headphoneMaxCost: 27,
  headphoneMinRatio: 2.9,
  amazonMinMatchConfidence: 0.85
});

function finiteNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function getProductRules(env = process.env) {
  return {
    maxCost: finiteNumber(env.MAX_PRODUCT_COST, DEFAULT_PRODUCT_RULES.maxCost),
    minSellingPrice: finiteNumber(env.MIN_SELLING_PRICE, DEFAULT_PRODUCT_RULES.minSellingPrice),
    minRatio: finiteNumber(env.MIN_PRICE_COST_RATIO, DEFAULT_PRODUCT_RULES.minRatio),
    minSold: finiteNumber(env.HOMESTRO_MIN_SOLD, DEFAULT_PRODUCT_RULES.minSold),
    minNetProfit: finiteNumber(env.MIN_NET_PROFIT_EUR, DEFAULT_PRODUCT_RULES.minNetProfit),
    headphoneMinCost: finiteNumber(env.HOMESTRO_HEADPHONE_MIN_COST, DEFAULT_PRODUCT_RULES.headphoneMinCost),
    headphoneMaxCost: finiteNumber(env.HOMESTRO_HEADPHONE_MAX_COST, DEFAULT_PRODUCT_RULES.headphoneMaxCost),
    headphoneMinRatio: finiteNumber(env.HOMESTRO_HEADPHONE_MIN_RATIO, DEFAULT_PRODUCT_RULES.headphoneMinRatio),
    amazonMinMatchConfidence: finiteNumber(env.HOMESTRO_AMAZON_MIN_MATCH_CONFIDENCE, DEFAULT_PRODUCT_RULES.amazonMinMatchConfidence)
  };
}

function validateProductEconomics({ cost, sellingPrice, ratio }, env = process.env) {
  const rules = getProductRules(env);
  const numericCost = Number(cost);
  const numericSellingPrice = Number(sellingPrice);
  const numericRatio = ratio === undefined ? numericSellingPrice / numericCost : Number(ratio);
  const commission = finiteNumber(env.EBAY_COMMISSION_RATE, .14) * (1 + finiteNumber(env.EBAY_FEE_VAT_RATE, .19));
  const ad = finiteNumber(env.EBAY_MAX_AD_RATE, .15);
  const fixed = finiteNumber(env.EBAY_ORDER_FEE_EUR, .45) * (1 + finiteNumber(env.EBAY_FEE_VAT_RATE, .19));
  const estimatedContributionBeforeShippingTax = numericSellingPrice * (1 - commission - ad) - numericCost - fixed;
  return {
    profitStatus: 'PROVISIONAL_BEFORE_SHIPPING_AND_TAX', sellReady: false,
    estimatedContributionBeforeShippingTax,
    valid: Number.isFinite(numericCost) && numericCost > 0 &&
      Number.isFinite(numericSellingPrice) && numericSellingPrice >= rules.minSellingPrice &&
      Number.isFinite(numericRatio) && numericRatio > 0 &&
      Number.isFinite(estimatedContributionBeforeShippingTax) && estimatedContributionBeforeShippingTax >= rules.minNetProfit &&
      numericCost <= rules.maxCost,
    product: { cost: numericCost, sellingPrice: numericSellingPrice, ratio: numericRatio },
    rules
  };
}

module.exports = { DEFAULT_PRODUCT_RULES, getProductRules, validateProductEconomics };
