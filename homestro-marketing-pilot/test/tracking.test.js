import test from 'node:test';
import assert from 'node:assert/strict';
import {createTrackedLink,parseTrackedLink,trackedDestination} from '../modules/tracking.js';

const source={productId:'gid://shopify/Product/123',channel:'facebook',format:'carousel'};
const secret='a'.repeat(48);

test('signs tracking links with a fixed HTTPS origin and verified source',()=>{
  const link=createTrackedLink({...source,publicOrigin:'https://pilot.example',secret});
  assert.match(link,/^https:\/\/pilot\.example\/marketing-click\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+$/);
  const [, ,payload,sig]=new URL(link).pathname.split('/');
  assert.deepEqual(parseTrackedLink(payload,sig,secret),source);
});

test('rejects tampered signatures and unsupported channels',()=>{
  const link=createTrackedLink({...source,publicOrigin:'https://pilot.example',secret});
  const [,payload,sig]=new URL(link).pathname.split('/');
  assert.throws(()=>parseTrackedLink(payload,sig.slice(0,-1)+'x',secret),e=>e.code==='INVALID_TRACKING_LINK');
  assert.throws(()=>createTrackedLink({...source,channel:'unknown',publicOrigin:'https://pilot.example',secret}),e=>e.code==='INVALID_TRACKING_SOURCE');
});

test('redirect destination is restricted to the Homestro product domain and keeps UTM attribution',()=>{
  const url=trackedDestination({url:'https://homestro.de/products/box?variant=1'},'pinterest','image');
  const parsed=new URL(url);
  assert.equal(parsed.origin,'https://homestro.de');
  assert.equal(parsed.pathname,'/products/box');
  assert.equal(parsed.searchParams.get('variant'),'1');
  assert.equal(parsed.searchParams.get('utm_source'),'pinterest');
  assert.equal(parsed.searchParams.get('utm_medium'),'organic');
  assert.equal(parsed.searchParams.get('utm_content'),'image');
  assert.throws(()=>trackedDestination({url:'https://evil.example'},'facebook','image'),e=>e.code==='INVALID_PRODUCT_URL');
});
