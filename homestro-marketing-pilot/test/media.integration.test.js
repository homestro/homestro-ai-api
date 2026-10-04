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
