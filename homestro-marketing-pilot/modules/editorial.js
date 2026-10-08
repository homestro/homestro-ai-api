import {mkdir,mkdtemp,writeFile,rename,rm,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {isDeepStrictEqual} from 'node:util';
import {hash,log} from './core.js';

// Original Homestro editorial copy. No supplier photos, invented products or prices.
const topics=[
 ['Ein Platz für jeden Tag','Schlüssel, Tasche und Post brauchen einen festen Platz. Eine kleine Ablage am Eingang kann helfen, den Alltag übersichtlicher zu halten.'],
 ['Die freie Arbeitsfläche','Räume eine kleine Fläche frei und lege nur zurück, was du dort regelmäßig brauchst. Beginne mit einer Ecke statt mit der ganzen Küche.'],
 ['Ordnung in der Schublade','Sortiere zuerst nach Verwendung: Was zusammen gebraucht wird, darf zusammen liegen. Miss die Schublade aus, bevor du einen Einsatz auswählst.'],
 ['Eine Tasche für unterwegs','Lege häufig benötigte Dinge an einen festen Platz in deiner Tasche. Prüfe vor dem Losgehen, ob Schlüssel, Geldbörse und Telefon dabei sind.'],
 ['Kleine Schritte im Haushalt','Wähle eine Aufgabe, die heute überschaubar bleibt: einen Tisch abräumen oder eine Schublade sortieren. Du musst nicht alles auf einmal erledigen.'],
 ['Vor dem Kauf ausmessen','Notiere Breite, Höhe und Tiefe des verfügbaren Platzes. Vergleiche diese Maße mit den Produktangaben, bevor du etwas bestellst.'],
 ['Was brauchst du wirklich?','Überlege vor einem Kauf, wofür du den Gegenstand nutzen möchtest und wo er später liegen soll. Ein klarer Zweck erleichtert die Auswahl.'],
 ['Ein ruhiger Start am Morgen','Lege die Dinge für den nächsten Tag am Abend bereit. Eine kleine Checkliste hilft, wichtige Sachen nicht zu vergessen.'],
 ['Pflege beginnt beim Etikett','Lies die Pflegehinweise des Herstellers, bevor du einen Gegenstand reinigst. Material und Beschichtung bestimmen, welche Behandlung geeignet ist.'],
 ['Die kleine Abendrunde','Räume am Abend nur die Dinge zurück, die ihren Platz schon haben. Für alles andere kannst du später in Ruhe einen passenden Platz festlegen.'],
 ['Mehr Überblick im Schrank','Gruppiere ähnliche Dinge und stelle häufig Benutztes gut erreichbar hin. Überlege beim Sortieren, was du tatsächlich regelmäßig verwendest.'],
 ['Eine Liste statt vieler Zettel','Sammle deine Besorgungen an einem festen Ort. Prüfe vor dem Einkauf, was bereits vorhanden ist, und ergänze nur das Fehlende.'],
 ['Gemeinsam Ordnung halten','Vereinbart in der Familie einfache Plätze für Dinge, die alle benutzen. Je verständlicher die Regel, desto leichter lässt sie sich im Alltag nutzen.'],
 ['Bewusst auswählen','Vergleiche Beschreibung, Maße und Varianten in Ruhe. Entscheide nach deinem Bedarf und prüfe die Angaben, bevor du eine Bestellung abschließt.']
];
export const editorialEnabled=()=>process.env.PILOT_BRAND_EDITORIAL_ENABLED==='true';
export function editorialDocuments(){return topics.map(([title,text],i)=>{
 const p={id:`editorial:homestro:v1:${String(i+1).padStart(2,'0')}`,kind:'brand_editorial',title,text,
  rightsVerified:true,contentReviewed:true,priceReviewed:true,germanCopy:{title,text},provenance:'Original Homestro copy and typographic layout v1'};
 return {...p,revision:hash(p)};
});}
export function editorialPayload(p,cfg){
 const key=hash({editorialRevision:p.revision,layout:1});
 return {kind:'brand_editorial',title:p.title,caption:`${p.title}\n\n${p.text}\n\nHomestro – Ideen für deinen Alltag.\nhomestro.de`,
  format:'image',imageURLs:[`${cfg.publicOrigin}/marketing-assets/${key}.jpg`],videoURL:null,locationId:null,
  productRevision:p.revision,adSpendEUR:0};
}
export function validEditorial(job,stored,cfg){
 if(!editorialEnabled()||stored?.status!=='ready')return false;
 const p=editorialDocuments().find(p=>p.id===job.product_id);
 return Boolean(p && stored.document?.revision===p.revision &&
  isDeepStrictEqual(stored.document,p) && isDeepStrictEqual(job.payload,editorialPayload(p,cfg)));
}
export async function renderEditorial(p,cfg){
 const dir=join(cfg.dataDir,'assets');await mkdir(dir,{recursive:true});
 const key=hash({editorialRevision:p.revision,layout:1}),dest=join(dir,key+'.jpg');
 try{await stat(dest);return dest;}catch{}
 const tmp=await mkdtemp(join(dir,'editorial-'));
 try{
  const wrap=(s,n)=>s.split(' ').reduce((lines,w)=>{if((lines.at(-1)?.length||0)+w.length+1>n)lines.push(w);else lines[lines.length-1]+=(lines.at(-1)?' ':'')+w;return lines;},['']).join('\n');
  await writeFile(join(tmp,'title.txt'),wrap(p.title,24));
  await writeFile(join(tmp,'body.txt'),wrap(p.text,39));
  const font='/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf';
  const txt=(file,y,size,color)=>`drawtext=fontfile=${font}:textfile=${file}:expansion=none:fontsize=${size}:fontcolor=${color}:line_spacing=18:x=85:y=${y}`;
  const vf=[`drawbox=x=85:y=125:w=130:h=10:color=0xe8bd46:t=fill`,txt('title.txt',210,58,'0x203a32'),txt('body.txt',500,36,'0x203a32'),
   `drawtext=fontfile=${font}:text=HOMESTRO:expansion=none:fontsize=40:fontcolor=0x203a32:x=85:y=1130`,
   `drawtext=fontfile=${font}:text=homestro.de:expansion=none:fontsize=29:fontcolor=0x203a32:x=85:y=1200`].join(',');
  await new Promise((resolve,reject)=>{
   const c=spawn('/usr/bin/ffmpeg',['-hide_banner','-loglevel','error','-y','-f','lavfi','-i','color=c=0xf7f4eb:s=1080x1350',
    '-vf',vf,'-frames:v','1','-threads','1','-filter_threads','1','-q:v','3',join(tmp,'card.jpg')],{cwd:tmp,stdio:'ignore'});
   const timer=setTimeout(()=>c.kill('SIGKILL'),30000);
   c.once('error',e=>{clearTimeout(timer);reject(e);});c.once('close',code=>{clearTimeout(timer);code===0?resolve():reject(new Error('EDITORIAL_RENDER_FAILED'));});
  });
  await rename(join(tmp,'card.jpg'),dest);return dest;
 }finally{await rm(tmp,{recursive:true,force:true});}
}
export async function queueEditorial(store,cfg){
 if(!editorialEnabled()) {
  const r=await store.pool.query(`UPDATE marketing_posts SET status='superseded',error_code='EDITORIAL_DISABLED',updated_at=now()
    WHERE (product_id LIKE 'editorial:%' OR payload->>'kind'='brand_editorial')
    AND status IN ('draft_queued','approved') RETURNING id`);
  if(r.rowCount)log('EDITORIAL_DISABLED',{retired:r.rowCount});
  return;
 }
 if(!cfg.autonomyEnabled)return;
 let queued=0;
 for(const p of editorialDocuments()){
  await renderEditorial(p,cfg);await store.saveProduct(p,'ready',[]);
  const payload=editorialPayload(p,cfg);
  for(const channel of ['facebook','instagram'])if(await store.queue(p.id,channel,hash(payload),payload))queued++;
 }
 log('EDITORIAL_READY',{topics:topics.length,newQueued:queued,source:'original_homestro_editorial',adSpendEUR:0});
}
