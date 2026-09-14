const fs=require('fs');
const p='server.js';
let s=fs.readFileSync(p,'utf8');
if(s.includes('HOMESTRO_AUTOPILOT_ENABLED')){console.log('autopilot already installed');process.exit(0);}
const marker='\napp.listen(';
const idx=s.indexOf(marker);
if(idx<0) throw new Error('app.listen marker not found');
const code=`
// HOMESTRO_AUTOPILOT_ENABLED: autonomous Shopify catalog processor
const autopilot={running:false,startedAt:null,lastRun:null,lastError:null,processed:0,rejected:0,failed:0};
function autopilotInterval(){const n=Number(process.env.HOMESTRO_AUTOPILOT_INTERVAL_MS||300000);return Number.isFinite(n)&&n>=60000?n:300000;}
async function autopilotListProducts(token){
  const all=[]; let after=null;
  do{
    const q='query($after:String){products(first:100,after:$after){nodes{id title descriptionHtml handle status vendor productType tags variants(first:100){nodes{id title price sku selectedOptions{name value} inventoryItem{unitCost{amount currencyCode}} image{id url altText}}}media(first:20){nodes{... on MediaImage{id image{url altText}}}} seo{title description}} pageInfo{hasNextPage endCursor}}}';
    const d=await shopifyGraphQL(q,{after},token); all.push(...d.products.nodes); after=d.products.pageInfo.hasNextPage?d.products.pageInfo.endCursor:null;
  }while(after);
  return all;
}
async function autopilotUpdateProduct(product,ai,token){
  const x=ai.product||{};
  const input={id:product.id};
  if(x.title) input.title=String(x.title).slice(0,255);
  if(x.description) input.descriptionHtml=String(x.description);
  if(x.category) input.productType=String(x.category).slice(0,255);
  if(Array.isArray(x.tags)&&x.tags.length) input.tags=[...new Set(x.tags.map(String).filter(Boolean))];
  if(x.seoTitle||x.seoDescription) input.seo={title:String(x.seoTitle||'').slice(0,70),description:String(x.seoDescription||'').slice(0,320)};
  const d=await shopifyGraphQL('mutation($input:ProductInput!){productUpdate(input:$input){product{id title status handle productType tags seo{title description}}userErrors{field message}}}',{input},token);
  const errs=d.productUpdate.userErrors||[];
  if(errs.length) throw new Error('Shopify productUpdate: '+errs.map(e=>e.message).join('; '));
  return d.productUpdate.product;
}
async function autopilotMark(product,status,token){
  const tags=(product.tags||[]).filter(t=>!/^homestro-ai-(processed|rejected|failed)$/i.test(t));
  tags.push('homestro-ai-'+status);
  await shopifyGraphQL('mutation($input:ProductInput!){productUpdate(input:$input){userErrors{message}}}',{input:{id:product.id,tags:[...new Set(tags)]}},token);
}
function autopilotQualification(product){
  const variants=product.variants?.nodes||[]; const r=rules();
  if(!variants.length) return {valid:false,reason:'no variants'};
  const checks=variants.map(v=>{const price=Number(v.price),cost=Number(v.inventoryItem?.unitCost?.amount),ratio=cost>0?price/cost:NaN;return {id:v.id,price,cost,ratio,valid:Number.isFinite(price)&&Number.isFinite(cost)&&cost<=r.maxCost&&price>=r.minSellingPrice&&ratio>=r.minRatio};});
  const valid=checks.length>0&&checks.every(x=>x.valid);
  return {valid,reason:valid?'ok':'one or more variants fail Homestro rules',variants:checks};
}
async function autopilotRun(){
  if(autopilot.running)return {skipped:true,reason:'already running'};
  autopilot.running=true;autopilot.startedAt=new Date().toISOString();autopilot.lastError=null;
  try{
    const token=await getClientToken(); const products=await autopilotListProducts(token);
    let processed=0,rejected=0,failed=0;
    for(const product of products){
      const tags=product.tags||[];
      if(tags.some(t=>/^homestro-ai-(processed|rejected)$/i.test(t)))continue;
      try{
        const q=autopilotQualification(product);
        if(!q.valid){await autopilotMark(product,'rejected',token);rejected++;continue;}
        const input={id:product.id,title:product.title,description:product.descriptionHtml,productType:product.productType,tags:product.tags,variants:q.variants.map(v=>({id:v.id,price:v.price,cost:v.cost,ratio:v.ratio})),image_urls:(product.media?.nodes||[]).map(m=>m.image?.url).filter(Boolean)};
        const ai=await aiProduct(input);
        await autopilotUpdateProduct(product,ai,token);
        await autopilotMark(product,'processed',token); processed++;
      }catch(e){failed++;console.error('Autopilot product failed',product.id,e.message);}
      await new Promise(r=>setTimeout(r,1200));
    }
    autopilot.processed+=processed;autopilot.rejected+=rejected;autopilot.failed+=failed;autopilot.lastRun=new Date().toISOString();
    return {ok:true,total:products.length,processed,rejected,failed};
  }catch(e){autopilot.lastError=e.message;autopilot.lastRun=new Date().toISOString();console.error('Autopilot run failed',e);return {ok:false,error:e.message};}
  finally{autopilot.running=false;}
}
app.get('/api/automation/status',apiKey,(_q,res)=>res.json({ok:true,enabled:process.env.HOMESTRO_AUTOPILOT_ENABLED!=='false',intervalMs:autopilotInterval(),running:autopilot.running,lastRun:autopilot.lastRun,lastError:autopilot.lastError,totals:{processed:autopilot.processed,rejected:autopilot.rejected,failed:autopilot.failed}}));
app.post('/api/automation/run',apiKey,async(_q,res)=>{res.json(await autopilotRun());});
if(process.env.HOMESTRO_AUTOPILOT_ENABLED!=='false'){
  setTimeout(()=>autopilotRun().catch(e=>console.error('Initial autopilot error',e)),15000);
  setInterval(()=>autopilotRun().catch(e=>console.error('Scheduled autopilot error',e)),autopilotInterval());
}
`;
s=s.slice(0,idx)+code+s.slice(idx);
fs.writeFileSync(p,s);
console.log('autopilot installed');
