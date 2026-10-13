import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp,readFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {MediaRenderer} from '../modules/media.js';

test('real FFmpeg: carousel creates cached JPEGs only; attached video creates vertical MP4',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'homestro-media-test-'));
  const original=globalThis.fetch;
  try {
    execFileSync('ffmpeg',['-hide_banner','-loglevel','error','-y','-f','lavfi','-i','color=c=blue:s=100x100:d=1',
      '-frames:v','1','-threads','1',join(dir,'fixture.jpg')]);
    execFileSync('ffmpeg',['-hide_banner','-loglevel','error','-y','-f','lavfi','-i','color=c=green:s=100x200:d=4.2',
      '-c:v','libx264','-threads','1','-pix_fmt','yuv420p',join(dir,'fixture.mp4')]);
    const jpeg=await readFile(join(dir,'fixture.jpg')),mp4=await readFile(join(dir,'fixture.mp4'));
    globalThis.fetch=async url=>new Response(String(url).endsWith('.mp4')?mp4:jpeg);
    const renderer=new MediaRenderer({dataDir:dir,mediaHosts:['cdn.shopify.com'],publicOrigin:'https://pilot.example'});
    const p={localized:{hook:'Mehr Übersicht in deinem Kühlschrank'},media:[
      {mediaContentType:'IMAGE',status:'READY',image:{url:'https://cdn.shopify.com/1.jpg'}},
      {mediaContentType:'IMAGE',status:'READY',image:{url:'https://cdn.shopify.com/2.jpg'}}]};
    const c=await renderer.render(p);
    assert.equal(c.format,'carousel');assert.equal(c.imageURLs.length,2);
    assert.ok((await readdir(join(dir,'assets'))).every(x=>x.endsWith('.jpg')));
    const cache=await renderer.render(p);assert.deepEqual(cache,c);
    const v=await renderer.render({...p,media:[...p.media,{mediaContentType:'VIDEO',status:'READY',sources:[
      {url:'https://cdn.shopify.com/test.mp4',mimeType:'video/mp4',width:100,height:200}]}]});
    assert.equal(v.format,'reels');
    const path=join(dir,'assets',new URL(v.videoURL).pathname.split('/').pop());
    const probe=JSON.parse(execFileSync('ffprobe',['-v','error','-show_streams','-show_format','-of','json',path]).toString());
    assert.equal(probe.streams[0].width,720);assert.equal(probe.streams[0].height,1280);
    assert.equal(probe.streams[0].codec_name,'h264');assert.ok(Number(probe.format.duration)>=4);
  }finally{globalThis.fetch=original;await rm(dir,{recursive:true,force:true});}
});



test('real local OCR prefers a plain product photograph over a text-heavy image and caches its assessment',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'homestro-ocr-test-')),original=globalThis.fetch;
  try{
    execFileSync('ffmpeg',['-hide_banner','-loglevel','error','-y','-f','lavfi','-i','color=c=white:s=1080x1350',
      '-vf',"drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf:text='PRODUCT PHOTO WITH LOTS OF TEXT':fontsize=38:fontcolor=black:x=20:y=100,drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf:text='BUY NOW SPECIAL OFFER QUALITY ITEM':fontsize=38:fontcolor=black:x=20:y=200",
      '-frames:v','1','-threads','1',join(dir,'text.jpg')]);
    execFileSync('ffmpeg',['-hide_banner','-loglevel','error','-y','-f','lavfi','-i','color=c=blue:s=100x100',
      '-frames:v','1','-threads','1',join(dir,'plain.jpg')]);
    const text=await readFile(join(dir,'text.jpg')),plain=await readFile(join(dir,'plain.jpg'));let downloads=0;
    globalThis.fetch=async url=>{downloads++;return new Response(String(url).endsWith('text.jpg')?text:plain);};
    const renderer=new MediaRenderer({dataDir:dir,mediaHosts:['cdn.shopify.com'],publicOrigin:'https://pilot.example',organicPolicy:'balanced-v1'});
    const urls=['https://cdn.shopify.com/text.jpg','https://cdn.shopify.com/plain.jpg'];
    const selected=await renderer.carousel(urls);assert.equal(selected.imageURLs.length,1);
    const plainOnly=await renderer.carousel([urls[1]]);assert.equal(selected.imageURLs[0],plainOnly.imageURLs[0]);
    const assessments=(await readdir(join(dir,'assets'))).filter(x=>x.endsWith('.ocr-v1.json'));
    assert.equal(assessments.length,2);assert.deepEqual(await renderer.carousel(urls),selected);assert.equal(downloads,2);
  }finally{globalThis.fetch=original;await rm(dir,{recursive:true,force:true});}
});


test('AI Reel mode creates a vertical video with voice and captions from Shopify product media',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'homestro-ai-reel-test-'));
  try {
    execFileSync('/usr/bin/ffmpeg',['-hide_banner','-loglevel','error','-y','-f','lavfi','-i','color=c=blue:s=320x400:d=1',
      '-frames:v','1','-threads','1',join(dir,'fixture.jpg')]);
    execFileSync('/usr/bin/ffmpeg',['-hide_banner','-loglevel','error','-y','-f','lavfi','-i','sine=frequency=600:duration=6',
      '-c:a','libmp3lame','-q:a','8','-threads','1',join(dir,'voice.mp3')]);
    const jpeg=await readFile(join(dir,'fixture.jpg')),voice=await readFile(join(dir,'voice.mp3')),calls=[];
    const renderer=new MediaRenderer({dataDir:dir,mediaHosts:['cdn.shopify.com'],publicOrigin:'https://pilot.example',
      aiVideoEnabled:true,openaiApiKey:'test-key',videoDailyLimit:2,videoMaxDurationSec:15,
      fetchImpl:async(url)=>{
        const target=String(url);calls.push(target);
        if(target.endsWith('/v1/chat/completions'))return new Response(JSON.stringify({choices:[{message:{content:'Mehr Ordnung in deiner Küche. Diese Boxen halten Kleinteile übersichtlich zusammen. Jetzt bei Homestro entdecken.'}}]}),{status:200,headers:{'Content-Type':'application/json'}});
        if(target.endsWith('/v1/audio/speech'))return new Response(voice,{status:200,headers:{'Content-Type':'audio/mpeg'}});
        return new Response(jpeg,{status:200,headers:{'Content-Type':'image/jpeg'}});
      }});
    const product={id:'gid://shopify/Product/123',title:'Küchenbox',
      localized:{title:'Küchenbox',description:'Box für die Küche',hook:'Mehr Ordnung in deiner Küche',
        benefits:[{text:'Für übersichtliche Aufbewahrung'}]},
      media:[{mediaContentType:'IMAGE',status:'READY',image:{url:'https://cdn.shopify.com/product.jpg'}}]};
    const asset=await renderer.render(product);
    assert.equal(asset.format,'reels');assert.equal(asset.voiceover,true);assert.match(asset.videoScript,/Küche/);
    assert.equal(calls.filter(x=>x.endsWith('/v1/chat/completions')).length,1);
    assert.equal(calls.filter(x=>x.endsWith('/v1/audio/speech')).length,1);
    const file=join(dir,'assets',new URL(asset.videoURL).pathname.split('/').pop());
    const probe=JSON.parse(execFileSync('/usr/bin/ffprobe',['-v','error','-show_streams','-show_format','-of','json',file]).toString());
    const video=probe.streams.find(x=>x.codec_type==='video'),audio=probe.streams.find(x=>x.codec_type==='audio');
    assert.equal(video.width,720);assert.equal(video.height,1280);assert.equal(video.codec_name,'h264');
    assert.equal(audio.codec_name,'aac');assert.ok(Number(probe.format.duration)>=5);
  } finally {await rm(dir,{recursive:true,force:true});}
});

test('AI Reel mode fails closed on OpenAI authentication errors',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'homestro-ai-reel-auth-test-'));
  try {
    const renderer=new MediaRenderer({dataDir:dir,mediaHosts:['cdn.shopify.com'],publicOrigin:'https://pilot.example',
      aiVideoEnabled:true,openaiApiKey:'bad-key',videoDailyLimit:2,fetchImpl:async()=>new Response('unauthorized',{status:401})});
    await assert.rejects(()=>renderer.render({id:'gid://shopify/Product/123',localized:{title:'Produkt',
      description:'Produktbeschreibung',hook:'Mehr Ordnung',benefits:[{text:'Gut sortiert'}]},
      media:[{mediaContentType:'IMAGE',status:'READY',image:{url:'https://cdn.shopify.com/product.jpg'}}]}),
      error=>error.code==='OPENAI_AUTH_FAILED');
  } finally {await rm(dir,{recursive:true,force:true});}
});
