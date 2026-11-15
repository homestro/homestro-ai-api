'use strict';

const {createHmac}=require('node:crypto');
const ACCOUNT_ID='act_918741266442442';
const TARGET_CAMPAIGN_ID='120254762990220274';
const DAILY_CAP_EUR=Number.isFinite(Number(process.env.MAX_DAILY_AD_SPEND_EUR))?Number(process.env.MAX_DAILY_AD_SPEND_EUR):10;
const START_BUDGET_EUR=5;
const CAMPAIGN_NAME='Homestro AI Autopilot - Erazer XP6';
const PRODUCT_HANDLE='lenovo-erazer-xp6-bluetooth-in-ear-kopfhoerer-ipx5';
const PRODUCT_URL='https://homestro.de/products/'+PRODUCT_HANDLE;
const AD_COPY='Auch fern von Zuhause kann ein vertrauter Song den Tag leichter machen. Die Erazer XP6 begleiten dich unterwegs mit deiner Musik und deinen Podcasts. Entdecke deinen kleinen Moment Zuhausegefühl bei Homestro.';
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const centsToEur=value=>{const n=Number(value);return Number.isFinite(n)&&n>=0?n/100:null;};

function accountBudgetDecision({accountId,currency,spendTodayEur,activeDailyBudgetsEur,proposedDailyBudgetEur=0,capEur=DAILY_CAP_EUR}={}){
  const spend=Number(spendTodayEur),active=Number(activeDailyBudgetsEur),proposed=Number(proposedDailyBudgetEur),cap=Number(capEur);
  if(accountId!==ACCOUNT_ID)return {allowed:false,reason:'META_AD_ACCOUNT_MISMATCH'};
  if(String(currency||'').toUpperCase()!=='EUR')return {allowed:false,reason:'META_ACCOUNT_CURRENCY_MUST_BE_EUR'};
  if(![spend,active,proposed,cap].every(n=>Number.isFinite(n)&&n>=0))return {allowed:false,reason:'META_ACCOUNT_BUDGET_DATA_INVALID'};
  const committed=spend+active+proposed;
  if(spend>=cap||spend+active>=cap||committed>=cap)return {allowed:false,reason:'META_ACCOUNT_DAILY_CAP_REACHED',spendTodayEur:spend,activeDailyBudgetsEur:active,proposedDailyBudgetEur:proposed,committedDailyEur:committed,capEur:cap};
  return {allowed:true,reason:null,spendTodayEur:spend,activeDailyBudgetsEur:active,proposedDailyBudgetEur:proposed,committedDailyEur:committed,capEur:cap};
}

class LiveMetaExecutor{
  constructor({metaConnection,shopifyGraphQL,env=process.env,fetchImpl=global.fetch,logger=console}={}){
    this.metaConnection=metaConnection;this.shopifyGraphQL=shopifyGraphQL;this.env=env;this.fetch=fetchImpl;this.logger=logger;
  }
  async token(){
    if(this.metaConnection){
      try{
        const status=await this.metaConnection.check();
        if(status?.state==='connected'){
          const c=await this.metaConnection.credentials();
          if(c.userToken&&c.adAccountId===ACCOUNT_ID)return c.userToken;
        }
      }catch(e){this.logger.warn?.('[jarvis-autopilot] META_OAUTH_TOKEN_UNAVAILABLE',String(e?.code||e?.message||'OAUTH_LOOKUP_FAILED').slice(0,80));}
    }
    const fallback=String(this.env.META_ACCESS_TOKEN||'').trim();
    if(fallback)return fallback;
    throw Error('META_OAUTH_ADS_TOKEN_MISSING');
  }
  version(){const v=String(this.env.META_GRAPH_VERSION||'v26.0');if(!/^v\d+\.\d+$/.test(v))throw Error('META_GRAPH_VERSION_INVALID');return v;}
  async graph(path,token,{params={},method='GET',body={}}={}){
    const u=new URL(`https://graph.facebook.com/${this.version()}/${path}`);
    const appSecret=String(this.env.META_APP_SECRET||'');
    const proof=appSecret?createHmac('sha256',appSecret).update(token).digest('hex'):'';
    if(proof){if(method==='GET')params={...params,appsecret_proof:proof};else body={...body,appsecret_proof:proof};}
    if(method==='GET')for(const [k,v]of Object.entries(params))u.searchParams.set(k,typeof v==='string'?v:JSON.stringify(v));
    const opts={method,headers:{Authorization:'Bearer '+token},redirect:'error',signal:AbortSignal.timeout(20000)};
    if(method!=='GET'){opts.headers['Content-Type']='application/x-www-form-urlencoded';opts.body=new URLSearchParams(body);}
    let r,d;try{r=await this.fetch(u,opts);d=await r.json();}catch{throw Error('META_GRAPH_REQUEST_FAILED');}
    if(!r.ok||d?.error)throw Object.assign(Error('META_GRAPH_'+(d?.error?.code||r.status)),{
      providerCode:d?.error?.code,providerSubcode:d?.error?.error_subcode,
      providerMessage:String(d?.error?.message||'').slice(0,180),
      providerUserMessage:String(d?.error?.error_user_msg||'').slice(0,180),
      providerUserTitle:String(d?.error?.error_user_title||'').slice(0,120),
      fbtraceId:String(d?.error?.fbtrace_id||'').slice(0,80),
    });
    return d;
  }
  async pages(path,token,params){
    const all=[];let after;
    for(let i=0;i<20;i++){
      const d=await this.graph(path,token,{params:{...params,limit:100,...(after?{after}:{})}});
      if(!Array.isArray(d.data))throw Error('META_LIST_INCOMPLETE');all.push(...d.data);
      after=d.paging?.cursors?.after;if(!d.paging?.next) return all;if(!after)throw Error('META_PAGINATION_INCOMPLETE');
    }
    throw Error('META_PAGE_LIMIT_REACHED');
  }
  async archivedCampaignEvidence(token){
    const c=await this.graph(TARGET_CAMPAIGN_ID,token,{params:{fields:'id,name,account_id,status,effective_status'}});
    if(String(c.account_id)!==ACCOUNT_ID.replace(/^act_/,''))throw Error('META_ARCHIVED_CAMPAIGN_ACCOUNT_MISMATCH');
    const account=await this.graph(ACCOUNT_ID,token,{params:{fields:'id,default_dsa_beneficiary,default_dsa_payor'}});
    const sets=await this.pages(`${TARGET_CAMPAIGN_ID}/adsets`,token,{fields:'id,name,status,effective_status,daily_budget,promoted_object,dsa_beneficiary,dsa_payor'});
    const ads=await this.pages(`${TARGET_CAMPAIGN_ID}/ads`,token,{fields:'id,name,status,effective_status,creative{object_story_spec,video_id,object_url}'});
    const pixelIds=[...new Set(sets.map(x=>String(x.promoted_object?.pixel_id||'')).filter(Boolean))];
    const pixels=await this.pages(`${ACCOUNT_ID}/adspixels`,token,{fields:'id,name,is_unavailable'});
    const available=pixels.filter(x=>!x.is_unavailable);
    const pixelActivity=await Promise.all(available.map(async pixel=>{
      try{const details=await this.graph(String(pixel.id),token,{params:{fields:'id,last_fired_time,event_time_max'}});
        return {id:String(pixel.id),lastFiredTime:details.last_fired_time||null,eventTimeMax:details.event_time_max||null};
      }catch(e){return {id:String(pixel.id),activityUnavailable:String(e?.message||'PIXEL_ACTIVITY_UNAVAILABLE'),providerMessage:e?.providerMessage||null};}
    }));
    const recentlyFired=pixelActivity.filter(x=>x.lastFiredTime);
    const pixelId=pixelIds.length===1?pixelIds[0]:pixelIds.length===0&&available.length===1?String(available[0].id):
      pixelIds.length===0&&recentlyFired.length===1?recentlyFired[0].id:null;
    const pixelSource=pixelIds.length===1?'ARCHIVED_CAMPAIGN_ADSET':
      pixelIds.length===0&&available.length===1?'ONLY_AVAILABLE_ACCOUNT_PIXEL':
      pixelIds.length===0&&recentlyFired.length===1?'ONLY_RECENTLY_FIRED_ACCOUNT_PIXEL':null;
    const campaignBeneficiaries=[...new Set(sets.map(x=>String(x.dsa_beneficiary||'').trim()).filter(Boolean))];
    const campaignPayors=[...new Set(sets.map(x=>String(x.dsa_payor||'').trim()).filter(Boolean))];
    const dsaBeneficiary=String(account.default_dsa_beneficiary||'').trim()|| (campaignBeneficiaries.length===1?campaignBeneficiaries[0]:'');
    const dsaPayor=String(account.default_dsa_payor||'').trim()|| (campaignPayors.length===1?campaignPayors[0]:'');
    const evidence={adsetCount:sets.length,adCount:ads.length,pixelCandidates:pixelIds,
      availablePixels:available.map(x=>({id:String(x.id),name:String(x.name||''),isUnavailable:Boolean(x.is_unavailable)})),
      pixelActivity,
      campaignBeneficiaryCandidates:campaignBeneficiaries,campaignPayorCandidates:campaignPayors,
      accountDefaultBeneficiary:String(account.default_dsa_beneficiary||''),accountDefaultPayor:String(account.default_dsa_payor||'')};
    if(!pixelId||!available.some(x=>String(x.id)===pixelId)||!dsaBeneficiary||!dsaPayor){
      throw Object.assign(Error('META_ARCHIVED_CAMPAIGN_PIXEL_OR_DSA_AMBIGUOUS'),{details:evidence});
    }
    return {campaignId:String(c.id),campaignName:String(c.name||''),campaignStatus:String(c.effective_status||c.status||''),pixelId,pixelSource,dsaBeneficiary,dsaPayor,adsetCount:sets.length,adCount:ads.length};
  }
  async accountSnapshot(token){
    const account=await this.graph(ACCOUNT_ID,token,{params:{fields:'id,account_status,currency,timezone_name,disable_reason'}});
    if(String(account.id).replace(/^act_/,'')!==ACCOUNT_ID.slice(4)||Number(account.account_status)!==1||account.disable_reason)throw Error('META_AD_ACCOUNT_NOT_ACTIVE');
    if(String(account.currency).toUpperCase()!=='EUR')throw Error('META_ACCOUNT_CURRENCY_MUST_BE_EUR');
    const campaigns=await this.pages(`${ACCOUNT_ID}/campaigns`,token,{fields:'id,name,status,effective_status,daily_budget,lifetime_budget'});
    let activeDailyBudgetsEur=0;
    for(const c of campaigns){
      if(String(c.effective_status||c.status).toUpperCase()!=='ACTIVE')continue;
      if(c.daily_budget!==undefined&&c.daily_budget!==null){const eur=centsToEur(c.daily_budget);if(eur===null)throw Error('META_ACTIVE_CAMPAIGN_BUDGET_INVALID');activeDailyBudgetsEur+=eur;continue;}
      if(c.lifetime_budget)throw Error('META_ACTIVE_LIFETIME_BUDGET_NOT_SUPPORTED');
      const sets=await this.pages(`${c.id}/adsets`,token,{fields:'id,status,effective_status,daily_budget,lifetime_budget'});
      for(const a of sets){if(String(a.effective_status||a.status).toUpperCase()!=='ACTIVE')continue;if(a.lifetime_budget)throw Error('META_ACTIVE_LIFETIME_BUDGET_NOT_SUPPORTED');const eur=centsToEur(a.daily_budget);if(eur===null)throw Error('META_ACTIVE_ADSET_BUDGET_INVALID');activeDailyBudgetsEur+=eur;}
    }
    const insights=await this.graph(`${ACCOUNT_ID}/insights`,token,{params:{fields:'spend',date_preset:'today',level:'account'}});
    if(!Array.isArray(insights.data))throw Error('META_TODAY_SPEND_UNAVAILABLE');
    const spendTodayEur=insights.data.reduce((sum,row)=>{const n=Number(row.spend);return sum+(Number.isFinite(n)&&n>=0?n:NaN);},0);
    if(!Number.isFinite(spendTodayEur))throw Error('META_TODAY_SPEND_INVALID');
    return {accountId:ACCOUNT_ID,currency:account.currency,timezone:account.timezone_name||null,spendTodayEur,activeDailyBudgetsEur,campaigns};
  }
  async product(){
    if(!this.shopifyGraphQL)throw Error('SHOPIFY_GRAPHQL_UNAVAILABLE');
    const data=await this.shopifyGraphQL('query($query:String!){products(first:1,query:$query){nodes{id title handle description productType status tags seo{title description}media(first:50){nodes{mediaContentType status preview{image{url}} ... on Video{id preview{image{url}} sources{url mimeType format}}}}}}}',{query:`handle:${PRODUCT_HANDLE} status:active`});
    const p=data?.products?.nodes?.[0];if(!p||p.status!=='ACTIVE'||p.handle!==PRODUCT_HANDLE)throw Error('ERAZER_XP6_NOT_ACTIVE');
    const videoMedia=p.media?.nodes?.find(m=>m.mediaContentType==='VIDEO'&&m.status==='READY');
    const video=videoMedia?.sources?.find(s=>s.mimeType==='video/mp4')?.url;
    const thumbnailUrl=videoMedia?.preview?.image?.url;
    if(!video||!/^https:\/\/cdn\.shopify\.com\//.test(video))throw Error('ERAZER_XP6_EXISTING_SHOPIFY_VIDEO_MISSING');
    if(!thumbnailUrl||!/^https:\/\/cdn\.shopify\.com\//.test(thumbnailUrl))throw Error('ERAZER_XP6_SHOPIFY_VIDEO_THUMBNAIL_MISSING');
    return {...p,videoUrl:video,thumbnailUrl,productUrl:PRODUCT_URL};
  }
  async syncSeo(trends){
    if(!this.shopifyGraphQL)throw Error('SHOPIFY_GRAPHQL_UNAVAILABLE');
    const {GoogleTrends}=await import('../homestro-marketing-pilot/modules/trends.js');
    const service=trends||new GoogleTrends({fetchImpl:this.fetch,geos:['DE','AT']});
    const updated=[];let altTextsUpdated=0,trendsMatchedProducts=0,after=null;
    do{
      const d=await this.shopifyGraphQL('query($after:String){products(first:50,after:$after,query:"status:active"){nodes{id title handle description productType tags seo{title description} media(first:100){nodes{id alt mediaContentType}}}pageInfo{hasNextPage endCursor}}}',{after});
      const page=d?.products;if(!page||!Array.isArray(page.nodes))throw Error('SHOPIFY_ACTIVE_PRODUCTS_UNAVAILABLE');
      for(const p of page.nodes){
        const current={title:p.seo?.title||p.title,searchTitle:p.title,seoTitle:p.seo?.title||p.title,seoDescription:p.seo?.description||p.description||'',description:p.description||''};
        const result=await service.optimize(p,current);
        const matched=Boolean(result?.matchedQuery);
        const plainDescription=String(p.description||'').replace(/<[^>]*>/g,' ').replace(/\s+/g,' ').trim();
        const seoTitle=String((matched&&result.copy?.seoTitle)||p.seo?.title||p.title||'').slice(0,70);
        const seoDescription=String((matched&&result.copy?.seoDescription)||p.seo?.description||plainDescription||p.title||'').slice(0,320);
        const tag=matched?'trend:'+String(result.matchedQuery).trim().slice(0,80):null;
        const tags=[...new Set([...(p.tags||[]),...(tag?[tag]:[])])].slice(0,250);
        const seoChanged=seoTitle!==String(p.seo?.title||'')||seoDescription!==String(p.seo?.description||'')||(tag&&!(p.tags||[]).includes(tag));
        let didUpdate=false;
        if(seoChanged){
          const res=await this.shopifyGraphQL('mutation($product:ProductUpdateInput!){productUpdate(product:$product){product{id}userErrors{field message}}}',{product:{id:p.id,seo:{title:seoTitle,description:seoDescription},tags}});
          const errs=res?.productUpdate?.userErrors||[];
          if(errs.length){const error=Error('SHOPIFY_SEO_UPDATE_REJECTED');error.externalWritesPerformed=updated.length>0;error.result={status:'partial',activeProductsOptimized:updated.length,altTextsUpdated,updated};throw error;}
          didUpdate=true;if(matched)trendsMatchedProducts++;
        }
        const missingAlt=(p.media?.nodes||[]).filter(media=>media.mediaContentType==='IMAGE'&&!String(media.alt||'').trim()).map(media=>({id:media.id,alt:String(p.title||'Homestro Produkt').slice(0,250)}));
        if(missingAlt.length){
          const res=await this.shopifyGraphQL('mutation($productId:ID!,$media:[UpdateMediaInput!]!){productUpdateMedia(productId:$productId,media:$media){mediaUserErrors{field message}}}',{productId:p.id,media:missingAlt});
          const errs=res?.productUpdateMedia?.mediaUserErrors||[];
          if(errs.length)this.logger.warn?.('[jarvis-autopilot] SHOPIFY_ALT_TEXT_UPDATE_REJECTED '+JSON.stringify({productId:p.id,count:errs.length,errors:errs.slice(0,3)}));
          else{altTextsUpdated+=missingAlt.length;didUpdate=true;}
        }
        if(didUpdate)updated.push({id:p.id,handle:p.handle,trend:matched?String(result.matchedQuery):null,altTextsUpdated:missingAlt.length});
        await pause(150);
      }
      if(!page.pageInfo?.hasNextPage)break;after=page.pageInfo.endCursor;if(!after){const error=Error('SHOPIFY_PAGINATION_INCOMPLETE');error.externalWritesPerformed=updated.length>0;error.result={status:'partial',activeProductsOptimized:updated.length,altTextsUpdated,updated};throw error;}
    }while(true);
    return {status:'completed',activeProductsOptimized:updated.length,altTextsUpdated,trendsMatchedProducts,updated};
  }
  async activeProductsForOrganic(){
    if(!this.shopifyGraphQL)throw Error('SHOPIFY_GRAPHQL_UNAVAILABLE');
    const data=await this.shopifyGraphQL('query{products(first:250,query:"status:active"){nodes{title handle productType}}}');
    const nodes=data?.products?.nodes;
    if(!Array.isArray(nodes))throw Error('SHOPIFY_ACTIVE_PRODUCTS_UNAVAILABLE');
    return nodes.filter(p=>p?.title&&p?.handle).sort((a,b)=>(a.handle===PRODUCT_HANDLE?-1:0)-(b.handle===PRODUCT_HANDLE?-1:0));
  }
  async campaignExists(token){
    const rows=await this.pages(`${ACCOUNT_ID}/campaigns`,token,{fields:'id,name,account_id,objective,status,effective_status'});
    return rows.find(c=>c.name===CAMPAIGN_NAME)||null;
  }
  async write(path,token,body){const r=await this.graph(path,token,{method:'POST',body});if(!r.id)throw Error('META_WRITE_ID_MISSING');return String(r.id);}
  async pauseCreated(token,ids){for(const id of [ids.adId,ids.adsetId,ids.campaignId].filter(Boolean)){try{await this.graph(id,token,{method:'POST',body:{status:'PAUSED'}});}catch{}}}
  async createCampaign(token,p,asset,snapshot,evidence){
    const existing=await this.campaignExists(token);let reuseExisting=false,reuseAdset=false,existingAdset=null;
    if(existing){
      const status=String(existing.effective_status||existing.status||'').toUpperCase();
      if(status==='ACTIVE')return {status:'existing_campaign',campaignId:String(existing.id),effectiveStatus:status,externalWritesPerformed:false};
      if(status!=='PAUSED'||String(existing.account_id)!==ACCOUNT_ID.slice(4)||
          String(this.env.META_AUTOPILOT_CAMPAIGN_ID||'')!==String(existing.id))
        return {status:'blocked',reason:'CAMPAIGN_NAME_ALREADY_EXISTS_NOT_OWNED_PAUSED',campaignId:String(existing.id),effectiveStatus:status,externalWritesPerformed:false};
      const [sets,ads]=await Promise.all([
        this.pages(`${existing.id}/adsets`,token,{fields:'id,campaign_id,status,effective_status,daily_budget,targeting,promoted_object,dsa_beneficiary,dsa_payor'}),
        this.pages(`${existing.id}/ads`,token,{fields:'id,status,effective_status'}),
      ]);
      if(ads.length)return {status:'blocked',reason:'OWNED_CAMPAIGN_PARTIAL_ADS_REQUIRE_REVIEW',campaignId:String(existing.id),adsetCount:sets.length,adCount:ads.length,externalWritesPerformed:false};
      if(sets.length){
        const candidate=sets.length===1?sets[0]:null;
        const targeting=candidate?.targeting||{};
        const countries=targeting.geo_locations?.countries||[];
        const approved=candidate&&String(candidate.id)===String(this.env.META_AUTOPILOT_ADSET_ID||'')&&
          String(candidate.campaign_id)===String(existing.id)&&String(candidate.status).toUpperCase()==='PAUSED'&&
          Number(candidate.daily_budget)===START_BUDGET_EUR*100&&Number(targeting.age_min)===20&&Number(targeting.age_max)===60&&
          ['DE','AT'].every(country=>countries.includes(country))&&
          String(candidate.promoted_object?.pixel_id||'')===evidence.pixelId&&
          String(candidate.dsa_beneficiary||'')===evidence.dsaBeneficiary&&
          String(candidate.dsa_payor||'')===evidence.dsaPayor;
        if(!approved)return {status:'blocked',reason:'OWNED_CAMPAIGN_PARTIAL_OBJECTS_REQUIRE_REVIEW',campaignId:String(existing.id),adsetCount:sets.length,adCount:ads.length,externalWritesPerformed:false};
        existingAdset=candidate;reuseAdset=true;
      }
      const videoId=String(this.env.META_AUTOPILOT_VIDEO_ID||'');
      if(!/^\d+$/.test(videoId))return {status:'blocked',reason:'OWNED_CAMPAIGN_VIDEO_ASSET_ID_MISSING',campaignId:String(existing.id),externalWritesPerformed:false};
      const video=await this.graph(videoId,token,{params:{fields:'id'}});
      if(String(video.id)!==videoId)return {status:'blocked',reason:'OWNED_CAMPAIGN_VIDEO_ASSET_UNAVAILABLE',campaignId:String(existing.id),externalWritesPerformed:false};
      reuseExisting=true;
    }
    const gate=accountBudgetDecision({...snapshot,proposedDailyBudgetEur:START_BUDGET_EUR});if(!gate.allowed)return {status:'blocked',reason:gate.reason,budgetGuard:gate};
    const ids={};
    try{
      ids.campaignId=reuseExisting?String(existing.id):await this.write(`${ACCOUNT_ID}/campaigns`,token,{name:CAMPAIGN_NAME,objective:'OUTCOME_SALES',status:'PAUSED',special_ad_categories:'[]',is_adset_budget_sharing_enabled:'false'});
      ids.videoId=reuseExisting?String(this.env.META_AUTOPILOT_VIDEO_ID):await this.write(`${ACCOUNT_ID}/advideos`,token,{file_url:p.videoUrl,name:'Erazer XP6 Shopify CDN video'});
      ids.adsetId=reuseAdset?String(existingAdset.id):await this.write(`${ACCOUNT_ID}/adsets`,token,{name:'Erazer XP6 Broad DE AT',campaign_id:ids.campaignId,daily_budget:String(START_BUDGET_EUR*100),billing_event:'IMPRESSIONS',optimization_goal:'OFFSITE_CONVERSIONS',bid_strategy:'LOWEST_COST_WITHOUT_CAP',promoted_object:JSON.stringify({pixel_id:evidence.pixelId,custom_event_type:'PURCHASE'}),dsa_beneficiary:evidence.dsaBeneficiary,dsa_payor:evidence.dsaPayor,targeting:JSON.stringify({geo_locations:{countries:['DE','AT']},age_min:20,age_max:60,publisher_platforms:['facebook','instagram'],targeting_automation:{advantage_audience:0}}),status:'PAUSED'});
      const spec={page_id:String(this.env.META_PAGE_ID||''),video_data:{video_id:ids.videoId,image_url:p.thumbnailUrl,message:AD_COPY,title:'Ein Stück Zuhausegefühl – Erazer XP6',link_description:'Entdecke die Erazer XP6 bei Homestro.',call_to_action:{type:'SHOP_NOW',value:{link:PRODUCT_URL}}}};
      if(!/^\d+$/.test(spec.page_id))throw Error('META_PAGE_ID_INVALID');
      const creative=await this.write(`${ACCOUNT_ID}/adcreatives`,token,{name:'Erazer XP6 – Zuhausegefühl',object_story_spec:JSON.stringify(spec)});
      ids.adId=await this.write(`${ACCOUNT_ID}/ads`,token,{name:'Erazer XP6 – Musik unterwegs',adset_id:ids.adsetId,creative:JSON.stringify({creative_id:creative}),status:'PAUSED'});
      const fresh=await this.accountSnapshot(token);const finalGate=accountBudgetDecision({...fresh,proposedDailyBudgetEur:START_BUDGET_EUR});if(!finalGate.allowed)throw Error(finalGate.reason);
      for(const id of [ids.adsetId,ids.adId,ids.campaignId])await this.graph(id,token,{method:'POST',body:{status:'ACTIVE'}});
      return {status:'ACTIVE',campaignId:ids.campaignId,adsetId:ids.adsetId,adId:ids.adId,dailyBudgetEur:START_BUDGET_EUR,targeting:{countries:['DE','AT'],ageMin:20,ageMax:60},creativeSource:'existing_shopify_cdn_video',videoGenerated:false,budgetGuard:finalGate,externalWritesPerformed:true};
    }catch(e){await this.pauseCreated(token,ids);return {status:'blocked',reason:String(e.message||'META_CAMPAIGN_CREATE_FAILED').slice(0,100),providerCode:e.providerCode||null,providerSubcode:e.providerSubcode||null,providerMessage:String(e.providerMessage||'').slice(0,300)||null,providerUserMessage:String(e.providerUserMessage||'').slice(0,300)||null,providerUserTitle:String(e.providerUserTitle||'').slice(0,200)||null,fbtraceId:e.fbtraceId||null,createdIds:ids,externalWritesPerformed:Object.values(ids).some(Boolean)};}
  }
  async pauseAllActiveCampaigns(){
    const token=await this.token();
    const account=await this.graph(ACCOUNT_ID,token,{params:{fields:'id,account_status,disable_reason'}});
    const before=await this.pages(`${ACCOUNT_ID}/campaigns`,token,{fields:'id,name,status,effective_status,daily_budget'});
    const active=before.filter(c=>String(c.status||'').toUpperCase()==='ACTIVE'||String(c.effective_status||'').toUpperCase()==='ACTIVE');
    if(Number(account.account_status)!==1){
      const result={accountId:ACCOUNT_ID,accountStatus:Number(account.account_status),disableReason:account.disable_reason||null,activeCampaigns:active.map(c=>({id:String(c.id),name:String(c.name||''),status:String(c.status||''),effectiveStatus:String(c.effective_status||''),dailyBudget:String(c.daily_budget||'')})),paused:[],pauseBlocked:'META_AD_ACCOUNT_STATUS_BLOCKS_WRITES',zeroSpendLock:active.length===0};
      this.logger.error?.('[jarvis-autopilot] PAID_ADS_ZERO_SPEND_LOCK_STATUS '+JSON.stringify(result));
      return result;
    }
    const ownedId=String(this.env.META_AUTOPILOT_CAMPAIGN_ID||'');
    active.sort((a,b)=>(String(b.id)===ownedId?1:0)-(String(a.id)===ownedId?1:0));
    const paused=[],failed=[];
    for(const campaign of active){
      try{await this.graph(String(campaign.id),token,{method:'POST',body:{status:'PAUSED'}});paused.push(String(campaign.id));}
      catch(error){failed.push({id:String(campaign.id),code:error?.providerCode||null,subcode:error?.providerSubcode||null,message:String(error?.providerMessage||error?.message||'META_PAUSE_FAILED').slice(0,180),userMessage:String(error?.providerUserMessage||'').slice(0,180)});}
    }
    const after=await this.pages(`${ACCOUNT_ID}/campaigns`,token,{fields:'id,name,status,effective_status'});
    const stillActive=after.filter(c=>String(c.status||'').toUpperCase()==='ACTIVE'||String(c.effective_status||'').toUpperCase()==='ACTIVE').map(c=>({id:String(c.id),name:String(c.name||''),status:String(c.status||''),effectiveStatus:String(c.effective_status||'')}));
    const result={accountId:ACCOUNT_ID,accountStatus:Number(account.account_status),disableReason:account.disable_reason||null,activeBefore:active.map(c=>String(c.id)),paused,failed,activeAfter:stillActive,zeroSpendLock:stillActive.length===0};
    this.logger.info?.('[jarvis-autopilot] PAID_ADS_ZERO_SPEND_LOCK_STATUS '+JSON.stringify(result));
    return result;
  }
  async inspect(){
    const token=await this.token();
    const [evidence,snapshot,product]=await Promise.all([this.archivedCampaignEvidence(token),this.accountSnapshot(token),this.product()]);
    const guard=accountBudgetDecision(snapshot);
    return {evidence,snapshot:{accountId:snapshot.accountId,currency:snapshot.currency,timezone:snapshot.timezone,spendTodayEur:snapshot.spendTodayEur,activeDailyBudgetsEur:snapshot.activeDailyBudgetsEur,activeCampaignCount:snapshot.campaigns.filter(x=>String(x.effective_status||x.status).toUpperCase()==='ACTIVE').length},product:{id:product.id,handle:product.handle,videoUrl:product.videoUrl},guard};
  }
  async preflight(){const token=await this.token();const [evidence,snapshot,product]=await Promise.all([this.archivedCampaignEvidence(token),this.accountSnapshot(token),this.product()]);const result={status:'checked',evidence,snapshot:{accountId:snapshot.accountId,currency:snapshot.currency,timezone:snapshot.timezone,spendTodayEur:snapshot.spendTodayEur,activeDailyBudgetsEur:snapshot.activeDailyBudgetsEur,activeCampaignCount:snapshot.campaigns.filter(x=>String(x.effective_status||x.status).toUpperCase()==='ACTIVE').length},product:{id:product.id,handle:product.handle,videoUrl:product.videoUrl},budgetGuard:accountBudgetDecision(snapshot)};this.logger.info?.('[jarvis-autopilot] META_READ_ONLY_PREFLIGHT '+JSON.stringify(result));return result;}
  async runLiveCycle(){
    if(String(this.env.PAID_ADS_ENABLED||'').toLowerCase()!=='true'||DAILY_CAP_EUR<=0)return {status:'blocked',reason:'PAID_ADS_ZERO_SPEND_LOCK',dryRun:false,externalWritesPerformed:false,adSpendEUR:0,capEur:DAILY_CAP_EUR};
    if(String(this.env.AUTONOMOUS_LIVE_MODE||'').toLowerCase()!=='true')return {status:'blocked',reason:'AUTONOMOUS_LIVE_MODE_DISABLED',dryRun:true};
    if(this.env.META_AD_ACCOUNT_ID!==ACCOUNT_ID)return {status:'blocked',reason:'META_AD_ACCOUNT_ID_MISMATCH',dryRun:true};
    const token=await this.token();const [evidence,snapshot,product]=await Promise.all([this.archivedCampaignEvidence(token),this.accountSnapshot(token),this.product()]);
    for(const [key,value] of [['META_PIXEL_ID',evidence.pixelId],['META_DSA_BENEFICIARY',evidence.dsaBeneficiary],['META_DSA_PAYOR',evidence.dsaPayor]]){
      if(String(this.env[key]||'').trim()!==value)return {status:'blocked',reason:key+'_MISSING_OR_MISMATCH',dryRun:true,externalWritesPerformed:false};
    }
    const budgetGuard=accountBudgetDecision(snapshot);
    if(!budgetGuard.allowed)return {status:'blocked',reason:budgetGuard.reason,budgetGuard,dryRun:false,externalWritesPerformed:false};
    let seo=null,campaign=null;
    try{seo=await this.syncSeo();}catch(e){return {status:'blocked',reason:String(e.message||'SHOPIFY_SEO_SYNC_FAILED').slice(0,100),dryRun:false,externalWritesPerformed:Boolean(e.externalWritesPerformed),adSpendEUR:0,seo:e.result||null,videoGenerationPerformed:false,handwerkIsolated:true};}
    campaign=await this.createCampaign(token,product,null,snapshot,evidence);
    const externalWritesPerformed=Boolean(seo.activeProductsOptimized||campaign.externalWritesPerformed);
    return {status:campaign.status==='ACTIVE'||campaign.status==='existing_campaign'?'completed':'blocked',dryRun:false,externalWritesPerformed,adSpendEUR:0,meta:{accountId:ACCOUNT_ID,spendTodayEur:snapshot.spendTodayEur,activeDailyBudgetsEur:snapshot.activeDailyBudgetsEur,budgetGuard},seo,campaign,videoGenerationPerformed:false,handwerkIsolated:true};
  }
}

module.exports={ACCOUNT_ID,TARGET_CAMPAIGN_ID,DAILY_CAP_EUR,START_BUDGET_EUR,CAMPAIGN_NAME,AD_COPY,accountBudgetDecision,LiveMetaExecutor};
