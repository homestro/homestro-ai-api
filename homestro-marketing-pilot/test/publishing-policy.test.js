import test from 'node:test';
import assert from 'node:assert/strict';
import {config} from '../modules/core.js';
import {channelPolicy,repeatedMedia} from '../modules/publishing-policy.js';
import {Worker} from '../modules/worker.js';

test('balanced policy overrides prior overnight six-post Meta configuration',()=>{
  const cfg=config({PILOT_ORGANIC_POLICY:'balanced-v1',PILOT_PUBLISH_AROUND_CLOCK:'true',
    PILOT_PUBLISH_EVERY_HOURS:'4',PILOT_MAX_DAILY_POSTS:'12',PILOT_MAX_DAILY_PER_CHANNEL:'6'});
  assert.equal(cfg.publishAroundClock,false);assert.equal(cfg.maxDailyPosts,4);assert.equal(cfg.maxDailyPerChannel,2);
  assert.deepEqual(channelPolicy(cfg,'instagram'),{hours:8,daily:2,aroundClock:false});
  assert.deepEqual(channelPolicy(cfg,'tiktok'),{hours:4,daily:4,aroundClock:false});
  assert.throws(()=>config({PILOT_ORGANIC_POLICY:'typo'}),{code:'INVALID_ORGANIC_POLICY'});
});
test('media deduplication compares sorted exact media on the same channel, excludes itself, and skips empty assets',async()=>{
  const calls=[],client={query:async(sql,args)=>{calls.push({sql,args});return {rows:[{id:'other'}]};}};
  const cfg={organicPolicy:'balanced-v1'},job={id:'j',channel:'facebook',payload:{imageURLs:['b','a','b']}};
  assert.equal(await repeatedMedia(client,'marketing_posts',job,cfg),true);
  assert.deepEqual(calls[0].args,['facebook','j','',['a','b']]);
  assert.match(calls[0].sql,/channel=\$1 AND id<>\$2/);
  assert.equal(await repeatedMedia(client,'marketing_posts',{...job,payload:{}},cfg),false);
  assert.equal(calls.length,1);
});
test('balanced Meta checks daily channel cap for explicit IDs and rejects media duplicates before remote preflight',async()=>{
  for(const capped of [true,false]){
    let writes=0,preflight=0;const statuses=[];
    const job={id:'j',channel:'instagram',product_id:'p',payload:{imageURLs:['a'],productRevision:'rev'}};
    const client={query:async sql=>{
      if(sql.includes('AS channel_used'))return {rows:[{channel_used:capped?2:0}]};
      if(sql.includes('AS recent'))return {rows:[{recent:0}]};
      if(sql.includes("interval '30 days'"))return {rows:[{id:'other'}]};
      if(sql.includes('count(*)'))return {rows:[{count:0}]};
      return {rows:[job]};
    }};
    const w=new Worker({cfg:{workerEnabled:true,publishingEnabled:true,autonomyEnabled:true,
      organicPolicy:'balanced-v1',maxDailyPosts:4,maxDailyPerChannel:2,publishEveryHours:8},
      store:{withWorkerLock:fn=>fn(client),setStatus:async(_,s)=>statuses.push(s)},
      meta:{verifyConnection:async()=>{preflight++;},publish:async()=>{writes++;}},isPublishingWindow:()=>true});
    await w.tick('j');assert.equal(writes,0);assert.equal(preflight,0);
    assert.deepEqual(statuses,capped?[]:['superseded']);
  }
});
