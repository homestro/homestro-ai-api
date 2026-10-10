'use strict';
const assert=require('node:assert/strict');
const {googleOrganicXml}=require('./google-organic-feed');
(async()=>{
const prices=['49.99','50.00','79.99'];
const xml=await googleOrganicXml(async()=>({products:{nodes:prices.map((price,i)=>({title:'Produkt '+i,onlineStoreUrl:'https://homestro.de/products/test-'+i,featuredMedia:{image:{url:'https://cdn.shopify.com/test.jpg'}},variants:{nodes:[{id:'gid://shopify/ProductVariant/'+i,price,availableForSale:true}]}}))}}));
const items=[...xml.matchAll(/<item>(.*?)<\/item>/g)].map(x=>x[1]);
assert.equal(items.length,3);
for(let i=0;i<items.length;i++){
assert.match(items[i],new RegExp('<g:country>DE</g:country>.*?<g:price>'+(i===0?'6\\.99':'0\\.00')+' EUR</g:price></g:shipping>'));
assert.match(items[i],/<g:country>AT<\/g:country>.*?<g:price>14\.99 EUR<\/g:price><\/g:shipping>/);
assert.match(items[i],new RegExp('<g:price>'+prices[i].replace('.','\\.')+' EUR</g:price>'));
}
console.log('PASS: DE shipping below/at/above EUR50; AT unchanged; product prices unchanged');
})().catch(e=>{console.error(e);process.exit(1)});
