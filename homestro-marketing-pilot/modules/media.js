import {mkdir,mkdtemp,readFile,writeFile,rename,rm,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {hash,fail} from './core.js';

export function extractMedia(nodes=[]) {
  const videos=nodes.filter(n=>n.mediaContentType==='VIDEO' && n.status==='READY')
    .flatMap(n=>[n.originalSource,...(n.sources||[])].filter(Boolean))
    .filter(s=>s.mimeType==='video/mp4' || String(s.format).toLowerCase()==='mp4')
    .sort((a,b)=>(b.width||0)*(b.height||0)-(a.width||0)*(a.height||0));
  const images=[...new Set(nodes.filter(n=>n.mediaContentType==='IMAGE' && n.status==='READY').map(n=>n.image?.url).filter(Boolean))];
  return {videoURL:videos[0]?.url||null,images};
}
function run(bin,args,timeout=120000) {
  return new Promise((resolve,reject)=>{
    const c=spawn(bin,args,{stdio:['ignore','pipe','pipe']});let out='',done=false;
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
export class MediaRenderer {
  constructor(cfg) {this.cfg=cfg;}
  async render(product) {
    const selected=extractMedia(product.media);
    if(!selected.videoURL && !selected.images.length) fail('NO_MARKETING_MEDIA');
    if(!selected.videoURL) return this.carousel(selected.images);
    const key=hash({media:selected,hook:product.localized.hook,renderVersion:1});
    const dir=join(this.cfg.dataDir,'assets');await mkdir(dir,{recursive:true});
    const output=join(dir,key+'.mp4');
    try {await stat(output);return {format:'reels',videoURL:this.url(key),imageURLs:[]};} catch{}
    const tmp=await mkdtemp(join(dir,'render-'));
    try {
      // Text file prevents shell/ffmpeg filter injection from generated copy.
      const wrapped=product.localized.hook.match(/.{1,32}(?:\s|$)|.{1,32}/g)?.map(x=>x.trim()).join('\n')||'';
      await writeFile(join(tmp,'hook.txt'),wrapped,'utf8');
      const hook=`drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf:textfile=hook.txt:expansion=none:fontsize=32:fontcolor=white:box=1:boxcolor=black@0.7:boxborderw=12:x=(w-tw)/2:y=70:enable='lt(t,3)'`;
      const vf=`scale=720:1280:force_original_aspect_ratio=decrease,pad=720:1280:(ow-iw)/2:(oh-ih)/2:color=0x151515,setsar=1,fps=30,${hook}`;
      const args=['-hide_banner','-loglevel','error','-y'];
      await downloadMedia(selected.videoURL,join(tmp,'source.mp4'),this.cfg.mediaHosts);
      const probe=JSON.parse(await run('ffprobe',['-v','error','-show_format','-of','json',join(tmp,'source.mp4')]));
      if(Number(probe.format?.duration)<4 || !Number.isFinite(Number(probe.format?.duration))) fail('VIDEO_TOO_SHORT');
      args.push('-i',join(tmp,'source.mp4'),'-t','30','-vf',vf,'-an');
      args.push('-threads','1','-filter_threads','1','-filter_complex_threads','1',
        '-c:v','libx264','-preset','fast','-crf','24','-pix_fmt','yuv420p','-movflags','+faststart',join(tmp,'out.mp4'));
      // drawtext file resolved under the temp directory, never from a shell.
      await new Promise((resolve,reject)=>{
        const c=spawn('ffmpeg',args,{cwd:tmp,stdio:'ignore'});
        const timer=setTimeout(()=>c.kill('SIGKILL'),180000);
        c.once('error',()=>{clearTimeout(timer);reject(new Error('FFMPEG_MISSING'));});
        c.once('close',code=>{clearTimeout(timer);code===0?resolve():reject(new Error('ENCODING_FAILED'));});
      });
      await rename(join(tmp,'out.mp4'),output);
      return {format:'reels',videoURL:this.url(key),imageURLs:[]};
    } finally {await rm(tmp,{recursive:true,force:true});}
  }
  async carousel(images) {
    const dir=join(this.cfg.dataDir,'assets');await mkdir(dir,{recursive:true});
    const urls=[];
    for(const image of [...new Set(images)].slice(0,10)) {
      const key=hash({image,imageRendererVersion:1});const dest=join(dir,key+'.jpg');
      try {await stat(dest);} catch {
        const tmp=await mkdtemp(join(dir,'photo-'));
        try {
          await downloadMedia(image,join(tmp,'input'),this.cfg.mediaHosts,fetch,15*1024*1024);
          // JPEG, consistent 4:5 frame, preserve entire product with padding. No video encoding.
          await run('ffmpeg',['-hide_banner','-loglevel','error','-y','-i',join(tmp,'input'),
            '-vf','scale=1080:1350:force_original_aspect_ratio=decrease,pad=1080:1350:(ow-iw)/2:(oh-ih)/2:color=white,setsar=1',
            '-frames:v','1','-threads','1','-filter_threads','1','-q:v','3',join(tmp,'image.jpg')]);
          const info=await stat(join(tmp,'image.jpg'));if(info.size>8*1024*1024)fail('INSTAGRAM_IMAGE_TOO_LARGE');
          await rename(join(tmp,'image.jpg'),dest);
        } finally {await rm(tmp,{recursive:true,force:true});}
      }
      urls.push(`${this.cfg.publicOrigin}/marketing-assets/${key}.jpg`);
    }
    if(!urls.length)fail('NO_MARKETING_MEDIA');
    return {format:urls.length>1?'carousel':'image',videoURL:null,imageURLs:urls};
  }
  url(key){return `${this.cfg.publicOrigin}/marketing-assets/${key}.mp4`;}
}
