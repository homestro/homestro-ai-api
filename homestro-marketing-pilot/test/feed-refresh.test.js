import test from 'node:test';
import assert from 'node:assert/strict';
import {createFeedRefresh} from '../modules/feed-refresh.js';

const product=(id,price=20)=>({id,revision:'r1',status:'ACTIVE',currency:'EUR',url:'https://homestro.de/products/'+id,localized:{searchTitle:id,description:'Beschreibung'},contentReviewed:true,priceReviewed:true,media:[{mediaContentType:'IMAGE',status:'READY',image:{url:'https://cdn.shopify.com/photo.jpg'}}],variants:[{id:'gid://shopify/ProductVariant/'+id,price,available:true}],condition:'new'});
test('feed refresh shares concurrent requests, limits read concurrency, and includes more than 50 offers',async()=>{
 const sources=Array.from({length:80},(_,i)=>product(String(i+1)));let active=0,maximum=0,calls=0;
 const refresh=createFeedRefresh({store:{seoRows:async()=>sources},cfg:{feedEnabled:true,feedCap:5000,shipping:[]},fresh:async id=>{calls++;active++;maximum=Math.max(maximum,active);await new Promise(r=>setImmediate(r));active--;return sources.find(p=>p.id===id);},processProduct:async()=>{throw Error('unexpected');}});
 const [a,b]=await Promise.all([refresh(),refresh()]);assert.equal(a,b);assert.equal(calls,80);assert.equal(maximum,3);assert.equal((a.match(/<item>/g)||[]).length,80);
 await refresh();assert.equal(calls,160); // Completed feeds are never used as an indefinite cache.
});
test('failed freshness omits the product and live prices update without rendering',async()=>{
 const sources=[product('1'),product('2'),product('3')];
 const refresh=createFeedRefresh({store:{seoRows:async()=>sources},cfg:{feedEnabled:true,feedCap:5000,shipping:[]},fresh:async id=>{if(id==='1')throw Error('unavailable');return {...product(id,id==='2'?24:20),revision:id==='2'?'r2':'r1'};}});
 const xml=await refresh();assert.equal((xml.match(/<item>/g)||[]).length,2);assert.match(xml,/<g:price>24\.00 EUR/);assert.doesNotMatch(xml,/<g:id>gid:\/\/shopify\/ProductVariant\/1<\/g:id>/);
});
test('changed product copy, rejected products, and invalid shop URLs never use old reviewed feed text',async()=>{
 const sources=[product('1'),product('2'),product('3')];
 const refresh=createFeedRefresh({store:{seoRows:async()=>sources},cfg:{feedEnabled:true,feedCap:5000,shipping:[]},fresh:async id=>({...product(id),revision:'changed',...(id==='1'?{description:'Changed specifications'}:id==='2'?{rejected:true}:{url:'https://outside.example/item'})})});
 const xml=await refresh();assert.equal((xml.match(/<item>/g)||[]).length,0);
});
