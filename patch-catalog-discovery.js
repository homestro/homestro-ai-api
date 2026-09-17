const fs=require('fs');
const p='server.js';
let s=fs.readFileSync(p,'utf8');
const start=s.indexOf('// HOMESTRO_CATALOG_DISCOVERY_V1');
const listen=s.indexOf('app.listen(');
if(listen<0)throw new Error('app.listen marker not found');
if(start<0)throw new Error('catalog marker not found');
const code=`
// HOMESTRO_CATALOG_DISCOVERY_V2
const catalogDiscovery={running:false,lastRun:null,lastError:null,created:0,rejected:0,failed:0,seen:new Set()};
const catalogKeywords=['home organization','kitchen storage','car cleaning','garden tools','home improvement','pet accessories','fitness accessories','baby accessories','beauty accessories','travel accessories'];
function catalogInterval(){const n=Number(process.env.HOMESTRO_CATALOG_INTERVAL_MS||300000);return Number.isFinite(n)&&n>=300000?n:300000;}
function catalogText(v){return String(v||'').replace(/<[^>]*>/g,' ').replace(/\\s+/g,' ').trim();}
function catalogNumber(v){const raw=String(v??'').replace(/[^0-9.,-]/g,'').replace(',','.');const n=Number(raw);return Number.isFinite(n)?n:NaN;}
async function catalogFetchSearch(keyword){
  const url='https://www.aliexpress.com/w/wholesale-'+encodeURIComponent(keyword).replace(/%20/g,'-')+'.html?g=y';
  const r=await fetch(url,{headers:{'User-Agent':'Mozilla/5.0 (compatible; HomestroCatalog/2.0)','Accept-Language':'en-US,en;q=0.9'},redirect:'follow'});
  const body=await r.text();
  if(!r.ok)throw new Error('AliExpress HTTP '+r.status+' '+body.slice(0,120).replace(/\\s+/g,' '));
  const html=body; const out=[]; const ids=new Set();
  const idRe=/(?:productId|product_id|productIdStr)\\s*["']?\\s*[:=]\\s*["']?(\\d{8,})/gi;
  let m;
  while((m=idRe.exec(html))&&out.length<80){
    const id=m[1]; if(ids.has(id))continue; ids.add(id);
    const a=Math.max(0,m.index-3000),b=Math.min(html.length,m.index+6000),chunk=html.slice(a,b);
    const titleM=chunk.match(/(?:productTitle|title)\\s*["']?\\s*[:=]\\s*["']([^"']{10,300})/i);
    const priceM=chunk.match(/(?:salePrice|discountPrice|price)\\s*["']?\\s*[:=]\\s*["']?([0-9]+(?:[.,][0-9]+)?)/i);
    const soldM=chunk.match(/(?:orders|sold)\\s*["']?\\s*[:=]\\s*["']?([0-9,.]+)\\+?/i);
    const imgM=chunk.match(/https?:\\/\\/[^"'\\\\ ]+\\.(?:jpg|jpeg|png|webp)/i);
    out.push({id,title:catalogText(titleM?.[1]||keyword),cost:catalogNumber(priceM?.[1]),sold:catalogNumber(soldM?.[1])||0,image_urls:imgM?[imgM[0]]:[],source_url:'https://www.aliexpress.com/item/'+id+'.html'});
  }
  console.log('CATALOG SOURCE',keyword,'items='+out.length);
  return out;
}
function catalogPass(x){const r=rules();const cost=Number(x.cost);if(!Number.isFinite(cost)||cost<3||cost>r.maxCost)return false;if(Number(x.sold||0)<1000)return false;const price=Math.max(r.minSellingPrice,Math.ceil(cost*3*100)/100);return price/cost>=r.minRatio;}
async function catalogCreate(x,token){
  const selling=Math.max(rules().minSellingPrice,Math.ceil(Number(x.cost)*3.25*100)/100);
  const ai=await aiProduct({title:x.title,description:'Source product. Use only facts that can be verified from the source page.',category:'',source_url:x.source_url,cost:x.cost,selling_price:selling,sold:x.sold});
  const p=ai.product||{}; if(!p.title)throw new Error('AI returned no title');
  return await createDraft({title:p.title,description:p.description,shortDescription:p.shortDescription,category:p.category,tags:p.tags,seoTitle:p.seoTitle,seoDescription:p.seoDescription,handle:p.handle,cost:Number(x.cost),selling_price:selling,image_urls:x.image_urls||[],source_url:x.source_url},token);
}
async function catalogDiscoveryRun(){
  if(catalogDiscovery.running)return{ok:true,skipped:true};
  catalogDiscovery.running=true;
  try{
    let token=null,created=0,rejected=0,failed=0;
    const batch=Math.max(1,Number(process.env.HOMESTRO_CATALOG_BATCH||10));
    for(const keyword of catalogKeywords){
      if(created>=batch)break;
      let items=[];
      try{items=await catalogFetchSearch(keyword);}catch(e){failed++;console.error('CATALOG SOURCE FAILED',keyword,e.message);continue;}
      for(const x of items){
        if(created>=batch)break;
        if(catalogDiscovery.seen.has(x.id))continue;
        catalogDiscovery.seen.add(x.id);
        if(!catalogPass(x)){rejected++;continue;}
        try{
          if(!token)token=await getClientToken();
          const draft=await catalogCreate(x,token);
          created++;catalogDiscovery.created++;
          console.log('CATALOG DRAFT CREATED',x.id,x.title,'shopify='+draft.id,'media='+draft.mediaCount);
        }catch(e){failed++;catalogDiscovery.failed++;console.error('CATALOG CREATE FAILED',x.id,e.message);}
      }
    }
    catalogDiscovery.rejected+=rejected;catalogDiscovery.lastRun=new Date().toISOString();catalogDiscovery.lastError=null;
    console.log('CATALOG RUN COMPLETE','created='+created,'rejected='+rejected,'failed='+failed);
    return{ok:true,created,rejected,failed,totalCreated:catalogDiscovery.created};
  }catch(e){
    catalogDiscovery.lastError=e.message;catalogDiscovery.lastRun=new Date().toISOString();
    console.error('CATALOG RUN FAILED',e.message);
    return{ok:false,error:e.message};
  }finally{catalogDiscovery.running=false;}
}
app.get('/api/catalog/status',apiKey,(_q,res)=>res.json({ok:true,enabled:process.env.HOMESTRO_CATALOG_ENABLED!=='false',intervalMs:catalogInterval(),running:catalogDiscovery.running,lastRun:catalogDiscovery.lastRun,lastError:catalogDiscovery.lastError,totals:{created:catalogDiscovery.created,rejected:catalogDiscovery.rejected,failed:catalogDiscovery.failed}}));
app.get('/health/catalog',(_q,res)=>res.json({ok:true,enabled:process.env.HOMESTRO_CATALOG_ENABLED!=='false',running:catalogDiscovery.running,lastRun:catalogDiscovery.lastRun,lastError:catalogDiscovery.lastError,totals:{created:catalogDiscovery.created,rejected:catalogDiscovery.rejected,failed:catalogDiscovery.failed}}));
app.post('/api/catalog/run',apiKey,async(_q,res)=>res.json(await catalogDiscoveryRun()));
if(process.env.HOMESTRO_CATALOG_ENABLED!=='false'){setTimeout(()=>catalogDiscoveryRun().catch(e=>console.error('CATALOG AUTO FAILED',e.message)),10000);setInterval(()=>catalogDiscoveryRun().catch(e=>console.error('CATALOG AUTO FAILED',e.message)),catalogInterval());}
`;
s=s.slice(0,start)+code+'\n'+s.slice(listen);
fs.writeFileSync(p,'server.js','utf8');
console.log('HOMESTRO_CATALOG_DISCOVERY_V2_INSTALLED');
