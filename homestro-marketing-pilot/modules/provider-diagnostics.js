// Only bounded enums and known field paths leave the provider response.
// Provider text is used for a display category, never retry decisions.
const TYPES=new Set(['invalid_request_error','authentication_error','permission_error','not_found','rate_limit_error','platform_error','api_error']);
const CODES=new Set(['missing_required_field','invalid_field_value','invalid_parameter','invalid_field','invalid_request','platform_api_error','PLATFORM_LIMITATION','idempotency_conflict','duplicate_content','missing_tiktok_permissions','temporarily_unavailable']);
export function providerDiagnostics(data={}) {
  const messages=[];const visit=(v,depth=0)=>{
    if(depth>4||messages.length>=32)return;
    if(typeof v==='string'){messages.push(v.slice(0,1000));return;}
    if(Array.isArray(v)){for(const x of v.slice(0,10))visit(x,depth+1);return;}
    if(v&&typeof v==='object')for(const k of ['error','message','msg','detail','details','errors','issues','platformError'])visit(v[k],depth+1);
  };visit(data);
  const raw=messages.join(' ').slice(0,8000);
  const vocabulary=new Set(('invalid missing required unsupported rejected failed failure photo video image media type title caption description content field parameter settings commercial brand organic disclosure music sound business account profile permission scope consent preview confirm format size length width height download url domain ownership duplicate quota limit capacity upload disabled enabled true false connection reconnect validation publish posting scheduledFor privacy_level allow_comment allow_duet allow_stitch content_preview_confirmed express_consent_given commercialContentType is_brand_organic_post media_type photo_cover_index').split(' '));
  const words=[...new Set((raw.match(/[A-Za-z_]+/g)||[]).filter(w=>vocabulary.has(w)||vocabulary.has(w.toLowerCase())).map(w=>w.toLowerCase()))].slice(0,40);
  const categories=[
    ['DIRECT_POST_CAPACITY',/direct posting.*capacity|active user.*quota|reached_active_user_cap/i],
    ['DAILY_POST_CAP',/too many posts|daily.*(?:post|limit)|posting.*cap/i],
    ['PERMISSION_REQUIRED',/missing.*permission|scope.*(?:missing|authoriz)|reconnect/i],
    ['MEDIA_DOWNLOAD',/download.*fail|url.*(?:error|invalid)|could not.*download/i],
    ['URL_OWNERSHIP',/ownership|verified.*domain|domain.*verif/i],
    ['DUPLICATE_CONTENT',/duplicate.*content|exact content.*already/i],
    ['COMMERCIAL_MUSIC',/music|sound.*(?:invalid|unavailable)|commercial.*(?:not.*support|reject)/i],
    ['PRIVACY_LEVEL',/privacy.*(?:level|available)/i],
    ['CONTENT_MODERATION',/spam_risk|potentially risky|moderation/i],
    ['CONSENT_REQUIRED',/preview|express.?consent/i],
    ['COMMERCIAL_DISCLOSURE',/commercial|brand.?organic|is_brand_organic/i],
    ['MEDIA_VALIDATION',/photo|image|video|media/i],
    ['ACCOUNT_VALIDATION',/profile|account/i]
  ];
  const param=typeof data.param==='string'&&data.param.length<=160&&
    /^(?:content|mediaItems|tiktokSettings|platforms|publishNow|metadata)(?:[.[\]A-Za-z0-9_]+)?$/.test(data.param)?data.param:null;
  const upstream=data.platformError?.code;
  return {type:TYPES.has(data.type)?data.type:'unclassified',providerCode:CODES.has(data.code)?data.code:'unclassified',param,
    category:categories.find(([,re])=>re.test(raw))?.[0]||'UNCLASSIFIED',words,
    upstreamCode:typeof upstream==='number'&&Number.isSafeInteger(upstream)?upstream:null};
}
