import test from 'node:test';
import assert from 'node:assert/strict';
import {checkStorefrontTracking} from '../modules/site-tracking-check.js';

test('own-store runtime pixel configuration is observed while all Meta beacons are suppressed',async()=>{
 let intercept,aborted=0,closed=0,continued=0;
 const page={route:async(_,fn)=>{intercept=fn;},getByRole:()=>({first:()=>({click:async()=>{}})}),
  goto:async()=>{
   const req={url:()=> 'https://www.facebook.com/tr/?id=432750866484297&ev=PageView',resourceType:()=> 'image'};
   await intercept({request:()=>req,abort:async()=>{aborted++;},continue:async()=>{continued++;}});
   await intercept({request:()=>({url:()=> 'http://127.0.0.1/private',resourceType:()=> 'fetch'}),abort:async()=>{aborted++;}});
   return {status:()=>200};
  }};
 const browser={newContext:async options=>{assert.equal(options.serviceWorkers,'block');return {newPage:async()=>page,close:async()=>{closed++;}};},close:async()=>{closed++;}};
 const proof=await checkStorefrontTracking({url:'https://homestro.de/products/box',expectedPixelId:'432750866484297',launch:async()=>browser});
 assert.equal(proof.configured,true);assert.equal(proof.pixelBeaconsSuppressed,true);assert.equal(proof.purchaseEventDelivered,false);
 assert.equal(continued,0);assert.equal(aborted,2);assert.equal(closed,2);
});
test('tracking probe refuses foreign/private hosts and invalid IDs before browser launch',async()=>{
 for(const [url,id] of [['https://evil.example/products/box','12345'],['http://homestro.de/products/box','12345'],['https://homestro.de/products/box','bad']]){
  await assert.rejects(()=>checkStorefrontTracking({url,expectedPixelId:id,launch:async()=>assert.fail('must not launch')}),{code:'TRACKING_CHECK_SOURCE_INVALID'});
 }
});
