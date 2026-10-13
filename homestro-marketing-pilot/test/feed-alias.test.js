import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const {registerGoogleOrganicFeed}=createRequire(import.meta.url)('../../google-organic-feed.js');
function response(){return {code:200,headers:{},set(k,v){this.headers[k]=v;return this;},type(v){this.mime=v;return this;},status(v){this.code=v;return this;},send(v){this.body=v;return this;}};}
test('existing Merchant URL serves fresh reviewed Pilot feed without legacy catalog query',async()=>{
 let handler;registerGoogleOrganicFeed({get:(path,h)=>{assert.equal(path,'/feeds/google-organic.xml');handler=h;}},()=>{throw Error('legacy must not run');},{env:{PILOT_FEED_LEGACY_ALIAS:'true'},getPilotFeed:async()=>'<rss>verified</rss>'});
 const res=response();await handler({},res);assert.equal(res.body,'<rss>verified</rss>');assert.equal(res.headers['Cache-Control'],'no-store');assert.equal(res.code,200);
});
test('unavailable Pilot feed fails closed without returning old legacy prices',async()=>{
 let handler,legacy=0;registerGoogleOrganicFeed({get:(_,h)=>{handler=h;}},()=>{legacy++;},{env:{PILOT_FEED_LEGACY_ALIAS:'true'},getPilotFeed:async()=>{throw Error('offline');}});
 const res=response();await handler({},res);assert.equal(res.code,502);assert.equal(legacy,0);assert.equal(res.body,'Feed generation failed');
});
