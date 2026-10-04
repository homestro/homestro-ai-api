'use strict';
const MAX=200;
const drafts=[];
function key(d){return `${d.productId}:${d.channel}`;}
function queueDraft(draft){const k=key(draft);const old=drafts.find(x=>key(x)===k&&['draft_queued','approved'].includes(x.status));if(old)return old;const row={...draft,id:`organic_${Date.now()}_${drafts.length+1}`,status:'draft_queued',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};drafts.unshift(row);if(drafts.length>MAX)drafts.length=MAX;return row;}
function listDrafts(){return drafts.map(x=>({...x}));}
function approveDraft(id){const x=drafts.find(d=>d.id===id);if(!x)return null;if(x.status!=='draft_queued')throw Error('Only draft_queued posts can be approved');x.status='approved';x.updatedAt=new Date().toISOString();return {...x};}
function markPublished(id,result){const x=drafts.find(d=>d.id===id);if(!x)return null;x.status='published';x.published=true;x.metaId=result.id;x.updatedAt=new Date().toISOString();return {...x};}
module.exports={queueDraft,listDrafts,approveDraft,markPublished};
