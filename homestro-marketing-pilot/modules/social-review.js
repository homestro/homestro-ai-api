// Credentials remain only in the current browser page. Draft data is authenticated.
export const socialReviewPage=(nonce)=>`<!doctype html><html lang="cs"><meta charset="utf-8">
<meta name="viewport" content="width=device-width"><title>Homestro – schválení příspěvků</title>
<style nonce="${nonce}">body{font:16px system-ui;max-width:900px;margin:30px auto;padding:16px;background:#f7f7f7}
article{background:white;border:1px solid #ddd;padding:20px;margin:20px 0;border-radius:12px}
img,video{max-width:180px;max-height:200px;object-fit:contain;margin:5px}label{display:block;margin:12px 0}
.media{display:flex;flex-wrap:wrap;align-items:center;gap:8px}.media a{display:block}
article{scroll-margin-top:16px}article.done{padding:12px 20px;background:#edf6ef}
#bulk{background:white;border:2px solid #275b38;padding:18px;margin:20px 0;border-radius:12px}
button,input,select{font:inherit;padding:8px}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit;line-height:1.45}
#message{color:#703700}button{cursor:pointer}button:disabled{cursor:default}</style>
<h1>Homestro – organické příspěvky</h1>
<p id="schedule">Načtěte příspěvky a aktuální nastavení publikování. Schválení zařadí obsah do fronty.</p>
<label>Přístupový klíč pilota <input id="key" type="password" autocomplete="off"></label>
<label>Vaše jméno <input id="reviewer" autocomplete="name"></label>
<button id="load">Načíst příspěvky</button><section id="report"></section><p id="message" role="status"></p><section id="bulk" hidden></section><main id="posts"></main>
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
  const report=el('report');report.replaceChildren();node('h2','Stav zveřejňování',report);
  const names={facebook:'Facebook',instagram:'Instagram',tiktok:'TikTok',pinterest:'Pinterest'};
  const labels={published:'zveřejněno',approved:'schváleno ve frontě',draft_queued:'ke schválení',
    remote_pending:'čeká na potvrzení sítě',recovery_required:'vyžaduje kontrolu výsledku'};
  for(const [channel,name] of Object.entries(names)){
    const rows=(status.counts||[]).filter(r=>r.channel===channel&&labels[r.status]);
    if(rows.length)node('p',name+': '+rows.map(r=>labels[r.status]+' '+Number(r.count)).join('; ')+'.',report);
  }
  node('p','Odeslaný nebo schválený návrh není potvrzená publikace. Rozpočet na placené reklamy: 0 €.',report);
  for(const p of (status.publications||[]).slice(0,8)){
    const line=node('p','',report),a=node('a','Otevřít zveřejněný příspěvek – '+(names[p.channel]||p.channel),line);
    a.href=p.permalink;a.target='_blank';a.rel='noopener';
  }
  for(const f of status.failures||[])node('p',(names[f.channel]||f.channel)+': '+Number(f.count)+' příspěvků čeká na technickou kontrolu. Znovu je neschvalujte.',report);
  const jobs=await api('posts');let creator;
  if(jobs.some(j=>j.channel==='tiktok'))creator=await api('tiktok-settings');
  el('schedule').textContent=status.channelPolicies
    ? Object.entries(status.channelPolicies).map(([channel,p])=>channel+': nejvýše '+p.daily+' za 24 hodin, odstup alespoň '+p.hours+' h').join('; ')+(status.publishAroundClock?' (i v noci).':' mezi 9:00 a 22:00 berlínského času. Schválení nezaručuje zveřejnění ani dosah.')
    : 'Pilot odesílá nejdříve každých '+status.publishEveryHours+' hodin na každé síti, nejvýše '+status.maximumDailyPerChannel+' za 24 hodin'+(status.publishAroundClock?' (i v noci).':' mezi 9:00 a 22:00 berlínského času.');
  el('posts').replaceChildren();el('bulk').replaceChildren();el('bulk').hidden=!creator;let approved=0,busy=false;
  const records=[];
  const progress=()=>{el('message').textContent=(jobs.length-approved)+' příspěvků ke kontrole; '+approved+' schváleno v tomto přehledu.';};
  progress();
  let batchPrivacy,batchComment,batchDuet,batchStitch,batchPreview,batchConsent,batchButton,batchCount,chooseAll;
  const selection=()=>records.filter(r=>!r.done&&!r.working&&r.choose.checked);
  const refreshBatch=(reset=true)=>{
    if(!creator)return;
    if(reset){batchPreview.checked=false;batchConsent.checked=false;}
    const selected=selection();batchCount.textContent='Vybráno '+selected.length+' konkrétních příspěvků na TikTok.';
    chooseAll.textContent=selected.length===records.filter(r=>!r.done&&!r.working).length?'Zrušit výběr':'Vybrat všechny zobrazené TikTok příspěvky';
    batchButton.disabled=busy||!selected.length||!el('reviewer').value.trim()||!batchPrivacy.value||!batchPreview.checked||!batchConsent.checked;
  };
  const markDone=(record)=>{
    record.done=true;if(record.choose)record.choose.checked=false;
    const a=record.card,p=record.job.payload;a.replaceChildren();a.className='done';a.dataset.approved='true';
    node('p','Schváleno do fronty: '+record.job.channel+' – '+p.title,a);approved++;progress();
  };
  if(creator){
    const panel=el('bulk');node('h2','Hromadné schválení TikToku',panel);
    node('p','Vyberte konkrétní návrhy a prohlédněte jejich text i všechna média. Společné nastavení níže použijeme pouze na tuto vybranou dávku. Propagujete vlastní obchod Homestro.',panel);
    chooseAll=node('button','Vybrat všechny zobrazené TikTok příspěvky',panel);
    batchCount=node('p','',panel);
    const label=node('label','Viditelnost celé vybrané dávky: ',panel);batchPrivacy=node('select','',label);
    const blank=node('option','Vyberte viditelnost',batchPrivacy);blank.value='';
    if(creator.privacyLevels?.some(l=>l.value==='PUBLIC_TO_EVERYONE')){const option=node('option','Veřejně',batchPrivacy);option.value='PUBLIC_TO_EVERYONE';}
    batchComment=check(panel,'Povolit komentáře u vybraných příspěvků');
    batchDuet=check(panel,'Povolit duet u vybraných videí');batchStitch=check(panel,'Povolit stitch u vybraných videí');
    for(const [input,field] of [[batchComment,'allow_comment'],[batchDuet,'allow_duet'],[batchStitch,'allow_stitch']])input.disabled=creator.postingLimits?.interactionSettings?.[field]?.enabled!==true;
    batchPreview=check(panel,'Prohlédl/a jsem text a všechna média KAŽDÉHO vybraného příspěvku.');
    batchConsent=check(panel,'Souhlasím s odesláním KAŽDÉHO vybraného příspěvku na TikTok a s Music Usage Confirmation.');
    const terms=node('a','TikTok Music Usage Confirmation',panel);terms.href='https://www.tiktok.com/legal/page/global/music-usage-confirmation/en';terms.target='_blank';terms.rel='noopener';
    batchButton=node('button','Schválit vybranou dávku',panel);
    chooseAll.onclick=()=>{const available=records.filter(r=>!r.done&&!r.working),all=available.every(r=>r.choose.checked);for(const r of available)r.choose.checked=!all;refreshBatch();};
    for(const input of [batchPrivacy,batchComment,batchDuet,batchStitch,batchPreview,batchConsent])input.onchange=()=>refreshBatch(false);
    el('reviewer').oninput=()=>refreshBatch(false);
    batchButton.onclick=async()=>{
      refreshBatch(false);if(batchButton.disabled)return;
      const selected=selection(),reviewer=el('reviewer').value.trim();
      const settings={privacy_level:batchPrivacy.value,content_preview_confirmed:batchPreview.checked,express_consent_given:batchConsent.checked,
        allow_comment:batchComment.checked,allow_duet:batchDuet.checked,allow_stitch:batchStitch.checked};
      busy=true;refreshBatch(false);el('load').disabled=true;chooseAll.disabled=true;
      for(const input of el('bulk').querySelectorAll('input,select'))input.disabled=true;
      for(const r of records){r.button.disabled=true;r.choose.disabled=true;}
      let succeeded=0;const failures=[];
      try{
        for(const r of selected){
          el('message').textContent='Schvaluji '+(succeeded+failures.length+1)+' / '+selected.length+'…';
          try{await api('posts/'+r.job.id+'/approve',{reviewer,expectedRevision:r.job.revision,tiktokSettings:{...settings},...(r.job.payload.importedMedia?{assetSha256:r.job.payload.assetSha256,content_preview_confirmed:batchPreview.checked}:{})});markDone(r);succeeded++;}
          catch(e){failures.push(r.job.payload.title+': '+e.message);}
        }
      }finally{
        busy=false;el('load').disabled=false;chooseAll.disabled=false;
        for(const input of el('bulk').querySelectorAll('input,select'))input.disabled=false;
        for(const [input,field] of [[batchComment,'allow_comment'],[batchDuet,'allow_duet'],[batchStitch,'allow_stitch']])input.disabled=creator.postingLimits?.interactionSettings?.[field]?.enabled!==true;
        for(const r of records)if(!r.done){r.button.disabled=false;r.choose.disabled=false;}
        refreshBatch();el('message').textContent='Do fronty schváleno '+succeeded+' / '+selected.length+'.'+(failures.length?' Zbývající návrhy: '+failures.join('; '):' Pilot je bude odesílat postupně.');
      }
    };
  }
  for(const j of jobs){
   const a=node('article','',el('posts')),p=j.payload;
   const record={job:j,card:a,done:false};
   node('h2',j.channel+' – '+p.title,a);
   if(j.channel==='tiktok'){record.choose=check(a,'Vybrat tento návrh do hromadného schválení');record.choose.onchange=()=>refreshBatch();records.push(record);}
   node('pre',p.caption,a);
   const link=node('a','Produkt v obchodě',a);link.href=p.productURL;link.target='_blank';link.rel='noopener';
   const urls=p.format==='reels'?[p.videoURL]:p.imageURLs;
   const gallery=node('div','',a);gallery.className='media';
   for(const url of urls){
    let parent=gallery;
    if(p.format!=='reels'){parent=node('a','',gallery);parent.href=url;parent.target='_blank';parent.rel='noopener';parent.title='Otevřít celou fotografii';}
    const m=node(p.format==='reels'?'video':'img','',parent);m.src=url;
    if(m.tagName==='VIDEO'){m.controls=true;m.preload='metadata';}else{m.alt=p.title;m.loading='lazy';}
   }
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
   if(p.importedMedia&&j.channel!=='tiktok')preview=check(a,'Prohlédl/a jsem importovaný obrázek nebo video a text.');
   const b=node('button','Schválit tento příspěvek',a);
   record.button=b;
   b.onclick=async()=>{
    if(busy)return;
    record.working=true;if(record.choose)record.choose.disabled=true;refreshBatch();
    b.disabled=true;
    try{
     const body={reviewer:el('reviewer').value,expectedRevision:j.revision,...(p.importedMedia?{assetSha256:p.assetSha256,content_preview_confirmed:preview?.checked===true}:{})};
     if(j.channel==='tiktok')body.tiktokSettings={privacy_level:privacy.value,
      content_preview_confirmed:preview.checked,express_consent_given:consent.checked,
      allow_comment:comment.checked,allow_duet:duet?.checked??false,allow_stitch:stitch?.checked??false};
     await api('posts/'+j.id+'/approve',body);
     const next=a.nextElementSibling;
     markDone(record);refreshBatch();
     if(next)next.scrollIntoView({behavior:'smooth',block:'start'});
     else el('message').scrollIntoView({behavior:'smooth',block:'center'});
    }catch(e){el('message').textContent=e.message;b.disabled=false;}
    finally{record.working=false;if(record.choose)record.choose.disabled=false;refreshBatch(false);}
   };
  }
  refreshBatch();
 }catch(e){el('message').textContent=e.message;}
};
</script></html>`;
