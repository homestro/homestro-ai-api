import {createHash} from 'node:crypto';
import {mkdir,readFile,writeFile,rename,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {fail,productURL} from './core.js';

const checksum=bytes=>createHash('sha256').update(bytes).digest('hex');
const LIMIT=100*1024*1024;
export function generatedReview(job,body){
  if(!body||body.content_preview_confirmed!==true||body.product_fidelity_confirmed!==true||
    body.expectedRevision!==job.revision||body.expectedTaskId!==job.task_id||body.expectedVideoURL!==job.video_url||
    typeof body.reviewer!=='string'||!body.reviewer.trim()||body.reviewer.trim().length>100)fail('GENERATED_VISUAL_REVIEW_REQUIRED');
  return {reviewer:body.reviewer.trim(),expectedRevision:job.revision,expectedTaskId:job.task_id,
    expectedVideoURL:job.video_url,content_preview_confirmed:true,product_fidelity_confirmed:true,
    reviewedAt:new Date().toISOString(),productFidelityIsHumanAttestation:true,tiktokConsentTransferred:false};
}
export async function downloadGeneratedVideo(raw,{fetchImpl=fetch,maxBytes=LIMIT}={}){
  let url;try{url=new URL(raw);}catch{fail('UNTRUSTED_GENERATED_DOWNLOAD');}
  // Only provider output CDNs. Never send provider credentials to an output host.
  const trusted=url.hostname==='cdn.runwayml.com'||url.hostname.endsWith('.runwayml.com')||url.hostname.endsWith('.cloudfront.net');
  if(!trusted||url.protocol!=='https:'||url.username||url.password||url.hash||(url.port&&url.port!=='443'))fail('UNTRUSTED_GENERATED_DOWNLOAD');
  if(!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>LIMIT)fail('GENERATED_DOWNLOAD_LIMIT_INVALID');
  const response=await fetchImpl(url.href,{method:'GET',redirect:'error',signal:AbortSignal.timeout(45000),
    headers:{Accept:'video/mp4,application/octet-stream'}});
  if(!response.ok||response.redirected)fail('GENERATED_DOWNLOAD_FAILED');
  const type=String(response.headers.get('content-type')||'').split(';')[0].trim().toLowerCase();
  if(!['video/mp4','application/octet-stream'].includes(type))fail('GENERATED_DOWNLOAD_TYPE_INVALID');
  const length=response.headers.get('content-length');
  if(length&&(!/^\d+$/.test(length)||Number(length)>maxBytes))fail('GENERATED_DOWNLOAD_SIZE_LIMIT');
  if(!response.body)fail('GENERATED_DOWNLOAD_EMPTY');
  const reader=response.body.getReader(),chunks=[];let total=0;
  try{
    for(;;){const {done,value}=await reader.read();if(done)break;total+=value.byteLength;
      if(total>maxBytes){await reader.cancel();fail('GENERATED_DOWNLOAD_SIZE_LIMIT');}chunks.push(Buffer.from(value));}
  }finally{reader.releaseLock();}
  if(!total)fail('GENERATED_DOWNLOAD_EMPTY');
  return Buffer.concat(chunks,total);
}
const queued=(job,receipt)=>({jobKey:job.job_key,taskId:job.task_id,state:'queued',queueReceipt:receipt,
  generationPerformed:false,newPaidRequestPerformed:false,publicationConfirmed:false,
  requiresChannelReview:true,tiktokConsentTransferred:false,
  note:'Product fidelity is a human review attestation. Native channel previews and approvals remain required.'});
export async function handoffGeneratedVideo({pool,cfg,fresh,fetchImpl=fetch,key,body,importedMedia}){
  if(!/^[a-f0-9]{64}$/.test(key||''))fail('INVALID_GENERATIVE_JOB');
  if(!importedMedia?.receiveGenerated||!importedMedia?.status)fail('MEDIA_IMPORT_NOT_CONFIGURED');
  const client=await pool.connect();let locked=false;
  try{
    locked=(await client.query('SELECT pg_try_advisory_lock(73341018) AS locked')).rows[0]?.locked;
    if(!locked)fail('GENERATED_HANDOFF_BUSY');
    const job=(await client.query('SELECT * FROM marketing_generated_videos WHERE job_key=$1',[key])).rows[0];
    if(!job)fail('GENERATIVE_JOB_NOT_FOUND');
    if(!['review_required','handoff_pending','queued'].includes(job.state)||!/^[a-f0-9-]{36}$/.test(job.task_id||'')||!job.video_url)fail('GENERATED_VIDEO_NOT_COMPLETED');
    const review=generatedReview(job,body);
    const product=await fresh(job.product_id);
    if(product.id!==job.product_id||product.status!=='ACTIVE'||product.rejected||product.revision!==job.revision)fail('SOCIAL_REVIEW_STALE');
    productURL(product.url);
    // A retry checks durable queue receipts before touching the CDN again.
    if(job.handoff?.sha256){
      const receipt=await importedMedia.status(job.task_id);
      if(receipt.state==='queued'&&receipt.sha256===job.handoff.sha256&&receipt.product_id===job.product_id&&receipt.product_revision===job.revision){
        await client.query("UPDATE marketing_generated_videos SET state='queued',handoff=$2,updated_at=now() WHERE job_key=$1",
          [key,{sha256:job.handoff.sha256,receipt}]);
        return queued(job,receipt);
      }
      if(job.state==='queued')fail('GENERATED_QUEUE_RECEIPT_UNCONFIRMED');
    }
    if(!cfg.dataDir)fail('GENERATED_CACHE_NOT_CONFIGURED');
    const directory=join(cfg.dataDir,'generated-downloads');await mkdir(directory,{recursive:true});
    const file=join(directory,key+'.mp4');let bytes;
    if(job.handoff?.sha256){
      try{bytes=await readFile(file);if(bytes.length>LIMIT||checksum(bytes)!==job.handoff.sha256)fail('GENERATED_CACHE_CHECKSUM_MISMATCH');}
      catch(e){if(e.code!=='ENOENT')throw e;}
    }
    if(!bytes){
      bytes=await downloadGeneratedVideo(job.video_url,{fetchImpl});
      const temporary=file+'.partial';
      try{await writeFile(temporary,bytes,{mode:0o600});await rename(temporary,file);}
      finally{await rm(temporary,{force:true});}
    }
    const sha256=checksum(bytes);
    if(job.handoff?.sha256&&sha256!==job.handoff.sha256)fail('GENERATED_OUTPUT_CHANGED');
    await client.query("UPDATE marketing_generated_videos SET state='handoff_pending',review=$2,handoff=$3,updated_at=now() WHERE job_key=$1",
      [key,review,{sha256}]);
    const metadata={provider:'runway',job_id:job.task_id,generation_job_key:key,kind:'video',sha256,
      product_url:product.url,product_id:job.product_id,product_revision:job.revision,source_video_url:job.video_url};
    await importedMedia.receiveGenerated(metadata,bytes);
    const receipt=await importedMedia.status(job.task_id);
    if(receipt.state!=='queued'||receipt.sha256!==sha256||receipt.product_id!==job.product_id||receipt.product_revision!==job.revision||
      !Array.isArray(receipt.posts)||!receipt.posts.length)fail('GENERATED_QUEUE_RECEIPT_UNCONFIRMED');
    await client.query("UPDATE marketing_generated_videos SET state='queued',handoff=$2,updated_at=now() WHERE job_key=$1",[key,{sha256,receipt}]);
    return queued(job,receipt);
  }finally{
    if(locked)await client.query('SELECT pg_advisory_unlock(73341018)').catch(()=>{});
    client.release();
  }
}
