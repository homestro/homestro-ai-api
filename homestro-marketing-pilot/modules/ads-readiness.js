const CHANNELS = [
  {id:'meta', platforms:['facebook','instagram'], needs:'Meta Ads OAuth and account approval'},
  {id:'google', platforms:['google_search','google_shopping'], needs:'Google Ads account and Merchant Center approval'},
  {id:'tiktok', platforms:['tiktok'], needs:'TikTok Ads account and pixel approval'},
  {id:'pinterest', platforms:['pinterest'], needs:'Pinterest Ads account and tag approval'},
  {id:'microsoft', platforms:['microsoft_ads'], needs:'Microsoft Ads account and UET approval'},
  {id:'sklik', platforms:['seznam_sklik'], needs:'Sklik account and conversion measurement'}
];

function isCandidate(row) {
  const p=row?.document||{};
  return row?.status==='ready' && p.status==='ACTIVE' && p.rejected!==true &&
    Array.isArray(p.variants) && p.variants.some(v=>v.available===true && Number(v.price)>0) &&
    typeof p.url==='string' && p.url.startsWith('https://homestro.de/products/');
}

/**
 * Read-only paid media readiness planner. It never calls an ad platform, creates
 * campaigns, changes budgets, or treats an organic-ready product as ad-approved.
 */
export function buildAdsReadiness({products=[],feedEnabled=false,merchantApprovalConfirmed=false,checkedAt=new Date()}={}) {
  const candidates=products.filter(isCandidate);
  const byCategory={};
  for (const row of candidates) {
    const key=String(row.document.categoryKey||'other').slice(0,60);
    byCategory[key]=(byCategory[key]||0)+1;
  }
  const blockers=['PAID_ADS_DISABLED','AD_SPEND_CAP_ZERO','PLATFORM_CONNECTIONS_NOT_VERIFIED',
    'CAMPAIGN_CREATION_REQUIRES_OWNER_AUTHORIZATION'];
  if (!feedEnabled) blockers.push('PRODUCT_FEED_DISABLED');
  if (!merchantApprovalConfirmed) blockers.push('MERCHANT_CENTER_NOT_APPROVED');
  return {
    mode:'read_only_plan',
    checkedAt:checkedAt instanceof Date?checkedAt.toISOString():new Date(checkedAt).toISOString(),
    executionEnabled:false,
    spendCapEUR:0,
    adSpendEUR:0,
    campaignCreationEnabled:false,
    productCounts:{catalog:products.length,marketingReadyCandidates:candidates.length,byCategory},
    channels:CHANNELS.map(channel=>({
      id:channel.id,platforms:channel.platforms,status:'not_connected',
      campaignIdeasAvailable:candidates.length>0,
      spendCapEUR:0,executionEnabled:false,requires:channel.needs
    })),
    googleFreeListings:{feedEnabled:Boolean(feedEnabled),merchantApprovalConfirmed:Boolean(merchantApprovalConfirmed),
      eligibleToSubmit:Boolean(feedEnabled&&merchantApprovalConfirmed),paidAdsReady:false},
    blockers,
    nextSteps:['Fix Merchant Center disapprovals and shipping configuration.',
      'Connect and verify each ad account and conversion measurement.',
      'Set a written campaign objective, maximum budget, and approval policy.',
      'Review campaign plans before any platform activation.'],
    safety:'This endpoint returns planning data only. It performs no platform writes and cannot spend money.'
  };
}
