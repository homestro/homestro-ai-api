const fs=require('fs');
const p='server.js'; let s=fs.readFileSync(p,'utf8');
const start=s.indexOf('async function imageIsRelevant('); const end=s.indexOf('async function addMedia(',start);
if(start<0||end<0) throw new Error('Could not locate imageIsRelevant/addMedia');
const fn=`async function imageIsRelevant(url,input,pageContext){
  if(!process.env.OPENAI_API_KEY) return false;
  const model=process.env.OPENAI_IMAGE_MODEL||process.env.OPENAI_MODEL||'gpt-5-mini';
  const productTitle=String(input?.title||input?.name||'').trim();
  const category=String(input?.category||input?.productType||'').trim();
  const description=String(input?.description||input?.shortDescription||'').replace(/<[^>]+>/g,' ').slice(0,1200);
  const prompt='Prüfe dieses Produktbild für Homestro extrem streng. Freigabe NUR wenn das konkrete Produkt gezeigt wird UND das Bild für einen deutschen Online-Shop brauchbar ist. Produktname: '+productTitle+'. Kategorie: '+category+'. Beschreibung: '+description+'. Quellseite: '+pageContext+'. ABLEHNEN bei anderem Produkt, anderem Produkttyp, Dekoration, Zubehör statt Hauptprodukt, Banner, Logo, Wasserzeichen, Verpackung als Hauptmotiv, sichtbaren chinesischen/japanischen/koreanischen Schriftzeichen oder anderem fremdsprachigem Werbetext, stark verpixeltem/unscharfem Bild, extrem schlechter Qualität oder Unsicherheit. Kleine neutrale Markierungen sind okay, aber KEIN chinesischer Text. Gleicher Name allein reicht nicht. Antworte ausschließlich JSON: {"relevant":true/false,"confidence":0-1,"hasChineseText":true/false,"lowQuality":true/false}';
  try{
    const r=await fetch('https://api.openai.com/v1/responses',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+process.env.OPENAI_API_KEY},body:JSON.stringify({model,input:[{role:'user',content:[{type:'input_text',text:prompt},{type:'input_image',image_url:url,detail:'high'}]}],max_output_tokens:160})});
    const d=await r.json(); if(!r.ok) return false;
    const out=cleanJson(d.output_text||d.output?.flatMap(x=>x.content||[]).map(x=>x.text||'').join('')||'{}');
    return out.relevant===true&&out.hasChineseText!==true&&out.lowQuality!==true&&Number(out.confidence)>=0.85;
  }catch{return false;}
}
`;
s=s.slice(0,start)+fn+s.slice(end); fs.writeFileSync(p,s); console.log('image quality patched');
