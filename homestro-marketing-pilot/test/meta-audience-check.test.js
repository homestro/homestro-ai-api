import test from 'node:test';
import assert from 'node:assert/strict';
import {PilotError} from '../modules/core.js';
import {checkMetaOrganicAudience} from '../modules/meta-audience-check.js';
test('audience check uses existing native IDs and preserves missing metrics as null',async()=>{
 const ids=[];const meta={request:async(id,opts)=>{ids.push(id);assert.equal(opts.method,undefined);return id==='page'?{followers_count:0}:id==='ig'?{followers_count:3,media_count:51}:id==='1_2'?{is_published:true,reactions:{summary:{total_count:1}}}:{like_count:0,comments_count:0};}};
 const reports=await checkMetaOrganicAudience(meta,{query:async(sql,args)=>({rows:[{remote:{postId:args[0]==='facebook'?'1_2':'123'}}]})},{pageId:'page',instagramId:'ig'});
 assert.deepEqual(ids,['page','1_2','ig','123']);assert.equal(reports[0].account.followers,0);
 assert.equal(reports[0].post.reactions,1);assert.equal(reports[0].post.comments,null);assert.equal(reports[1].post.likes,0);
 assert.equal(reports[1].post.reach,null);assert.equal(reports[1].restrictionStatus,'not_checked');
});
test('permission failures do not become zero followers or zero reach',async()=>{
 const reports=await checkMetaOrganicAudience({request:async()=>{throw new PilotError('META_REQUEST_FAILED');}},{query:async()=>({rows:[{remote:{postId:'123'}}]})},{pageId:'1',instagramId:'2'});
 assert.ok(reports.every(r=>r.account.unavailable==='META_REQUEST_FAILED'&&r.post.reach===null&&r.missingMetricsAreZero===false));
});
