const fs=require('fs');
const p='server.js';
let s=fs.readFileSync(p,'utf8');
const marker='async function addMedia(';
const start=s.indexOf(marker);
const end=s.indexOf('async function setSeo(',start);
if(start<0||end<0) throw new Error('Could not locate addMedia/setSeo in server.js');
const replacement=`async function generateFallbackImage(input,title){
  if(!process.env.OPENAI_API_KEY) return null;
  const prompt='Create one photorealistic premium ecommerce product photo for Homestro.de. Show ONLY the exact product described below. Preserve the verified shape, construction, materials, colors and visible features; do not invent accessories or functions. Clean neutral studio background, realistic proportions, natural lighting, professional German online-shop photography. Absolutely no text, no Chinese characters, no labels, no logos, no watermark, no packaging text. Product name: '+String(title||input?.title||input?.name||'').slice(0,300)+'\\nCategory: '+String(input?.category||input?.productType||'').slice(0,200)+'\\nDescription: '+String(input?.description||input?.shortDescription||'').replace(/<[^>]+>/g,' ').slice(0,1500);
  try{
    const r=await fetch('https://api.openai.com/v1/images/generations',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+process.env.OPENAI_API_KEY},body:JSON.stringify({model:process.env.OPENAI_IMAGE_GEN_MODEL||'gpt-image-1.5',prompt,n:1,size:'1024x1024',quality:'high',output_format:'png'})});
    const d=await r.json(); if(!r.ok) return null;
    const b64=d?.data?.[0]?.b64_json; if(!b64) return null;
    return Buffer.from(b64,'base64');
  }catch{return null;}
}
async function stagedUploadImage(filename,bytes,token){
  const input=[{filename,mimeType:'image/png',resource:'PRODUCT_IMAGE',httpMethod:'POST'}];
  const d=await shopifyGraphQL('mutation($input:[StagedUploadInput!]!){stagedUploadsCreate(input:$input){stagedTargets{url resourceUrl parameters{name value}}userErrors{field message}}}',{input},token);
  const x=d.stagedUploadsCreate; if(x.userErrors?.length||!x.stagedTargets?.[0]) return null;
  const target=x.stagedTargets[0]; const form=new FormData(); for(const q of target.parameters) form.append(q.name,q.value); form.append('file',new Blob([bytes],{type:'image/png'}),filename);
  const up=await fetch(target.url,{method:'POST',body:form}); if(!up.ok) return null;
  return target.resourceUrl;
}
async function addMedia(productId,input,title,token){
  const found=await discoverImages({...input,title});
  const accepted=[];
  for(const url of found.urls){if(await imageIsRelevant(url,{...input,title},found.pageContext)) accepted.push(url); if(accepted.length>=10) break;}
  if(accepted.length){
    const media=accepted.map(url=>({mediaContentType:'IMAGE',originalSource:url,alt:String(title||'Homestro Produkt')}));
    const d=await shopifyGraphQL('mutation($productId:ID!,$media:[CreateMediaInput!]!){productCreateMedia(productId:$productId,media:$media){media{mediaContentType status}mediaUserErrors{field message}}}',{productId,media},token);
    const errs=d.productCreateMedia.mediaUserErrors||[]; if(errs.length) throw Object.assign(new Error('Shopify rejected product images.'),{status:400,details:errs});
    return{count:(d.productCreateMedia.media||[]).length,urls:accepted,rejected:found.urls.length-accepted.length,validation:'strict-vision',fallback:false};
  }
  const bytes=await generateFallbackImage(input,title);
  if(bytes){
    const resourceUrl=await stagedUploadImage('homestro-ai-product.png',bytes,token);
    if(resourceUrl){
      const d=await shopifyGraphQL('mutation($productId:ID!,$media:[CreateMediaInput!]!){productCreateMedia(productId:$productId,media:$media){media{mediaContentType status}mediaUserErrors{field message}}}',{productId,media:[{mediaContentType:'IMAGE',originalSource:resourceUrl,alt:String(title||'Homestro Produkt')} ]},token);
      const errs=d.productCreateMedia.mediaUserErrors||[]; if(!errs.length) return{count:(d.productCreateMedia.media||[]).length,urls:[resourceUrl],rejected:found.urls.length,validation:'strict-vision',fallback:true,fallbackReason:found.urls.length?'no-clean-image':'no-source-image'};
    }
  }
  return{count:0,urls:[],rejected:found.urls.length,validation:'strict-vision',fallback:false};
}
`;
s=s.slice(0,start)+replacement+s.slice(end);
fs.writeFileSync(p,s);
console.log('image fallback patched');
