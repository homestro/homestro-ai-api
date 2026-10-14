// Only bounded enums and known field paths leave the provider response.
// Provider text is used for a display category, never retry decisions.
const TYPES=new Set(['invalid_request_error','authentication_error','permission_error','not_found','rate_limit_error','platform_error','api_error']);
const CODES=new Set(['missing_required_field','invalid_field_value','invalid_parameter','invalid_field','invalid_request','platform_api_error','PLATFORM_LIMITATION','idempotency_conflict','duplicate_content','missing_tiktok_permissions','temporarily_unavailable']);
export function providerDiagnostics(data={}) {
  const raw=[data.error,data.message,data.platformError?.message].filter(v=>typeof v==='string').join(' ').slice(0,4000);
  const categories=[
    ['DIRECT_POST_CAPACITY',/direct posting.*capacity|active user.*quota|reached_active_user_cap/i],
    ['DAILY_POST_CAP',/too many posts|daily.*(?:post|limit)|posting.*cap/i],
    ['PERMISSION_REQUIRED',/missing.*permission|scope.*(?:missing|authoriz)|reconnect/i],
    ['MEDIA_DOWNLOAD',/download.*fail|url.*(?:error|invalid)|could not.*download/i],
    ['URL_OWNERSHIP',/ownership|verified.*domain|domain.*verif/i],
    ['DUPLICATE_CONTENT',/duplicate.*content|exact content.*already/i],
    ['COMMERCIAL_MUSIC',/music|sound.*(?:invalid|unavailable)|commercial.*(?:not.*support|reject)/i],
    ['PRIVACY_LEVEL',/privacy.*(?:level|available)/i],
    ['CONTENT_MODERATION',/spam_risk|potentially risky|moderation/i]
  ];
  const param=typeof data.param==='string'&&data.param.length<=160&&
    /^(?:content|mediaItems|tiktokSettings|platforms|publishNow|metadata)(?:[.[\]A-Za-z0-9_]+)?$/.test(data.param)?data.param:null;
  const upstream=data.platformError?.code;
  return {type:TYPES.has(data.type)?data.type:'unclassified',providerCode:CODES.has(data.code)?data.code:'unclassified',param,
    category:categories.find(([,re])=>re.test(raw))?.[0]||'UNCLASSIFIED',
    upstreamCode:typeof upstream==='number'&&Number.isSafeInteger(upstream)?upstream:null};
}
