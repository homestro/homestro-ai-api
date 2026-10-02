'use strict';

const STOP = new Set(['the','and','for','with','from','set','new','neu','eine','einer','der','die','das','mit','fur','für','von','pcs','stuck','stück']);
function normalizedTokens(value) {
  return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().match(/[a-z0-9]+/g)?.filter(x => x.length > 2 && !STOP.has(x)) || [];
}
function modelNumbers(value) {
  return new Set(String(value || '').toUpperCase().match(/\b(?=[A-Z0-9-]*\d)[A-Z0-9]+(?:-[A-Z0-9]+)*\b/g) || []);
}
function amazonProductMatch(candidate, offer) {
  const left = new Set(normalizedTokens(candidate?.title));
  const right = new Set(normalizedTokens(offer?.title));
  const overlap = [...left].filter(x => right.has(x)).length;
  const titleScore = overlap / Math.max(1, Math.min(left.size, right.size));
  const candidateModels = modelNumbers([candidate?.title, candidate?.model, candidate?.sku].filter(Boolean).join(' '));
  const offerModels = modelNumbers([offer?.title, offer?.model, offer?.asin].filter(Boolean).join(' '));
  const modelConflict = candidateModels.size > 0 && offerModels.size > 0 && ![...candidateModels].some(x => offerModels.has(x));
  const modelMatch = candidateModels.size > 0 && [...candidateModels].some(x => offerModels.has(x));
  const confidence = modelConflict ? 0 : Math.min(1, titleScore + (modelMatch ? 0.2 : 0));
  return { matches: !modelConflict && overlap >= 2 && confidence >= 0.65, confidence, modelMatch, modelConflict };
}
function selectAmazonMatch(candidate, rows, priceParser = Number) {
  return (rows || []).map(offer => ({ offer, priceEur: priceParser(offer?.price?.value ?? offer?.priceEur ?? offer?.price ?? offer?.currentPrice), ...amazonProductMatch(candidate, offer) }))
    .filter(x => x.matches && Number.isFinite(x.priceEur) && x.priceEur > 0)
    .sort((a, b) => b.confidence - a.confidence || a.priceEur - b.priceEur)[0] || null;
}
module.exports = { amazonProductMatch, selectAmazonMatch };
