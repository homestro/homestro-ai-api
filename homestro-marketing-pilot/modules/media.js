import {assertOpenAiHealth,recordOpenAiFailure} from './openai-health.js';
import {storyAss} from './video-story.js';
import {mkdir,mkdtemp,readFile,writeFile,rename,rm,stat,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {hash,fail,log,codeOf} from './core.js';

export function extractMedia(nodes=[]) {
  const videos=nodes.filter(n=>n.mediaContentType==='VIDEO' && n.status==='READY')
    .flatMap(n=>[n.originalSource,...(n.sources||[])].filter(Boolean))
    .filter(s=>s.mimeType==='video/mp4' || String(s.format).toLowerCase()==='mp4')
    .sort((a,b)=>(b.width||0)*(b.height||0)-(a.width||0)*(a.height||0));
  const images=[...new Set(nodes.filter(n=>n.mediaContentType==='IMAGE' && n.status==='READY').map(n=>n.image?.url).filter(Boolean))];
  return {videoURL:videos[0]?.url||null,images};
}
export const carouselAssetKey=image=>hash({image,imageRendererVersion:3});
export function shopifyJpegUrl(raw) {
  const u=new URL(raw);
  if(u.hostname!=='cdn.shopify.com'&&!(u.hostname==='homestro.de'&&u.pathname.startsWith('/cdn/shop/')))return raw;
  u.searchParams.set('format','jpg');u.searchParams.set('width','1080');
  return u.href;
}
// Prefer product photographs with little embedded copy. OCR is a local heuristic,
// not a language translation or a guarantee that a picture has no text.
export function selectPhotos(photos,limit=4) {
  const supplierComparison=p=>/srovn[-_]?\d*/i.test(decodeURIComponent((new URL(p.url).pathname.split('/').pop()||'')));
  const englishPromo=p=>/\b(?:before|after|before\s+and\s+after|gently\s+scrub|learning\s+machine|buy\s+now|free\s+shipping|best\s+seller|limited\s+offer|sale|off\s+today)\b/i.test(String(p.text||''));
  const preferred=photos.filter(p=>!supplierComparison(p)&&!englishPromo(p)&&(p.words===null||p.words<=8));
  const noComparison=photos.filter(p=>!supplierComparison(p));
  const byClarity=(a,b)=>(a.words??0)-(b.words??0);
  const ranked=preferred.length?preferred:
    noComparison.length?[...noComparison].sort((a,b)=>Number(englishPromo(a))-Number(englishPromo(b))||byClarity(a,b)):
    [...photos].sort((a,b)=>Number(englishPromo(a))-Number(englishPromo(b))||byClarity(a,b));
  return [...new Map(ranked.map(p=>[new URL(p.url).pathname,p])).values()].slice(0,Math.min(4,limit)).map(p=>p.url);
}
function run(bin,args,timeout=120000,cwd) {
  return new Promise((resolve,reject)=>{
    const c=spawn(bin,args,{cwd,stdio:['ignore','pipe','pipe']});let out='',done=false;
    const timer=setTimeout(()=>{c.kill('SIGKILL');finish(new Error('MEDIA_TIMEOUT'));},timeout);
    function finish(e){if(done)return;done=true;clearTimeout(timer);e?reject(e):resolve(out);}
    c.stdout.on('data',b=>{out+=b;if(out.length>1000000)c.kill('SIGKILL');});
    c.stderr.on('data',()=>{}); // Never log ffmpeg input URLs.
    c.once('error',()=>finish(new Error('MEDIA_BINARY_MISSING')));
    c.once('close',code=>finish(code===0?null:new Error('MEDIA_ENCODING_FAILED')));
  });
}
export async function downloadMedia(url,path,allowedHosts,fetchImpl=fetch,maxBytes=150*1024*1024,{shopifyJpeg=false}={}) {
  let u;
  try {u=new URL(url);} catch {fail('INVALID_MEDIA_URL');}
  // Exact trusted CDN host allowlist, no redirects or arbitrary user origins (SSRF).
  if(u.protocol!=='https:' || u.username || u.password || u.port || !allowedHosts.includes(u.hostname)) fail('MEDIA_HOST_NOT_ALLOWED');
  const requestUrl=shopifyJpeg?shopifyJpegUrl(u.href):u.href;
  const requestOptions={headers:shopifyJpeg?{Accept:'image/jpeg'}:undefined,redirect:'error',signal:AbortSignal.timeout(60000)};
  let r=null;
  for(let attempt=0;attempt<(shopifyJpeg?3:1);attempt++){
    try{
      r=await fetchImpl(requestUrl,requestOptions);
      if(r.ok&&r.body)break;
      if(r.status<500&&r.status!==429)break;
      await r.body?.cancel().catch(()=>{});
    }catch(error){if(attempt>=(shopifyJpeg?2:0))throw error;}
    if(attempt<(shopifyJpeg?2:0))await new Promise(resolve=>setTimeout(resolve,250*(attempt+1)));
  }
  if(!r?.ok || !r.body) fail('MEDIA_DOWNLOAD_FAILED');
  if(shopifyJpeg&&(r.status!==200||String(r.headers.get('content-type')||'').split(';')[0].trim().toLowerCase()!=='image/jpeg'))fail('SHOPIFY_JPEG_HTTP_VERIFICATION_FAILED');
  if(Number(r.headers.get('content-length'))>maxBytes) fail('MEDIA_TOO_LARGE');
  const chunks=[];let size=0,signature=Buffer.alloc(0);
  for await(const raw of r.body){
    const chunk=Buffer.from(raw);size+=chunk.length;if(size>maxBytes){fail('MEDIA_TOO_LARGE');}
    if(shopifyJpeg&&signature.length<3)signature=Buffer.concat([signature,chunk.subarray(0,3-signature.length)]);
    chunks.push(chunk);
  }
  if(shopifyJpeg&&(signature.length<3||signature[0]!==0xff||signature[1]!==0xd8||signature[2]!==0xff))fail('SHOPIFY_JPEG_SIGNATURE_INVALID');
  await writeFile(path,Buffer.concat(chunks));
}
function plain(value,max=1800) {
  return String(value||'').replace(/<[^>]*>/g,' ').replace(/&nbsp;/gi,' ')
    .replace(/&amp;/gi,'&').replace(/\s+/g,' ').trim().slice(0,max);
}
function safeScript(value) {
  const s=plain(value,360).replace(/[\r\n]+/g,' ').replace(/-->/g,'—').trim();
  const words=s.split(/\s+/).filter(Boolean);
  if(words.length<6 || words.length>28 || /was\s+macht\s+.{1,120}\s+im\s+alltag\s+leichter|gate\s*b14/i.test(s))fail('VIDEO_SCRIPT_INVALID');
  return s;
}
function fallbackScript(product) {
  const c=product.localized||{},title=plain(c.title||product.title||'dieses Produkt',100);
  const benefit=plain(c.benefits?.[0]?.text||c.description||'',180);
  const openings=['Kennst du das, wenn eine kleine Aufgabe unnötig Zeit kostet?','Manchmal hilft schon eine praktische Idee für den Alltag.','Für genau solche Momente gibt es eine einfache Lösung.','Kleine Alltagshilfe gesucht? Schau dir das hier an.','Warum kompliziert, wenn es auch praktisch geht?'];
  const seed=parseInt(hash(product.id||title).slice(0,8),16)||0;
  return safeScript([openings[seed%openings.length],title,benefit].filter(Boolean).join(' ').split(/\s+/).slice(0,27).join(' '));
}
async function responseOrFail(response,cfg,operation) {
  if(response.ok)return response;
  if([401,403,429].includes(response.status))fail(await recordOpenAiFailure(response,cfg,operation));
  fail('OPENAI_API_FAILED');
}
async function generateScript(product,cfg,fetchImpl) {
  if(typeof cfg.generateScript==='function')return safeScript(await cfg.generateScript(product));
  if(!cfg.openaiApiKey)return fallbackScript(product);
  await assertOpenAiHealth(cfg);
  const copy=product.localized||{};
  const source={
    title:plain(copy.title||product.title,180),
    description:plain(copy.description,1000),
    hook:plain(copy.hook,120),
    verifiedBenefits:(copy.benefits||[]).map(x=>plain(x?.text,160)).filter(Boolean).slice(0,3)
  };
  try {
    const response=await fetchImpl('https://api.openai.com/v1/chat/completions',{
      method:'POST',redirect:'error',signal:AbortSignal.timeout(30000),
      headers:{Authorization:'Bearer '+cfg.openaiApiKey,'Content-Type':'application/json'},
      body:JSON.stringify({model:cfg.videoScriptModel||'gpt-4o-mini',temperature:0.4,max_tokens:110,
        messages:[
          {role:'system',content:'Write a fresh, punchy German product voiceover in 16–22 words. The first sentence is a curiosity hook for the first 2 seconds; follow it with two short, distinct benefits from the supplied copy. Never use “Was macht [Produkt] im Alltag leichter?” or any variation, and never mention Gate B14. Do not begin with a catalogue title. Use ONLY facts explicitly present in the product copy; invent no price, performance, rating, discount, guarantee, health effect, delivery promise, or scarcity. Natural spoken German, not robotic. Return only the German text.'},
          {role:'user',content:JSON.stringify(source)}
        ]})
    });
    await responseOrFail(response,cfg,'script');
    const data=await response.json();
    const text=data.choices?.[0]?.message?.content;
    if(!text)fail('OPENAI_EMPTY_SCRIPT');
    return safeScript(text);
  } catch(e) {
    // A provider outage may use reviewed German copy; auth failures must stay visible.
    if(e?.code==='OPENAI_AUTH_FAILED'||e?.code==='OPENAI_RATE_LIMIT')throw e;
    return fallbackScript(product);
  }
}
async function getSpeech(script,cfg,fetchImpl) {
  if(typeof cfg.synthesizeSpeech==='function')return Buffer.from(await cfg.synthesizeSpeech(script));
  if(!cfg.openaiApiKey)fail('OPENAI_API_KEY_REQUIRED');
  await assertOpenAiHealth(cfg);
  const response=await fetchImpl('https://api.openai.com/v1/audio/speech',{
    method:'POST',redirect:'error',signal:AbortSignal.timeout(60000),
    headers:{Authorization:'Bearer '+cfg.openaiApiKey,'Content-Type':'application/json'},
    body:JSON.stringify({model:cfg.videoTtsModel||'gpt-4o-mini-tts',voice:cfg.videoTtsVoice||'coral',
      input:script,instructions:'Speak in natural conversational German with a lively, confident but friendly tone. Make the opening question engaging, keep a brisk clear pace, and avoid a robotic catalogue or exaggerated sales announcer voice. Do not add words.',
      response_format:'mp3'})
  });
  await responseOrFail(response,cfg,'speech');
  const bytes=Buffer.from(await response.arrayBuffer());
  if(!bytes.length||bytes.length>15*1024*1024)fail('OPENAI_AUDIO_INVALID');
  return bytes;
}
function timecode(seconds,srt=false) {
  const ms=Math.max(0,Math.round(seconds*1000)),h=Math.floor(ms/3600000),
    m=Math.floor(ms%3600000/60000),s=Math.floor(ms%60000/1000),r=ms%1000;
  const sep=srt?',':'.';
  return [String(h).padStart(2,'0'),String(m).padStart(2,'0'),String(s).padStart(2,'0')].join(':')+sep+String(r).padStart(3,'0');
}
function makeCaptions(script,duration) {
  const words=script.split(/\s+/).filter(Boolean),groups=[];
  for(let i=0;i<words.length;i+=5)groups.push(words.slice(i,i+5).join(' '));
  const total=groups.reduce((n,x)=>n+x.length,0)||1;let passed=0;
  return groups.map((text,i)=>{
    const start=duration*passed/total;passed+=text.length;
    const end=i===groups.length-1?duration:duration*passed/total;
    return String(i+1)+'\n'+timecode(start,true)+' --> '+timecode(end,true)+'\n'+text+'\n';
  }).join('\n');
}
async function dailyVideoCount(dir) {
  const now=new Date(),year=now.getUTCFullYear(),month=now.getUTCMonth(),day=now.getUTCDate();
  let count=0;
  for(const name of await readdir(dir).catch(()=>[])) {
    if(!name.endsWith('.speech.mp3'))continue;
    try{const info=await stat(join(dir,name)),d=new Date(info.mtimeMs);
      if(d.getUTCFullYear()===year&&d.getUTCMonth()===month&&d.getUTCDate()===day)count++;
    }catch{}
  }
  return count;
}
async function encode(args,cwd,timeout=180000) {
  return run('/usr/bin/ffmpeg',args,timeout,cwd);
}
async function assertMetaReelSpec(file) {
  const result=JSON.parse(await run('/usr/bin/ffprobe',['-v','error','-show_streams','-of','json',file]));
  const video=(result.streams||[]).find(stream=>stream.codec_type==='video');
  const audio=(result.streams||[]).find(stream=>stream.codec_type==='audio');
  const size=(await stat(file)).size;
  if(!video||video.codec_name!=='h264'||video.width!==1080||video.height!==1920||
     video.pix_fmt!=='yuv420p'||video.avg_frame_rate!=='30/1'||
     !audio||audio.codec_name!=='aac'||Number(audio.sample_rate)!==44100||audio.channels!==2||size<=10000)
    fail('META_REEL_SPEC_INVALID');
  return {width:video.width,height:video.height,fps:video.avg_frame_rate,pixelFormat:video.pix_fmt,
    audioCodec:audio.codec_name,audioSampleRate:Number(audio.sample_rate),audioChannels:audio.channels,size};
}
export class MediaRenderer {
  constructor(cfg) {this.cfg=cfg;}
  async render(product) {
    const selected=extractMedia(product.media);
    if(!selected.videoURL && !selected.images.length) fail('NO_MARKETING_MEDIA');
    if(this.cfg.aiVideoEnabled && !selected.videoURL) {
      try{return await this.aiReel(product,selected);}
      catch(e){
        // Optional narration must not stop the entire organic photo pipeline.
        // Keep cached/provider backoff and voice quotas intact; use existing
        // product media without claiming an AI voice was generated.
        if(!['AI_VIDEO_DAILY_LIMIT','OPENAI_RATE_LIMIT','OPENAI_QUOTA_EXCEEDED','OPENAI_QUOTA_EXHAUSTED',
          'OPENAI_INSUFFICIENT_QUOTA','insufficient_quota','OPENAI_AUTH_FAILED','OPENAI_DIAGNOSTIC_STATE_UNREADABLE','OPENAI_API_KEY_REQUIRED'].includes(e?.code))throw e;
        if(/QUOTA|insufficient_quota/i.test(String(e?.code||'')))
          log('OPENAI_QUOTA_EXHAUSTED',{productId:product.id,fallback:'verified_shopify_jpeg'});
        else log('AI_VIDEO_DEFERRED',{productId:product.id,reason:e.code,fallback:'verified_shopify_jpeg'});
        return this.renderImageReel(product,selected);
      }
    }
    if(!selected.videoURL) return this.renderImageReel(product,selected);
    const key=hash({media:selected,hook:product.localized.hook,renderVersion:4});
    const dir=join(this.cfg.dataDir,'assets');await mkdir(dir,{recursive:true});
    const output=join(dir,key+'.mp4');
    try {await stat(output);await assertMetaReelSpec(output);return {format:'reels',videoURL:this.url(key),imageURLs:[]};} catch{}
    const tmp=await mkdtemp(join(dir,'render-'));
    try {
      const wrapped=product.localized.hook.match(/.{1,32}(?:\s|$)|.{1,32}/g)?.map(x=>x.trim()).join('\n')||'';
      await writeFile(join(tmp,'hook.txt'),wrapped,'utf8');
      const hook=`drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf:textfile=hook.txt:expansion=none:fontsize=32:fontcolor=white:box=1:boxcolor=black@0.7:boxborderw=12:x=(w-tw)/2:y=70:enable='lt(t,3)'`;
      const vf=`scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=0x151515,setsar=1,fps=30,format=yuv420p,${hook}`;
      const args=['-hide_banner','-loglevel','error','-y'];
      await downloadMedia(selected.videoURL,join(tmp,'source.mp4'),this.cfg.mediaHosts,this.cfg.fetchImpl||fetch);
      const probe=JSON.parse(await run('/usr/bin/ffprobe',['-v','error','-show_streams','-show_format','-of','json',join(tmp,'source.mp4')]));
      const hasAudio=(probe.streams||[]).some(stream=>stream.codec_type==='audio');
      if(Number(probe.format?.duration)<4 || !Number.isFinite(Number(probe.format?.duration))) fail('VIDEO_TOO_SHORT');
      args.push('-i',join(tmp,'source.mp4'));
      if(!hasAudio)args.push('-f','lavfi','-t','30','-i','anullsrc=channel_layout=stereo:sample_rate=44100');
      args.push('-t','30','-vf',vf,'-map','0:v:0','-map',hasAudio?'0:a:0':'1:a:0',
        '-threads','1','-filter_threads','1','-filter_complex_threads','1',
        '-c:v','libx264','-preset','fast','-crf','24','-pix_fmt','yuv420p',
        '-c:a','aac','-ar','44100','-ac','2','-b:a','128k','-shortest','-movflags','+faststart',join(tmp,'out.mp4'));
      await encode(args,tmp);
      await assertMetaReelSpec(join(tmp,'out.mp4'));
      await rename(join(tmp,'out.mp4'),output);
      return {format:'reels',videoURL:this.url(key),imageURLs:[]};
    } finally {await rm(tmp,{recursive:true,force:true});}
  }
  async renderImageReel(product,selected) {
    const gallery=await this.carousel(selected.images);
    const photos=gallery.imageURLs.slice(0,4);
    if(photos.length<1) {
      log('REEL_SKIPPED',{productId:product.id,reason:'INSUFFICIENT_CLEAN_PRODUCT_ANGLES',cleanAngles:photos.length});
      return gallery;
    }
    const c=product.localized||{},script=fallbackScript(product);
    const key=hash({videoEngine:7,id:product.id,revision:product.revision||null,script,shots:photos});
    const dir=join(this.cfg.dataDir,'assets');await mkdir(dir,{recursive:true});
    const output=join(dir,key+'.mp4');
    try {await stat(output);await assertMetaReelSpec(output);return {format:'reels',videoURL:this.url(key),imageURLs:[]};} catch {}
    const files=photos.map(url=>join(dir,new URL(url).pathname.split('/').pop()));
    const uniqueFiles=[...new Set(files)].slice(0,4);
    // Repeat 1–2 verified photos as distinct crops so the Reel still has multiple moving beats.
    const shots=uniqueFiles.length>=3?uniqueFiles:Array.from({length:4},(_,i)=>uniqueFiles[i%uniqueFiles.length]);
    const duration=10,fade=0.25,segment=(duration+fade*(shots.length-1))/shots.length,filters=[];
    const tmp=await mkdtemp(join(dir,'reel-'));
    try {
      await writeFile(join(tmp,'story.ass'),storyAss(c,script,duration),'utf8');
      const args=['-hide_banner','-loglevel','error','-y'];
      for(const file of shots)args.push('-loop','1','-t',segment.toFixed(3),'-i',file);
      const panX=[20,-24,28,-18],panY=[25,-20,-16,22];
      shots.forEach((_,i)=>filters.push('['+i+':v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,'+
        "zoompan=z='min(zoom+0.0012,1.08)':x='(iw-iw/zoom)/2+"+panX[i%4]+"*sin(on/48)':y='(ih-ih/zoom)/2+"+panY[i%4]+"*cos(on/52)':d=1:s=1080x1920:fps=30,trim=duration="+segment.toFixed(3)+",setpts=PTS-STARTPTS,setsar=1,format=yuv420p[v"+i+']'));
      let current='v0';
      for(let i=1;i<shots.length;i++){
        const next='x'+i,offset=(i*(segment-fade)).toFixed(3);
        filters.push('['+current+'][v'+i+']xfade=transition=fade:duration='+fade+':offset='+offset+'['+next+']');
        current=next;
      }
      args.push('-f','lavfi','-t',String(duration),'-i','anullsrc=channel_layout=stereo:sample_rate=44100');
      filters.push('['+current+']ass=story.ass[v]');
      args.push('-filter_complex',filters.join(';'),'-map','[v]','-map',String(shots.length)+':a:0','-t',String(duration),
        '-threads','1','-filter_threads','1','-filter_complex_threads','1',
        '-c:v','libx264','-preset','fast','-crf','24','-pix_fmt','yuv420p',
        '-c:a','aac','-ar','44100','-ac','2','-b:a','128k','-shortest','-movflags','+faststart',join(tmp,'out.mp4'));
      await encode(args,tmp,240000);
      await assertMetaReelSpec(join(tmp,'out.mp4'));
      await rename(join(tmp,'out.mp4'),output);
      log('ORGANIC_REEL_READY',{productId:product.id,angles:shots.length,render:'ffmpeg_zoompan',paidGeneration:false});
      return {format:'reels',videoURL:this.url(key),imageURLs:[]};
    } finally {await rm(tmp,{recursive:true,force:true});}
  }
  async aiReel(product,selected) {
    if(!this.cfg.openaiApiKey&&!this.cfg.synthesizeSpeech)fail('OPENAI_API_KEY_REQUIRED');
    const dir=join(this.cfg.dataDir,'assets');await mkdir(dir,{recursive:true});
    const source=selected.videoURL?{video:selected.videoURL}:{image:selected.images[0]};
    const c=product.localized||{};
    const version={videoEngine:5,source,id:product.id,title:c.title,description:c.description,hook:c.hook,benefits:c.benefits,
      scriptModel:this.cfg.videoScriptModel||'gpt-4o-mini',ttsModel:this.cfg.videoTtsModel||'gpt-4o-mini-tts',voice:this.cfg.videoTtsVoice||'coral'};
    const audioKey=hash(version),key=hash({...version,videoEngine:6,shots:selected.images.slice(0,4)}),output=join(dir,key+'.mp4'),scriptPath=join(dir,audioKey+'.script.txt'),speechPath=join(dir,audioKey+'.speech.mp3');
    let script,speech;
    try{script=(await readFile(scriptPath,'utf8')).trim();}catch{}
    try{speech=await readFile(speechPath);}catch{}
    try{await stat(output);await assertMetaReelSpec(output);log('AI_VIDEO_READY',{productId:product.id,videoURL:this.url(key),voiceover:true,cached:true});return {format:'reels',videoURL:this.url(key),imageURLs:[],videoScript:script||null,voiceover:true};}catch{}
    const tmp=await mkdtemp(join(dir,'render-'));
    try{
      // Check the daily voice quota before spending tokens on either a script or speech.
      const cap=Number(this.cfg.videoDailyLimit||2);
      if(!speech && await dailyVideoCount(dir)>=cap)fail('AI_VIDEO_DAILY_LIMIT');
      script=script||await generateScript(product,this.cfg,this.cfg.fetchImpl||fetch);
      await writeFile(scriptPath,script,'utf8');
      if(!speech) {
        speech=await getSpeech(script,this.cfg,this.cfg.fetchImpl||fetch);
        await writeFile(join(tmp,'voice.mp3'),speech);
        await rename(join(tmp,'voice.mp3'),speechPath);
      }
      if(!speech.length)fail('OPENAI_AUDIO_INVALID');
      const probe=JSON.parse(await run('/usr/bin/ffprobe',['-v','error','-show_format','-of','json',speechPath]));
      const voiceDuration=Number(probe.format?.duration);
      if(!Number.isFinite(voiceDuration)||voiceDuration<2)fail('VIDEO_AUDIO_TOO_SHORT');
      const duration=Math.max(8,Math.min(10,Number(this.cfg.videoMaxDurationSec||20),voiceDuration+0.25));
      await writeFile(join(tmp,'story.ass'),storyAss(c,script,duration),'utf8');
      const args=['-hide_banner','-loglevel','error','-y'];
      if(selected.videoURL) {
        await downloadMedia(selected.videoURL,join(tmp,'source.mp4'),this.cfg.mediaHosts,this.cfg.fetchImpl||fetch);
        const info=JSON.parse(await run('/usr/bin/ffprobe',['-v','error','-show_format','-of','json',join(tmp,'source.mp4')]));
        if(Number(info.format?.duration)<2||!Number.isFinite(Number(info.format?.duration)))fail('VIDEO_TOO_SHORT');
        args.push('-stream_loop','-1','-i',join(tmp,'source.mp4'),'-i',speechPath,'-map','0:v:0','-map','1:a:0','-t',String(duration),
          '-vf',"scale=1020:1020:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:410:color=0xf4f4ef,setsar=1,fps=30,format=yuv420p,ass=story.ass");
      } else {
        // OCR-rank distinct product angles, then animate each scene with Ken Burns motion.
        const photos=await this.carousel(selected.images);
        const files=photos.imageURLs.slice(0,4).map(url=>join(dir,new URL(url).pathname.split('/').pop()));
        if(!files.length)fail('NO_MARKETING_MEDIA');
        const shots=[...new Set(files)].slice(0,4);
        for(const file of shots)args.push('-loop','1','-i',file);
        args.push('-i',speechPath);
        const fade=0.25,segment=(duration+fade*(shots.length-1))/shots.length,filters=[];
        shots.forEach((_,i)=>filters.push('['+i+':v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,'+
          "zoompan=z='min(zoom+0.0012,1.08)':x='(iw-iw/zoom)/2+sin(on/48)*20':y='(ih-ih/zoom)/2+cos(on/52)*25':d=1:s=1080x1920:fps=30,trim=duration="+segment.toFixed(3)+",setpts=PTS-STARTPTS,setsar=1,format=yuv420p[v"+i+']'));
        let current='v0';
        for(let i=1;i<shots.length;i++){
          const next='x'+i,offset=(i*(segment-fade)).toFixed(3);
          filters.push('['+current+'][v'+i+']xfade=transition=fade:duration='+fade+':offset='+offset+'['+next+']');
          current=next;
        }
        filters.push('['+current+']ass=story.ass[v]');
        args.push('-filter_complex',filters.join(';'),'-map','[v]','-map',shots.length+':a:0','-t',String(duration));
      }
      args.push('-threads','1','-filter_threads','1','-filter_complex_threads','1',
        '-c:v','libx264','-preset','fast','-crf','24','-pix_fmt','yuv420p',
        '-af','loudnorm=I=-16:TP=-1.5:LRA=11','-c:a','aac','-ar','44100','-ac','2','-b:a','128k','-movflags','+faststart',join(tmp,'out.mp4'));
      await encode(args,tmp,240000);
      await assertMetaReelSpec(join(tmp,'out.mp4'));
      await rename(join(tmp,'out.mp4'),output);
      log('AI_VIDEO_READY',{productId:product.id,videoURL:this.url(key),voiceover:true,cached:false,duration});
      return {format:'reels',videoURL:this.url(key),imageURLs:[],videoScript:script,voiceover:true};
    } finally {await rm(tmp,{recursive:true,force:true});}
  }
  async carousel(images) {
    const dir=join(this.cfg.dataDir,'assets');await mkdir(dir,{recursive:true});
    const balanced=this.cfg.organicPolicy==='balanced-v1',photos=[];
    const unique=[...new Map([...new Set(images)].map(image=>{try{return [new URL(image).pathname,image];}catch{return [image,image];}})).values()];
    for(const image of unique.slice(0,balanced?8:12)) {
      const key=carouselAssetKey(image);const dest=join(dir,key+'.jpg');
      try {await stat(dest);} catch {
        const tmp=await mkdtemp(join(dir,'photo-'));
        try {
          try{
            await downloadMedia(image,join(tmp,'input'),this.cfg.mediaHosts,this.cfg.fetchImpl||fetch,15*1024*1024,{shopifyJpeg:true});
            await run('/usr/bin/ffmpeg',['-hide_banner','-loglevel','error','-y','-i',join(tmp,'input'),
              '-vf','scale=1080:1350:force_original_aspect_ratio=decrease,pad=1080:1350:(ow-iw)/2:(oh-ih)/2:color=white,setsar=1',
              '-frames:v','1','-threads','1','-filter_threads','1','-q:v','3',join(tmp,'image.jpg')]);
            const info=await stat(join(tmp,'image.jpg'));if(info.size>8*1024*1024)fail('INSTAGRAM_IMAGE_TOO_LARGE');
            await rename(join(tmp,'image.jpg'),dest);
          }catch(error){
            log('PRODUCT_IMAGE_SKIPPED',{reason:codeOf(error)});
            continue;
          }
        } finally {await rm(tmp,{recursive:true,force:true});}
      }
      let words=null,text='';
      const assessment=join(dir,key+'.ocr-v2.json');
      try{const cached=JSON.parse(await readFile(assessment,'utf8'));words=cached.words;text=String(cached.text||'');}catch{
        try{
          const tsv=await run('/usr/bin/tesseract',[dest,'stdout','-l','eng','--psm','11','tsv'],15000);
          const recognized=tsv.split('\n').slice(1).map(line=>line.split('\t')).filter(cells=>
            cells[0]==='5'&&Number(cells[10])>=40&&/[\p{L}\p{N}]/u.test(cells[11]||''));
          words=recognized.length;text=recognized.map(cells=>cells[11].trim()).filter(Boolean).join(' ');
          await writeFile(assessment,JSON.stringify({words,text}),'utf8');
        }catch{ /* OCR failure never blocks otherwise usable photos. */ }
      }
      photos.push({url:`${this.cfg.publicOrigin}/marketing-assets/${key}.jpg`,words,text});
    }
    const urls=selectPhotos(photos,balanced?6:10);
    if(!urls.length)fail('NO_MARKETING_MEDIA');
    return {format:urls.length>1?'carousel':'image',videoURL:null,imageURLs:urls};
  }
  url(key){return `${this.cfg.publicOrigin}/marketing-assets/${key}.mp4`;}
}



