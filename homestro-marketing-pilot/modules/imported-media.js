import {createHash,randomUUID} from 'node:crypto';
import {mkdir,mkdtemp,readFile,writeFile,rename,rm,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {hash,fail,productURL} from './core.js';
import {compilePost} from './localization.js';
import {prepareSocial,eligible,publicPostURL} from './social.js';

const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const canonical=raw=>decodeURIComponent(productURL(raw).pathname).replace(/\/$/,'');
export function importMetadata(encoded,bytes){
  if(typeof encoded!=='string'||encoded.length>8000||!Buffer.isBuffer(bytes)||!bytes.length||bytes.length>100*1024*1024)fail('INVALID_MEDIA_IMPORT');
  let value;try{value=JSON.parse(Buffer.from(encoded,'base64').toString('utf8'));}catch{fail('INVALID_MEDIA_IMPORT');}
  if(!value||typeof value!=='object'||value.provider!=='higgsfield'||!['image','video'].includes(value.kind)||
    !/^[a-f0-9-]{36}$/.test(value.job_id||'')||!/^[a-f0-9]{64}$/.test(value.sha256||'')||sha(bytes)!==value.sha256)fail('MEDIA_IMPORT_CHECKSUM_OR_ID_INVALID');
  canonical(value.product_url);
  return {provider:'higgsfield',job_id:value.job_id,kind:value.kind,sha256:value.sha256,product_url:value.product_url};
}
function command(bin,args){
  return new Promise((resolve,reject)=>{
    const child=spawn(bin,args,{stdio:['ignore','pipe','ignore']});let out='',settled=false;
    const finish=error=>{if(settled)return;settled=true;clearTimeout(timer);error?reject(error):resolve(out);};
    const timer=setTimeout(()=>{child.kill('SIGKILL');finish(new Error('MEDIA_TIMEOUT'));},45000);
    child.stdout.on('data',b=>{out+=b;if(out.length>1024*1024){child.kill('SIGKILL');finish(new Error('MEDIA_PROBE_LIMIT'));}});
    child.once('error',()=>finish(new Error('MEDIA_BINARY_MISSING')));
    child.once('close',code=>finish(code===0?null:new Error('MEDIA_ENCODING_FAILED')));
  });
}
export function importedAssetKey(metadata){return hash({importedMediaVersion:1,sha256:metadata.sha256,kind:metadata.kind});}
export async function normalizeImported(metadata,bytes,cfg){
  const dir=join(cfg.dataDir,'assets');await mkdir(dir,{recursive:true});
  const key=importedAssetKey(metadata),ext=metadata.kind==='image'?'jpg':'mp4',dest=join(dir,key+'.'+ext);
  const origin=new URL(cfg.publicOrigin);if(origin.protocol!=='https:'||origin.username||origin.password)fail('PUBLIC_MEDIA_ORIGIN_REQUIRED');
  const sourceDir=join(cfg.dataDir,'import-sources');await mkdir(sourceDir,{recursive:true});
  const source=join(sourceDir,metadata.sha256+'.bin');
  try{if(sha(await readFile(source))!==metadata.sha256)fail('IMPORTED_SOURCE_CORRUPTED');}
  catch(e){if(e.code!=='ENOENT')throw e;const tmp=await mkdtemp(join(sourceDir,'source-'));try{await writeFile(join(tmp,'source'),bytes);await rename(join(tmp,'source'),source);}finally{await rm(tmp,{recursive:true,force:true});}}
  const temp=await mkdtemp(join(dir,'import-normalize-'));
  try{
    let info;try{info=JSON.parse(await command('/usr/bin/ffprobe',['-v','error','-protocol_whitelist','file','-show_streams','-of','json',source]));}catch{fail('IMPORTED_MEDIA_PROBE_FAILED');}
    const video=info.streams?.filter(s=>s.codec_type==='video')||[];
    if(video.length!==1)fail('IMPORTED_MEDIA_PROBE_FAILED');
    const v=video[0],pixels=Number(v.width)*Number(v.height);
    if(!(pixels>0&&pixels<=40000000))fail('IMPORTED_MEDIA_PIXEL_LIMIT');
    const duration=Number(v.duration);
    if(metadata.kind==='image'){
      if(!['png','mjpeg','webp'].includes(v.codec_name)||bytes.length>15*1024*1024)fail('IMPORTED_IMAGE_FORMAT_INVALID');
      try{if((await stat(dest)).size>0)return {format:'image',imageURLs:[origin.origin+'/marketing-assets/'+key+'.jpg'],videoURL:null,fileSha256:sha(await readFile(dest))};}catch{}
      await command('/usr/bin/ffmpeg',['-hide_banner','-loglevel','error','-protocol_whitelist','file','-y','-i',source,
        '-vf','scale=1080:1350:force_original_aspect_ratio=decrease,pad=1080:1350:(ow-iw)/2:(oh-ih)/2:color=white,setsar=1',
        '-frames:v','1','-threads','1','-filter_threads','1','-q:v','3',join(temp,'output.jpg')]);
      if((await stat(join(temp,'output.jpg'))).size>8*1024*1024)fail('IMPORTED_IMAGE_TOO_LARGE');
      await rename(join(temp,'output.jpg'),dest);
    }else{
      if(v.codec_name!=='h264'||!Number.isFinite(duration)||duration<3||duration>90||
        !['yuv420p','yuvj420p'].includes(v.pix_fmt)||Math.abs(v.width/v.height-9/16)>0.01)fail('IMPORTED_VIDEO_NOT_PUBLICATION_READY');
      if(info.streams.some(s=>!['video','audio'].includes(s.codec_type)||s.codec_type==='audio'&&s.codec_name!=='aac'))fail('IMPORTED_VIDEO_NOT_PUBLICATION_READY');
      try{if((await stat(dest)).size>0)return {format:'reels',imageURLs:[],videoURL:origin.origin+'/marketing-assets/'+key+'.mp4',fileSha256:sha(await readFile(dest))};}catch{}
      await writeFile(join(temp,'output.mp4'),bytes);await rename(join(temp,'output.mp4'),dest);
    }
  }finally{await rm(temp,{recursive:true,force:true});}
  return {format:metadata.kind==='image'?'image':'reels',imageURLs:metadata.kind==='image'?[origin.origin+'/marketing-assets/'+key+'.jpg']:[],
    videoURL:metadata.kind==='video'?origin.origin+'/marketing-assets/'+key+'.mp4':null,fileSha256:sha(await readFile(dest))};
}
export function importedPost(product,channel,asset,cfg,metadata,providerCfg){
  if(!eligible(product,cfg)||!product.localized)fail('IMPORTED_PRODUCT_NOT_READY');
  const p={...product,asset};
  const payload=['tiktok','pinterest'].includes(channel)?prepareSocial(p,channel,{...cfg,...providerCfg}):compilePost(p,channel,asset,cfg);
  return {...payload,importedMedia:true,importedJobId:metadata.job_id,assetSha256:metadata.sha256,requiresVisualReview:true};
}
export function validateImportedReview(job,body){
  if(job.payload.importedMedia!==true)return;
  if(body.content_preview_confirmed!==true||body.expectedRevision!==job.revision||body.assetSha256!==job.payload.assetSha256)fail('IMPORTED_VISUAL_REVIEW_REQUIRED');
}
export class ImportedMediaCoordinator{
  constructor({pool,cfg,fresh,social}){Object.assign(this,{pool,cfg,fresh,social});}
  async migrate(){await this.pool.query(`CREATE TABLE IF NOT EXISTS marketing_imported_media(
    job_id text PRIMARY KEY,checksum text NOT NULL,product_id text NOT NULL REFERENCES marketing_products(id),
    product_revision text NOT NULL,metadata jsonb NOT NULL,asset jsonb,state text NOT NULL,
    receipt jsonb NOT NULL DEFAULT '{}',created_at timestamptz NOT NULL DEFAULT now())`);}
  async receive(metadata,bytes){
    metadata=importMetadata(Buffer.from(JSON.stringify(metadata)).toString('base64'),bytes);
    return this.receiveValidated(metadata,bytes);
  }
  async receiveGenerated(metadata,bytes){
    // Internal-only handoff: the public import route still accepts Higgsfield only.
    if(metadata?.provider!=='runway'||metadata.kind!=='video'||!Buffer.isBuffer(bytes)||!bytes.length||bytes.length>100*1024*1024||
      !/^[a-f0-9-]{36}$/.test(metadata.job_id||'')||!/^[a-f0-9]{64}$/.test(metadata.generation_job_key||'')||sha(bytes)!==metadata.sha256)fail('GENERATED_HANDOFF_IDENTITY_INVALID');
    const job=(await this.pool.query('SELECT * FROM marketing_generated_videos WHERE job_key=$1',[metadata.generation_job_key])).rows[0];
    if(!job||!['handoff_pending','queued'].includes(job.state)||job.task_id!==metadata.job_id||job.product_id!==metadata.product_id||
      job.revision!==metadata.product_revision||job.video_url!==metadata.source_video_url||job.handoff?.sha256!==metadata.sha256||
      job.review?.content_preview_confirmed!==true||job.review?.product_fidelity_confirmed!==true||
      job.review?.expectedRevision!==job.revision||job.review?.expectedTaskId!==job.task_id||job.review?.expectedVideoURL!==job.video_url||
      typeof job.review?.reviewer!=='string'||!job.review.reviewer.trim()||job.review.reviewer.length>100)fail('GENERATED_VISUAL_REVIEW_REQUIRED');
    return this.receiveValidated(metadata,bytes);
  }
  async receiveValidated(metadata,bytes){
    const client=await this.pool.connect();let locked=false;
    try{
      locked=(await client.query('SELECT pg_try_advisory_lock(73341017) AS locked')).rows[0]?.locked;
      if(!locked)fail('MEDIA_IMPORT_BUSY');
      const old=(await client.query('SELECT * FROM marketing_imported_media WHERE job_id=$1',[metadata.job_id])).rows[0];
      if(old){
        if(old.checksum!==metadata.sha256||old.metadata.provider!==metadata.provider||old.metadata.kind!==metadata.kind||
          (metadata.provider==='runway'&&(old.metadata.generation_job_key!==metadata.generation_job_key||old.metadata.source_video_url!==metadata.source_video_url))||canonical(old.metadata.product_url)!==canonical(metadata.product_url))fail('MEDIA_IMPORT_IDENTITY_CONFLICT');
        if(old.state==='queued')return {...old.receipt,idempotentReplay:true};
      }
      const rows=(await client.query("SELECT document,status FROM marketing_products WHERE status='ready' AND document->>'status'='ACTIVE' LIMIT 5000")).rows;
      const matches=rows.filter(r=>{try{return canonical(r.document.url)===canonical(metadata.product_url);}catch{return false;}});
      if(matches.length!==1)fail('IMPORTED_PRODUCT_NOT_READY');
      const current=await this.fresh(matches[0].document.id);
      if(!eligible(current,this.cfg)||current.revision!==matches[0].document.revision)fail('IMPORTED_PRODUCT_NOT_READY');
      if(metadata.provider==='runway'&&(current.id!==metadata.product_id||current.revision!==metadata.product_revision))fail('IMPORTED_SOURCE_CHANGED_REVIEW_REQUIRED');
      const product={...current,localized:matches[0].document.localized};
      if(!product.localized)fail('IMPORTED_PRODUCT_NOT_READY');
      if(old&&old.product_revision!==product.revision)fail('IMPORTED_SOURCE_CHANGED_REVIEW_REQUIRED');
      await client.query(`INSERT INTO marketing_imported_media(job_id,checksum,product_id,product_revision,metadata,state)
        VALUES($1,$2,$3,$4,$5,'receiving') ON CONFLICT DO NOTHING`,[metadata.job_id,metadata.sha256,product.id,product.revision,metadata]);
      const asset=await normalizeImported(metadata,bytes,this.cfg),posts=[];
      const channels=['facebook','instagram',...Object.keys(this.social?.providerCfg?.accounts||{})];
      await client.query('BEGIN');
      try{
        for(const channel of channels){
          const payload=importedPost(product,channel,asset,this.cfg,metadata,this.social?.providerCfg),revision=hash(payload);
          const table=['facebook','instagram'].includes(channel)?'marketing_posts':'marketing_social_posts';
          await client.query(`INSERT INTO ${table}(id,product_id,channel,revision,payload,status)
            VALUES($1,$2,$3,$4,$5,'draft_queued') ON CONFLICT(product_id,channel,revision) DO NOTHING`,[randomUUID(),product.id,channel,revision,payload]);
          const row=(await client.query(`SELECT id,status FROM ${table} WHERE product_id=$1 AND channel=$2 AND revision=$3`,[product.id,channel,revision])).rows[0];
          if(!row)fail('MEDIA_QUEUE_RECEIPT_UNCONFIRMED');
          posts.push({id:row.id,channel,status:row.status,revision});
        }
        const receipt={job_id:metadata.job_id,sha256:metadata.sha256,product_id:product.id,product_revision:product.revision,
          state:'draft_queued',posts,requires_visual_review:true,publication_confirmed:false,generation_performed:false};
        await client.query("UPDATE marketing_imported_media SET state='queued',asset=$2,receipt=$3 WHERE job_id=$1",[metadata.job_id,asset,receipt]);
        await client.query('COMMIT');return receipt;
      }catch(e){await client.query('ROLLBACK');throw e;}
    }finally{if(locked)await client.query('SELECT pg_advisory_unlock(73341017)').catch(()=>{});client.release();}
  }
  async status(job){
    if(!/^[a-f0-9-]{36}$/.test(job))fail('INVALID_MEDIA_JOB');
    const row=(await this.pool.query('SELECT receipt,state FROM marketing_imported_media WHERE job_id=$1',[job])).rows[0];
    if(!row)return {state:'not_found',publication_confirmed:false};
    const posts=[];
    for(const original of row.receipt.posts||[]){
      const table=['facebook','instagram'].includes(original.channel)?'marketing_posts':'marketing_social_posts';
      const current=(await this.pool.query(`SELECT id,status,remote,payload FROM ${table} WHERE id=$1`,[original.id])).rows[0];
      if(current)posts.push({id:current.id,channel:original.channel,status:current.status,requires_visual_review:current.payload?.requiresVisualReview===true,
        permalink:publicPostURL(current.remote?.permalink||'',original.channel)});
    }
    return {...row.receipt,state:row.state,posts,requires_visual_review:posts.some(p=>p.requires_visual_review),publication_confirmed:posts.some(p=>p.status==='published'&&p.permalink)};
  }
  async ensure(job,source){
    if(job.payload.requiresVisualReview)fail('IMPORTED_VISUAL_REVIEW_REQUIRED');
    const row=(await this.pool.query('SELECT * FROM marketing_imported_media WHERE job_id=$1',[job.payload.importedJobId])).rows[0];
    if(!row||row.product_id!==source.id||row.product_revision!==source.revision||row.checksum!==job.payload.assetSha256)fail('IMPORTED_SOURCE_CHANGED_REVIEW_REQUIRED');
    const sourceBytes=await readFile(join(this.cfg.dataDir,'import-sources',row.checksum+'.bin'));
    if(sha(sourceBytes)!==row.checksum)fail('IMPORTED_SOURCE_CORRUPTED');
    const asset=await normalizeImported(row.metadata,sourceBytes,this.cfg);
    if(asset.fileSha256!==row.asset.fileSha256)fail('IMPORTED_NORMALIZED_MEDIA_CORRUPTED');
    if(JSON.stringify(asset.imageURLs)!==JSON.stringify(job.payload.imageURLs)||asset.videoURL!==job.payload.videoURL)fail('IMPORTED_ASSET_PAYLOAD_CHANGED');
  }
}
