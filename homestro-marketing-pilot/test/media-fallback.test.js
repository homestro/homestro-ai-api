import test from 'node:test';
import assert from 'node:assert/strict';
import {MediaRenderer} from '../modules/media.js';
import {fail} from '../modules/core.js';

const photo='https://cdn.shopify.com/product.jpg';
const product={id:'gid://shopify/Product/123',media:[{mediaContentType:'IMAGE',status:'READY',image:{url:photo}}]};
for(const reason of ['AI_VIDEO_DAILY_LIMIT','OPENAI_RATE_LIMIT','OPENAI_QUOTA_EXCEEDED','OPENAI_AUTH_FAILED','OPENAI_API_KEY_REQUIRED']) {
  test(`optional voice failure ${reason} keeps existing photo publishing available`,async()=>{
    const cfg={aiVideoEnabled:true,_openaiBlockedUntil:12345};
    const renderer=new MediaRenderer(cfg);
    renderer.aiReel=async()=>fail(reason);
    let photos;
    const asset={format:'image',imageURLs:['https://pilot.example/photo.jpg'],videoURL:null};
    renderer.carousel=async images=>{photos=images;return asset;};
    assert.equal(await renderer.render(product),asset);
    assert.deepEqual(photos,[photo]);
    assert.equal(cfg.aiVideoEnabled,true);
    assert.equal(cfg._openaiBlockedUntil,12345);
  });
}
test('media faults remain visible instead of being hidden as provider fallback',async()=>{
  const renderer=new MediaRenderer({aiVideoEnabled:true});
  renderer.aiReel=async()=>fail('MEDIA_TIMEOUT');
  renderer.carousel=async()=>assert.fail('must not hide failed media fetch');
  await assert.rejects(renderer.render(product),{code:'MEDIA_TIMEOUT'});
});
