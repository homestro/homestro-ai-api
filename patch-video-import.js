const fs=require('fs');
const p='server.js';
let s=fs.readFileSync(p,'utf8');
const dStart=s.indexOf('async function discoverImages(');
const dEnd=s.indexOf('async function imageIsRelevant(',dStart);
if(dStart<0||dEnd<0) throw new Error('Could not locate discoverImages/imageIsRelevant');
const discover=`async function discoverImages(input){
  const supplied=[...(Array.isArray(input?.image_urls)?input.image_urls:[]),...(Array.isArray(input?.imageUrls)?input.imageUrls:[])].filter(Boolean);
  let urls=supplied.map(String);
  let videoUrls=[...(Array.isArray(input?.video_urls)?input.video_urls:[]),...(Array.isArray(input?.videoUrls)?input.videoUrls:[])].filter(Boolean).map(String);
  const source=String(input?.source_url||input?.sourceUrl||'').trim();
  let pageContext='';
  if(source){
    try{
      const r=await fetch(source,{headers:{'User-Agent':'Mozilla/5.0 (compatible; HomestroBot/1.0)'},redirect:'follow'});
      if(r.ok){
        const html=await r.text();
        const title=(html.match(/<title[^>]*>([\\s\\S]*?)<\\/title>/i)||[])[1]||'';
        const h1=(html.match(/<h1[^>]*>([\\s\\S]*?)<\\/h1>/i)||[])[1]||'';
        pageContext=String(title+' '+h1).replace(/<[^>]+>/g,' ').replace(/\\s+/g,' ').trim().slice(0,1000);
        const found=[]; let m;
        const metaRe=/<meta[^>]+(?:property|name)=["'](?:og:image|twitter:image)["'][^>]+content=["']([^"']+)["'][^>]*>/gi;
        while((m=metaRe.exec(html))&&found.length<12)found.push(m[1]);
        const imgRe=/<img[^>]+(?:src|data-src|data-original)=["']([^"']+)["'][^>]*>/gi;
        while((m=imgRe.exec(html))&&found.length<24)found.push(m[1]);
        urls.push(...found.map(x=>absoluteUrl(x,source)).filter(Boolean));

        const videos=[];
        const sourceRe=/<(?:video|source)[^>]+(?:src|data-src|data-original)=["']([^"']+)["'][^>]*>/gi;
        while((m=sourceRe.exec(html))&&videos.length<12) videos.push(m[1]);
        const videoAttrRe=/(?:og:video(?::url)?|twitter:player:stream|video_url|videoUrl|videoURL)["']?\\s*[:=]\\s*["']([^"']+)["']/gi;
        while((m=videoAttrRe.exec(html))&&videos.length<20) videos.push(m[1]);
        const jsonVideoRe=/["'](?:video|video_url|videoUrl|videoURL|contentUrl|content_url)["']\\s*[:=]\\s*["']([^"']+\\.(?:mp4|webm|mov)(?:\\?[^"']*)?)["']/gi;
        while((m=jsonVideoRe.exec(html))&&videos.length<20) videos.push(m[1]);
        videoUrls.push(...videos.map(x=>absoluteUrl(x,source)).filter(Boolean));
      }
    }catch{}
  }
  const unique=[...new Set(urls.filter(u=>/^https?:\\/\\//i.test(u)))].slice(0,16);
  const uniqueVideos=[...new Set(videoUrls.filter(u=>/^https?:\\/\\//i.test(u)))].filter(u=>/\\.(?:mp4|webm|mov)(?:[?#].*)?$/i.test(u)||/video|stream|\.m3u8(?:[?#].*)?$/i.test(u)).slice(0,8);
  return{urls:unique,videoUrls:uniqueVideos,pageContext};
}
`;
s=s.slice(0,dStart)+discover+s.slice(dEnd);
const aStart=s.indexOf('async function addMedia(');
const aEnd=s.indexOf('async function setSeo(',aStart);
if(aStart<0||aEnd<0) throw new Error('Could not locate addMedia/setSeo');
const add=`async function addMedia(productId,input,title,token){
  const found=await discoverImages({...input,title});
  const accepted=[];
  for(const url of found.urls){if(await imageIsRelevant(url,{...input,title},found.pageContext)) accepted.push(url); if(accepted.length>=10) break;}
  const media=[];
  if(accepted.length) accepted.forEach(url=>media.push({mediaContentType:'IMAGE',originalSource:url,alt:String(title||'Homestro Produkt')}));
  let videoAdded=0,videoErrors=[];
  for(const url of found.videoUrls||[]){
    if(videoAdded>=3) break;
    try{
      const d=await shopifyGraphQL('mutation($productId:ID!,$media:[CreateMediaInput!]!){productCreateMedia(productId:$productId,media:$media){media{mediaContentType status}mediaUserErrors{field message}}}',{productId,media:[{mediaContentType:'VIDEO',originalSource:url,alt:String(title||'Homestro Produkt Video')}]},token);
      const errs=d.productCreateMedia.mediaUserErrors||[];
      if(!errs.length&&d.productCreateMedia.media?.length) videoAdded+=d.productCreateMedia.media.length; else if(errs.length) videoErrors.push({url,error:errs[0].message});
    }catch(e){videoErrors.push({url,error:e.message});}
  }
  if(media.length){
    const d=await shopifyGraphQL('mutation($productId:ID!,$media:[CreateMediaInput!]!){productCreateMedia(productId:$productId,media:$media){media{mediaContentType status}mediaUserErrors{field message}}}',{productId,media},token);
    const errs=d.productCreateMedia.mediaUserErrors||[]; if(errs.length) throw Object.assign(new Error('Shopify rejected product images.'),{status:400,details:errs});
    return{count:(d.productCreateMedia.media||[]).length+videoAdded, imageCount:(d.productCreateMedia.media||[]).length, videoCount:videoAdded, videoUrls:(found.videoUrls||[]).slice(0,videoAdded), urls:accepted, rejected:found.urls.length-accepted.length, videoCandidates:(found.videoUrls||[]).length, videoErrors, validation:'strict-vision',fallback:false};
  }
  const bytes=await generateFallbackImage(input,title);
  if(bytes){
    const resourceUrl=await stagedUploadImage('homestro-ai-product.png',bytes,token);
    if(resourceUrl){
      const d=await shopifyGraphQL('mutation($productId:ID!,$media:[CreateMediaInput!]!){productCreateMedia(productId:$productId,media:$media){media{mediaContentType status}mediaUserErrors{field message}}}',{productId,media:[{mediaContentType:'IMAGE',originalSource:resourceUrl,alt:String(title||'Homestro Produkt')}]},token);
      const errs=d.productCreateMedia.mediaUserErrors||[];
      if(!errs.length) return{count:(d.productCreateMedia.media||[]).length+videoAdded,imageCount:(d.productCreateMedia.media||[]).length,videoCount:videoAdded,videoUrls:(found.videoUrls||[]).slice(0,videoAdded),urls:[resourceUrl],rejected:found.urls.length,videoCandidates:(found.videoUrls||[]).length,videoErrors,validation:'strict-vision',fallback:true,fallbackReason:found.urls.length?'no-clean-image':'no-source-image'};
    }
  }
  return{count:videoAdded,imageCount:0,videoCount:videoAdded,videoUrls:(found.videoUrls||[]).slice(0,videoAdded),urls:[],rejected:found.urls.length,videoCandidates:(found.videoUrls||[]).length,videoErrors,validation:'strict-vision',fallback:false};
}
`;
s=s.slice(0,aStart)+add+s.slice(aEnd);
fs.writeFileSync(p,s);
console.log('video import patched');
