import test from 'node:test';
import assert from 'node:assert/strict';
import {compilePost} from '../modules/localization.js';
import {parseTrackedLink} from '../modules/tracking.js';

test('compiled organic post uses its signed tracking redirect when pilot configuration is present',()=>{
  const cfg={adminKey:'p'.repeat(40),publicOrigin:'https://pilot.example'};
  const product={id:'gid://shopify/Product/81',url:'https://homestro.de/products/box',
    revision:'rev',categoryKey:'home',localized:{hook:'Mehr Übersicht für den Alltag',
      benefits:[{text:'Vier Boxen im Set'},{text:'Transparent'}],title:'Organizer',
      },variants:[{available:true,price:14.99}]};
  const post=compilePost(product,'facebook',{format:'carousel',imageURLs:['https://assets.example/1.jpg']},cfg);
  const link=new URL(post.link);
  assert.equal(link.origin,cfg.publicOrigin);
  const [, ,payload,sig]=link.pathname.split('/');
  assert.deepEqual(parseTrackedLink(payload,sig,cfg.adminKey),{
    productId:product.id,channel:'facebook',format:'carousel'
  });
  assert.ok(post.caption.includes(post.link));
});
