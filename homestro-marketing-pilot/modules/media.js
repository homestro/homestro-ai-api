import {mkdir,mkdtemp,readFile,writeFile,rename,rm,stat,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {hash,fail,log} from './core.js';

export function extractMedia(nodes=[]) {
  const videos=nodes.filter(n=>n.mediaContentType==='VIDEO' && n.status==='READY')
    .flatMap(n=>[n.originalSource,...(n.sources||[])].filter(Boolean))
    .filter(s=>s.mimeType==='video/mp4' || String(s.format).toLowerCase()==='mp4')
    .sort((a,b)=>(b.width||0)*(b.height||0)-(a.width||0)*(a.height||0));
  const images=[...new Set(nodes.filter(n=>n.mediaContentType==='IMAGE' && n.status==='READY').map(n=>n.image?.url).filter(Boolean))];
  return {videoURL:videos[0]?.url||null,images};
}
export const carouselAssetKey=image=>hash({image,imageRendererVersion:1});
// Prefer product photographs with little embedded copy. OCR is a local heuristic,
// not a language translation or a guarantee that a picture has no text.
export function selectPhotos(photos,limit=4) {
  const clean=photos.filter(p=>p.words!==null && p.words<=8);
  const unknown=photos.filter(p=>p.words===null);
  const ranked=clean.length?clean:unknown.length?unknown:
    [...photos].sort((a,b)=>a.words-b.words).slice(0,2);
  return ranked.slice(0,limit).map(p=>p.url);
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
export async function downloadMedia(url,path,allowedHosts,fetchImpl=fetch,maxBytes=150*1024*1024) {
  let u;
  try {u=new URL(url);} catch {fail('INVALID_MEDIA_URL');}
  // Exact trusted CDN host allowlist, no redirects or arbitrary user origins (SSRF).
  if(u.protocol!=='https:' || u.username || u.password || u.port || !allowedHosts.includes(u.hostname)) fail('MEDIA_HOST_NOT_ALLOWED');
  const r=await fetchImpl(u,{redirect:'error',signal:AbortSignal.timeout(60000)});
  if(!r.ok || !r.body) fail('MEDIA_DOWNLOAD_FAILED');
  if(Number(r.headers.get('content-length'))>maxBytes) fail('MEDIA_TOO_LARGE');
  const chunks=[];let size=0;
  for await(const chunk of r.body){size+=chunk.length;if(size>maxBytes){fail('MEDIA_TOO_LARGE');}chunks.push(chunk);}
  await writeFile(path,Buffer.concat(chunks));
}
function plain(value,max=1800) {
  return String(value||'').replace(/<[^>]*>/g,' ').replace(/&nbsp;/gi,' ')
    .replace(/&amp;/gi,'&').replace(/\s+/g,' ').trim().slice(0,max);
}
function safeScript(value) {
  const s=plain(value,360).replace(/[\r\n]+/g,' ').replace(/-->/g,'—').trim();
  const words=s.split(/\s+/).filter(Boolean);
  if(words.length<4 || words.length>42)fail('VIDEO_SCRIPT_INVALID');
  return s;
}
function fallbackScript(product) {
  const c=product.localized||{}, benefit=c.benefits?.[0]?.text||c.description||'';
  const words=[c.hook,c.title,benefit,'Jetzt bei Homestro entdecken.'].filter(Boolean).join('. ').split(/\s+/).slice(0,30);
  return safeScript(words.join(' '));
}
function assertOpenAiAvailable(cfg) {
  if(Number(cfg._openaiBlockedUntil||0)>Date.now())fail(cfg._openaiBlockedReason||'OPENAI_RATE_LIMIT');
}
function blockOpenAi(cfg,reason,milliseconds) {
  cfg._openaiBlockedReason=reason;
  cfg._openaiBlockedUntil=Date.now()+milliseconds;
}
async function responseOrFail(response,cfg) {
  if(response.ok)return response;
  if(response.status===401||response.status===403) {
    blockOpenAi(cfg,'OPENAI_AUTH_FAILED',24*60*60*1000);
    fail('OPENAI_AUTH_FAILED');
  }
  if(response.status===429) {
    let providerCode='';
    try{providerCode=String((await response.clone().json())?.error?.code||'');}catch{}
    const reason=providerCode==='insufficient_quota'?'OPENAI_QUOTA_EXCEEDED':'OPENAI_RATE_LIMIT';
    const retryAfter=Number(response.headers.get('retry-after'));
    const cooldown=providerCode==='insufficient_quota'?24*60*60*1000:
      Math.min(Math.max(Number.isFinite(retryAfter)&&retryAfter>0?retryAfter:3600,60),24*60*60)*1000;
    blockOpenAi(cfg,reason,cooldown);
    fail(reason);
  }
  fail('OPENAI_API_FAILED');
}
async function generateScript(product,cfg,fetchImpl) {
  if(typeof cfg.generateScript==='function')return safeScript(await cfg.generateScript(product));
  if(!cfg.openaiApiKey)return fallbackScript(product);
  assertOpenAiAvailable(cfg);
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
          {role:'system',content:'Write a short natural German voiceover script for a vertical product video. Use ONLY facts explicitly present in the supplied product copy. Do not invent material, dimensions, performance, ratings, discounts, guarantees, health effects, delivery promises, or scarcity. 15–30 spoken words, one short hook, one supported benefit, one neutral call to action. Return only the spoken German text.'},
          {role:'user',content:JSON.stringify(source)}
        ]})
    });
    await responseOrFail(response,cfg);
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
  assertOpenAiAvailable(cfg);
  const response=await fetchImpl('https://api.openai.com/v1/audio/speech',{
    method:'POST',redirect:'error',signal:AbortSignal.timeout(60000),
    headers:{Authorization:'Bearer '+cfg.openaiApiKey,'Content-Type':'application/json'},
    body:JSON.stringify({model:cfg.videoTtsModel||'gpt-4o-mini-tts',voice:cfg.videoTtsVoice||'coral',
      input:script,instructions:'Speak in natural, clear German at a friendly pace. Do not add words.',
      response_format:'mp3'})
  });
  await responseOrFail(response,cfg);
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
export class MediaRenderer {
  constructor(cfg) {this.cfg=cfg;}
  async render(product) {
    const selected=extractMedia(product.media);
    if(!selected.videoURL && !selected.images.length) fail('NO_MARKETING_MEDIA');
    if(this.cfg.aiVideoEnabled) {
      try{return await this.aiReel(product,selected);}
      catch(e){
        // Optional narration must not stop the entire organic photo pipeline.
        // Keep cached/provider backoff and voice quotas intact; use existing
        // product media without claiming an AI voice was generated.
        if(!['AI_VIDEO_DAILY_LIMIT','OPENAI_RATE_LIMIT','OPENAI_QUOTA_EXCEEDED',
          'OPENAI_AUTH_FAILED','OPENAI_API_KEY_REQUIRED'].includes(e?.code))throw e;
        log('AI_VIDEO_DEFERRED',{productId:product.id,reason:e.code});
      }
    }
    if(!selected.videoURL) return this.carousel(selected.images);
    const key=hash({media:selected,hook:product.localized.hook,renderVersion:1});
    const dir=join(this.cfg.dataDir,'assets');await mkdir(dir,{recursive:true});
    const output=join(dir,key+'.mp4');
    try {await stat(output);return {format:'reels',videoURL:this.url(key),imageURLs:[]};} catch{}
    const tmp=await mkdtemp(join(dir,'render-'));
    try {
      const wrapped=product.localized.hook.match(/.{1,32}(?:\s|$)|.{1,32}/g)?.map(x=>x.trim()).join('\n')||'';
      await writeFile(join(tmp,'hook.txt'),wrapped,'utf8');
      const hook=`drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf:textfile=hook.txt:expansion=none:fontsize=32:fontcolor=white:box=1:boxcolor=black@0.7:boxborderw=12:x=(w-tw)/2:y=70:enable='lt(t,3)'`;
      const vf=`scale=720:1280:force_original_aspect_ratio=decrease,pad=720:1280:(ow-iw)/2:(oh-ih)/2:color=0x151515,setsar=1,fps=30,${hook}`;
      const args=['-hide_banner','-loglevel','error','-y'];
      await downloadMedia(selected.videoURL,join(tmp,'source.mp4'),this.cfg.mediaHosts,this.cfg.fetchImpl||fetch);
      const probe=JSON.parse(await run('/usr/bin/ffprobe',['-v','error','-show_format','-of','json',join(tmp,'source.mp4')]));
      if(Number(probe.format?.duration)<4 || !Number.isFinite(Number(probe.format?.duration))) fail('VIDEO_TOO_SHORT');
      args.push('-i',join(tmp,'source.mp4'),'-t','30','-vf',vf,'-an');
      args.push('-threads','1','-filter_threads','1','-filter_complex_threads','1',
        '-c:v','libx264','-preset','fast','-crf','24','-pix_fmt','yuv420p','-movflags','+faststart',join(tmp,'out.mp4'));
      await encode(args,tmp);
      await rename(join(tmp,'out.mp4'),output);
      return {format:'reels',videoURL:this.url(key),imageURLs:[]};
    } finally {await rm(tmp,{recursive:true,force:true});}
  }
  async aiReel(product,selected) {
    if(!this.cfg.openaiApiKey&&!this.cfg.synthesizeSpeech)fail('OPENAI_API_KEY_REQUIRED');
    const dir=join(this.cfg.dataDir,'assets');await mkdir(dir,{recursive:true});
    const source=selected.videoURL?{video:selected.videoURL}:{image:selected.images[0]};
    const c=product.localized||{};
    const version={videoEngine:2,source,id:product.id,title:c.title,description:c.description,hook:c.hook,benefits:c.benefits,
      scriptModel:this.cfg.videoScriptModel||'gpt-4o-mini',ttsModel:this.cfg.videoTtsModel||'gpt-4o-mini-tts',voice:this.cfg.videoTtsVoice||'coral'};
    const key=hash(version),output=join(dir,key+'.mp4'),scriptPath=join(dir,key+'.script.txt'),speechPath=join(dir,key+'.speech.mp3');
    let script,speech;
    try{script=(await readFile(scriptPath,'utf8')).trim();}catch{}
    try{speech=await readFile(speechPath);}catch{}
    try{await stat(output);log('AI_VIDEO_READY',{productId:product.id,videoURL:this.url(key),voiceover:true,cached:true});return {format:'reels',videoURL:this.url(key),imageURLs:[],videoScript:script||null,voiceover:true};}catch{}
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
      const duration=Math.max(6,Math.min(Number(this.cfg.videoMaxDurationSec||20),voiceDuration+0.15));
      await writeFile(join(tmp,'hook.txt'),plain(c.hook||c.title,80).match(/.{1,32}(?:\s|$)|.{1,32}/g)?.map(x=>x.trim()).join('\n')||'', 'utf8');
      await writeFile(join(tmp,'captions.srt'),makeCaptions(script,duration),'utf8');
      const hook=`drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf:textfile=hook.txt:expansion=none:fontsize=30:fontcolor=white:box=1:boxcolor=black@0.68:boxborderw=12:x=(w-tw)/2:y=70:enable='lt(t,3)'`;
      const subs=`subtitles=captions.srt:fontsdir=/usr/share/fonts/truetype/dejavu:force_style='FontName=DejaVu Sans,FontSize=20,Bold=1,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BorderStyle=1,Outline=2,Shadow=1,Alignment=2,MarginV=180'`;
      const vfBase=`scale=720:1280:force_original_aspect_ratio=decrease,pad=720:1280:(ow-iw)/2:(oh-ih)/2:color=0x151515,setsar=1,fps=30,${subs},${hook}`;
      const frames=Math.ceil(duration*30);
      const args=['-hide_banner','-loglevel','error','-y'];
      if(selected.videoURL) {
        await downloadMedia(selected.videoURL,join(tmp,'source.mp4'),this.cfg.mediaHosts,this.cfg.fetchImpl||fetch);
        const info=JSON.parse(await run('/usr/bin/ffprobe',['-v','error','-show_format','-of','json',join(tmp,'source.mp4')]));
        if(Number(info.format?.duration)<2||!Number.isFinite(Number(info.format?.duration)))fail('VIDEO_TOO_SHORT');
        args.push('-stream_loop','-1','-i',join(tmp,'source.mp4'),'-i',speechPath,'-map','0:v:0','-map','1:a:0','-t',String(duration),'-vf',vfBase);
      } else {
        await downloadMedia(selected.images[0],join(tmp,'source.jpg'),this.cfg.mediaHosts,this.cfg.fetchImpl||fetch,15*1024*1024);
        const zoom=`scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280,zoompan=z='min(zoom+0.0007,1.06)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=720x1280:fps=30,${subs},${hook}`;
        args.push('-i',join(tmp,'source.jpg'),'-i',speechPath,'-map','0:v:0','-map','1:a:0','-t',String(duration),'-vf',zoom);
      }
      args.push('-threads','1','-filter_threads','1','-filter_complex_threads','1',
        '-c:v','libx264','-preset','fast','-crf','24','-pix_fmt','yuv420p',
        '-c:a','aac','-b:a','128k','-movflags','+faststart',join(tmp,'out.mp4'));
      await encode(args,tmp,240000);
      await rename(join(tmp,'out.mp4'),output);
      log('AI_VIDEO_READY',{productId:product.id,videoURL:this.url(key),voiceover:true,cached:false,duration});
      return {format:'reels',videoURL:this.url(key),imageURLs:[],videoScript:script,voiceover:true};
    } finally {await rm(tmp,{recursive:true,force:true});}
  }
  async carousel(images) {
    const dir=join(this.cfg.dataDir,'assets');await mkdir(dir,{recursive:true});
    const balanced=this.cfg.organicPolicy==='balanced-v1',photos=[];
    for(const image of [...new Set(images)].slice(0,balanced?6:10)) {
      const key=carouselAssetKey(image);const dest=join(dir,key+'.jpg');
      try {await stat(dest);} catch {
        const tmp=await mkdtemp(join(dir,'photo-'));
        try {
          await downloadMedia(image,join(tmp,'input'),this.cfg.mediaHosts,this.cfg.fetchImpl||fetch,15*1024*1024);
          await run('/usr/bin/ffmpeg',['-hide_banner','-loglevel','error','-y','-i',join(tmp,'input'),
            '-vf','scale=1080:1350:force_original_aspect_ratio=decrease,pad=1080:1350:(ow-iw)/2:(oh-ih)/2:color=white,setsar=1',
            '-frames:v','1','-threads','1','-filter_threads','1','-q:v','3',join(tmp,'image.jpg')]);
          const info=await stat(join(tmp,'image.jpg'));if(info.size>8*1024*1024)fail('INSTAGRAM_IMAGE_TOO_LARGE');
          await rename(join(tmp,'image.jpg'),dest);
        } finally {await rm(tmp,{recursive:true,force:true});}
      }
      let words=null;
      if(balanced){
        const assessment=join(dir,key+'.ocr-v1.json');
        try{words=JSON.parse(await readFile(assessment,'utf8')).words;}catch{
          try{
            const tsv=await run('/usr/bin/tesseract',[dest,'stdout','-l','eng','--psm','11','tsv'],15000);
            words=tsv.split('\n').slice(1).filter(line=>{
              const cells=line.split('\t');return cells[0]==='5' && Number(cells[10])>=40 && /[\p{L}\p{N}]/u.test(cells[11]||'');
            }).length;
            await writeFile(assessment,JSON.stringify({words}),'utf8');
          }catch{ /* Missing OCR never blocks an otherwise usable product photograph. */ }
        }
      }
      photos.push({url:`${this.cfg.publicOrigin}/marketing-assets/${key}.jpg`,words});
    }
    const urls=balanced?selectPhotos(photos):photos.map(p=>p.url);
    if(!urls.length)fail('NO_MARKETING_MEDIA');
    return {format:urls.length>1?'carousel':'image',videoURL:null,imageURLs:urls};
  }
  url(key){return `${this.cfg.publicOrigin}/marketing-assets/${key}.mp4`;}
}


