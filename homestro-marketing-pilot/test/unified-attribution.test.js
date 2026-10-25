import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {trackedDestination} from '../modules/tracking.js';

const product={id:'gid://shopify/Product/16104466415998',revision:'reviewed-v1',url:'https://homestro.de/products/box?variant=123'};
const secret='o'.repeat(40),now=new Date('2026-10-25T17:00:00.000Z');
test('organic destination emits the same signed envelope accepted by payment attribution',()=>{
  for(const channel of ['facebook','instagram','tiktok','pinterest']){
    const url=new URL(trackedDestination(product,channel,'image',{secret,now}));
    const [body,sig]=url.searchParams.get('pilot_ref').split('.');
    assert.equal(sig,createHmac('sha256',secret).update('pilot-attribution-v1:'+body).digest('hex'));
    const ref=JSON.parse(Buffer.from(body,'base64url'));
    assert.equal(ref.channel,channel);assert.equal(ref.campaign,url.searchParams.get('utm_campaign'));
    assert.equal(ref.ad,url.searchParams.get('utm_content'));assert.equal(ref.experiment.length,24);
    assert.match(ref.ad,/^\d{4,30}$/);assert.equal(ref.expires,'2026-11-01T17:00:00.000Z');
    assert.equal(url.searchParams.get('variant'),'123');assert.equal(url.hostname,'homestro.de');
    assert.equal(url.searchParams.get('utm_medium'),'organic');
  }
});
test('signed tags preserve stable legacy destinations when no internal credential is supplied',()=>{
  const url=new URL(trackedDestination(product,'facebook','image'));
  assert.equal(url.searchParams.has('pilot_ref'),false);
  assert.equal(url.searchParams.get('utm_campaign'),'homestro_pilot');
  assert.throws(()=>trackedDestination(product,'google','image',{secret,now}));
  assert.throws(()=>trackedDestination({...product,url:'https://evil.example/'},'facebook','image',{secret,now}));
});
