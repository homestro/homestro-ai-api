// Credentials remain only in the current browser page. Draft data is authenticated.
export const socialReviewPage=(nonce)=>`<!doctype html><html lang="cs"><meta charset="utf-8">
<meta name="viewport" content="width=device-width"><title>Homestro – schválení příspěvků</title>
<style nonce="${nonce}">body{font:16px system-ui;max-width:900px;margin:30px auto;padding:16px;background:#f7f7f7}
article{background:white;border:1px solid #ddd;padding:20px;margin:20px 0;border-radius:12px}
img,video{max-width:220px;max-height:320px;margin:5px}label{display:block;margin:12px 0}
button,input,select{font:inherit;padding:8px}pre{white-space:pre-wrap}#message{color:#703700}</style>
<h1>Homestro – organické příspěvky</h1>
<p>Prohlédněte celý obsah. Schválené příspěvky může pilot odeslat mezi 9:00 a 22:00 berlínského času.
TikTok vyžaduje souhlas ke každému příspěvku. Limit je jeden příspěvek na síť za 24 hodin.</p>
<label>Přístupový klíč pilota <input id="key" type="password" autocomplete="off"></label>
<label>Vaše jméno <input id="reviewer" autocomplete="name"></label>
<button id="load">Načíst příspěvky</button><p id="message" role="status"></p><main id="posts"></main>
<script nonce="${nonce}">
const el=id=>document.getElementById(id);
async function api(path,body){
 const r=await fetch('/api/marketing/v2/social/'+path,{method:body?'POST':'GET',headers:{
 Authorization:'Bearer '+el('key').value,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});
 const d=await r.json();if(!r.ok)throw new Error(d.error||'REQUEST_FAILED');return d;
}
function node(tag,text,parent){const n=document.createElement(tag);if(text)n.textContent=text;parent.append(n);return n;}
function check(parent,text){const label=node('label',text,parent),input=document.createElement('input');input.type='checkbox';label.prepend(input);return input;}
el('load').onclick=async()=>{
 try{
  const status=await api('status');
  if(!status.configured)throw new Error('SOCIAL_NOT_CONFIGURED');
  const jobs=await api('posts');let creator;
  if(jobs.some(j=>j.channel==='tiktok'))creator=await api('tiktok-settings');
  el('posts').replaceChildren();el('message').textContent=jobs.length+' příspěvků ke kontrole.';
  for(const j of jobs){
   const a=node('article','',el('posts')),p=j.payload;
   node('h2',j.channel+' – '+p.title,a);node('pre',p.caption,a);
   const link=node('a','Produkt v obchodě',a);link.href=p.productURL;link.target='_blank';link.rel='noopener';
   const urls=p.format==='reels'?[p.videoURL]:p.imageURLs;
   for(const url of urls){const m=node(p.format==='reels'?'video':'img','',a);m.src=url;if(m.tagName==='VIDEO')m.controls=true;else m.alt=p.title;}
   let preview,consent,privacy,comment,duet,stitch;
   if(j.channel==='tiktok'){
    node('p','Propagace vlastního obchodu Homestro (brand organic).',a);
    const label=node('label','Viditelnost: ',a);privacy=node('select','',label);
    const blank=node('option','Vyberte viditelnost',privacy);blank.value='';
    for(const level of creator.privacyLevels||[]){if(level.value!=='PUBLIC_TO_EVERYONE')continue;
      const o=node('option','Veřejně',privacy);o.value=level.value;}
    comment=check(a,'Povolit komentáře');
    if(creator.postingLimits?.interactionSettings?.allow_comment?.enabled!==true)comment.disabled=true;
    if(p.format==='reels'){
     duet=check(a,'Povolit duet');stitch=check(a,'Povolit stitch');
     if(creator.postingLimits?.interactionSettings?.allow_duet?.enabled!==true)duet.disabled=true;
     if(creator.postingLimits?.interactionSettings?.allow_stitch?.enabled!==true)stitch.disabled=true;
    }
    preview=check(a,'Prohlédl/a jsem tento text a všechna média.');
    consent=check(a,'Souhlasím s odesláním tohoto příspěvku na TikTok a s jeho Music Usage Confirmation.');
    const terms=node('a','TikTok Music Usage Confirmation',a);
    terms.href='https://www.tiktok.com/legal/page/global/music-usage-confirmation/en';terms.target='_blank';terms.rel='noopener';
   }
   const b=node('button','Schválit tento příspěvek',a);
   b.onclick=async()=>{
    b.disabled=true;
    try{
     const body={reviewer:el('reviewer').value};
     if(j.channel==='tiktok')body.tiktokSettings={privacy_level:privacy.value,
      content_preview_confirmed:preview.checked,express_consent_given:consent.checked,
      allow_comment:comment.checked,allow_duet:duet?.checked??false,allow_stitch:stitch?.checked??false};
     await api('posts/'+j.id+'/approve',body);b.textContent='Schváleno do fronty';
    }catch(e){el('message').textContent=e.message;b.disabled=false;}
   };
  }
 }catch(e){el('message').textContent=e.message;}
};
</script></html>`;
