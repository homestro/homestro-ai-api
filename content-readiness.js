'use strict';
// Content can be complete while supplier economics still require review.
function contentReadiness(qa, { aiSucceeded = false, imagesVerified = false, optionalPending = [] } = {}) {
  const advisoryReasons = (qa?.reasons || []).filter(r => r === 'landed-cost-unverified' || /^variant-margin:\d+$/.test(r));
  const pendingReasons = (qa?.reasons || []).filter(r => !advisoryReasons.includes(r));
  if (!aiSucceeded) pendingReasons.push('ai-content');
  if (!imagesVerified) pendingReasons.push('image-verification');
  pendingReasons.push(...optionalPending);
  return { complete: pendingReasons.length === 0, pendingReasons: [...new Set(pendingReasons)], advisoryReasons };
}
module.exports = { contentReadiness };
