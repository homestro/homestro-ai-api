const fs=require('fs');
const p='server.js';
let s=fs.readFileSync(p,'utf8');
if(s.includes('HOMESTRO_CATALOG_DISCOVERY_V1')){console.log('CATALOG DISCOVERY already installed');process.exit(0);}
const marker='app.listen(';
const i=s.indexOf(marker);
if(i<0)throw new Error('app.listen marker not found');
const code=String.raw`
// HOMESTRO_CATALOG_DISCOVERY_V1
const catalogDiscovery={running:false,lastRun:null,lastError:null,created:0,rejected:0,failed:0,seen:new Set()};
const catalogKeywords=['home organization','kitchen storage','car cleaning','garden tools','home improvement','pet accessories','fitness accessories','baby accessories','beauty accessories','travel accessories'];
function catalogInterval(){const n=Number(process.env.HOMESTRO_CATALOG_INTERVAL_MS||300000);return Number.isFinite(n)&&n>=300000?n:300000;}
function catalogText(v){return String(v||'').replace(/<[^>]*>/g,' ').replace(/\\s+/g,' ').trim();}
function catalogNumber(v){const n=Number(String(v??'').replace(/[^0-9.,-]/g,'').replace(',','.'));return Number.isFinite(n)?n:NaN;}
async function catalogFetchSearch(keyword){
  const url='https://www.aliexpress.com/w/wholesale-'+encodeURIComponent(keyword).replace(/%20/g,'-')+'.html?g=y';
  const r=await fetch(url,{headers:{'User-Agent':'Mozilla/5.0 (compatible; HomestroCatalog/1.0)','Accept-Language':'en-US,en;q=0.9'},redirect:'follow'});
  if(!r.ok)throw new Error('AliExpress HTTP '+r.status);
  const html=await r.text();
  const out=[]; const ids=new Set();
  const idRe=/(?:productId|product_id|productIdStr)\\s*["']?\\s*[:=]\\s*["']?(\\d{8,})/gi;
  let m; while((m=idRe.exec(html))&&out.length<80){const id=m[1];if(ids.has(id))continue;ids.add(id);const a=Math.max(0,m.index-2500),b=Math.min(html.length,m.index+5000),chunk=html.slice(a,b);const titleM=chunk.match(/(?:productTitle|title)\\s*["']?\\s*[:=]\\s*["']([^"']{10,300})/i);const priceM=chunk.match(/(?:salePrice|discountPrice|price)\\s*["']?\\s*[:=]\\s*["']?([0-9]+(?:[.,][0-9]+)?)/i);const soldM=chunk.match(/(?:orders|sold)\\s*["']?\\s*[:=]\\s*["']?([0-9,.]+)\\+?/i);const imgM=chunk.match(/https?:\\/\\/[^"'\\\\ ]+\\.(?:jpg|jpeg|png|webp)/i);out.push({id,title:catalogText(titleM?.[1]||keyword),cost:catalogNumber(priceM?.[1]),sold:catalogNumber(soldM?.[1])||0,image_urls:imgM?[imgM[0]]:[],source_url:'https://www.aliexpress.com/item/'+id+'.html'});}
  return out;
}
function catalogPass(x){const r=rules();const cost=Number(x.cost);if(!Number.isFinite(cost)||cost<3||cost>r.maxCost)return false;if(Number(x.sold||0)<1000)return false;const price=Math.max(r.minSellingPrice,Math.ceil(cost*3*100)/100);return price/cost>=r.minRatio;}
async function catalogCreate(x,token){
  const selling=Math.max(rules().minSellingPrice,Math.ceil(Number(x.cost)*3.25*100)/100);
  const ai=await aiProduct({title:x.title,description:'AliExpress source product. Use only facts that can be verified from the source page.',category:'',source_url:x.source_url,cost:x.cost,selling_price:selling,sold:x.sold});
  const p=ai.product||{}; if(!p.title)throw new Error('AI returned no title');
  const draft=await createDraft({title:p.title,description:p.description,shortDescription:p.shortDescription,category:p.category,tags:p.tags,seoTitle:p.seoTitle,seoDescription:p.seoDescription,handle:p.handle,cost:Number(x.cost),selling_price:selling,image_urls:x.image_urls||[],source_url:x.source_url},token);
  return draft;
}
async function catalogDiscoveryRun(){
  if(catalogDiscovery.running)return {ok:true,skipped:true};
  catalogDiscovery.running=true;
  try{
    const token=await getClientToken();
    let created=0,rejected=0,failed=0;
    for(const keyword of catalogKeywords){
      if(created>=Number(process.env.HOMESTRO_CATALOG_BATCH||10))break;
      let items=[];try{items=await catalogFetchSearch(keyword);}catch(e){failed++;console.error('CATALOG SOURCE FAILED',keyword,e.message);continue;}
      for(const x of items){
        if(created>=Number(process.env.HOMESTRO_CATALOG_BATCH||10))break;
        if(catalogDiscovery.seen.has(x.id))continue; catalogDiscovery.seen.add(x.id);
        if(!catalogPass(x)){rejected++;continue;}
        try{await catalogCreate(x,token);created++;catalogDiscovery.created++;console.log('CATALOG DRAFT CREATED',x.id,x.title);}catch(e){failed++;catalogDiscovery.failed++;console.error('CATALOG CREATE FAILED',x.id,e.message);}
      }
    }
    catalogDiscovery.rejected+=rejected;catalogDiscovery.lastRun=new Date().toISOString();catalogDiscovery.lastError=null;
    return {ok:true,created,rejected,failed,totalCreated:catalogDiscovery.created};
  }catch(e){catalogDiscovery.lastError=e.message;catalogDiscovery.lastRun=new Date().toISOString();return {ok:false,error:e.message};}
  finally{catalogDiscovery.running=false;}
}
app.get('/api/catalog/status',apiKey,(_q,res)=>res.json({ok:true,enabled:process.env.HOMESTRO_CATALOG_ENABLED!=='false',intervalMs:catalogInterval(),running:catalogDiscovery.running,lastRun:catalogDiscovery.lastRun,lastError:catalogDiscovery.lastError,totals:{created:catalogDiscovery.created,rejected:catalogDiscovery.rejected,failed:catalogDiscovery.failed}}));
app.get('/health/catalog',(_q,res)=>res.json({ok:true,enabled:process.env.HOMESTRO_CATALOG_ENABLED!=='false',running:catalogDiscovery.running,lastRun:catalogDiscovery.lastRun,lastError:catalogDiscovery.lastError,totals:{created:catalogDiscovery.created,rejected:catalogDiscovery.rejected,failed:catalogDiscovery.failed}}));
app.post('/api/catalog/run',apiKey,async(_q,res)=>res.json(await catalogDiscoveryRun()));
if(process.env.HOMESTRO_CATALOG_ENABLED!=='false'){setTimeout(()=>catalogDiscoveryRun().catch(console.error),10000);setInterval(()=>catalogDiscoveryRun().catch(console.error),catalogInterval());}
`;
s=s.slice(0,i)+code+'\n'+s.slice(i);
fs.writeFileSync(p,s,'utf8');
console.log('HOMESTRO_CATALOG_DISCOVERY_INSTALLED');
