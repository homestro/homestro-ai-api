import {hash,fail,log,productURL} from './core.js';
import {accessScopes} from './performance.js';

export const GUIDE_CREATE='mutation PilotGuideCreate($page: PageCreateInput!) { pageCreate(page: $page) { page { id handle isPublished } userErrors { field message } } }';
export const GUIDE_UPDATE='mutation PilotGuideUpdate($id: ID!, $page: PageUpdateInput!) { pageUpdate(id: $id, page: $page) { page { id handle isPublished } userErrors { field message } } }';
export const GUIDE_LOOKUP='query PilotGuideLookup($query: String!) { pages(first: 2, query: $query) { nodes { id handle title body isPublished } pageInfo { hasNextPage endCursor } } }';
const text=value=>String(value??'').replace(/<[^>]*>/g,' ').replace(/[\u0000-\u001f]/g,' ').replace(/\s+/g,' ').trim();
const esc=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const GUIDE_TOPICS=[
  {key:'kuechenhelfer',title:'Küchenhelfer auswählen: Eigenschaften und praktische Unterschiede',
    match:/küchen|kitchen|spül|schneid|koch|backform|gewürz/i,
    intro:'Ein Küchenhelfer sollte zu den Aufgaben passen, die du tatsächlich erledigst. Für die Auswahl zählen der vorgesehene Einsatz, die angegebenen Abmessungen und die Hinweise zur Reinigung. Dieser Überblick stellt Produkte aus dem Homestro-Sortiment anhand ihrer beschriebenen Eigenschaften gegenüber.',
    tips:['Lege zuerst fest, ob du Unterstützung beim Vorbereiten, Aufbewahren oder Reinigen suchst. Vergleiche anschließend die Produktbeschreibung mit dieser Aufgabe.',
      'Prüfe die angegebenen Maße und den Platz in deiner Küche. Eine allgemeine Bezeichnung wie Organizer sagt noch nichts darüber aus, ob ein Artikel in deine Schublade passt.',
      'Beachte die Pflegehinweise des jeweiligen Produkts. Eignung für Spülmaschine, Hitze oder bestimmte Lebensmittel sollte ausdrücklich in der Beschreibung stehen.']},
  {key:'haarschmuck',title:'Haarklammern und Haarschmuck: Auswahl nach Form und Anwendung',
    match:/haarklam|haarclip|haarschmuck|hair.?clip|haarspange/i,
    intro:'Haarschmuck unterscheidet sich in Form, Größe und Anwendung. Welche Variante sinnvoll ist, hängt von der gewünschten Frisur und den ausdrücklich beschriebenen Eigenschaften ab. Hier findest du passende Artikel aus dem Homestro-Sortiment mit ihren jeweiligen Merkmalen.',
    tips:['Überlege, ob du einzelne Strähnen befestigen oder mehr Haar zusammenhalten möchtest. Suche danach gezielt nach einer passenden Form und den angegebenen Maßen.',
      'Vergleiche die Varianten und den angegebenen Lieferumfang auf der Produktseite. Die Zahl der Teile und die auswählbaren Farben können je nach Artikel unterschiedlich sein.',
      'Aus einem Produktfoto allein lässt sich der Halt für jede Haarstruktur nicht ableiten. Orientiere dich an der Beschreibung und wähle die Ausführung passend zu deiner Anwendung.']},
  {key:'ordnung-zuhause',title:'Ordnung zu Hause: Organizer und Aufbewahrung sinnvoll auswählen',
    match:/aufbewahr|ordnung|organis|organizer|halter|korb|box|tasche/i,
    intro:'Ordnung beginnt mit der Frage, was einen festen Platz bekommen soll. Behälter, Halter und Organizer erfüllen unterschiedliche Aufgaben. Der folgende Überblick hilft dir, die beschriebenen Eigenschaften konkreter Homestro-Produkte mit deinem verfügbaren Platz und deinem Alltag abzugleichen.',
    tips:['Notiere zuerst, welche Gegenstände du aufbewahren möchtest und wie häufig du darauf zugreifst. Das erleichtert die Auswahl zwischen offenen und geschlossenen Lösungen.',
      'Miss den vorgesehenen Platz aus und vergleiche ihn mit den Produktangaben. Prüfe bei Haltern außerdem die ausdrücklich genannte Befestigungsart.',
      'Achte auf die auswählbare Variante und den Lieferumfang. Eigenschaften wie Tragfähigkeit oder Wasserfestigkeit gelten nur, wenn sie in der jeweiligen Beschreibung angegeben sind.']},
  {key:'haustierpflege',title:'Zubehör für die Haustierpflege: Merkmale und Auswahl vergleichen',
    match:/hund|katze|haustier|fell|pet.?comb|tierpflege/i,
    intro:'Bei Zubehör für Hunde und Katzen kommt es auf die konkrete Anwendung an. Unterschiedliche Produkte können für Pflege oder den Alltag mit dem Tier vorgesehen sein. Dieser Überblick nennt die beschriebenen Merkmale der ausgewählten Homestro-Artikel, ohne ihre Eignung für jedes Tier vorauszusetzen.',
    tips:['Prüfe, für welche Tierart und Anwendung der Artikel laut Beschreibung vorgesehen ist. Berücksichtige außerdem Größe und individuelle Bedürfnisse deines Tiers.',
      'Vergleiche Pflege- und Anwendungshinweise der einzelnen Produkte. Ein ähnliches Foto bedeutet nicht, dass zwei Ausführungen dieselben Eigenschaften besitzen.',
      'Gewöhne dein Tier behutsam an neues Zubehör und beachte die Herstellerhinweise. Zubehör ersetzt keine tierärztliche Beratung bei Beschwerden.']},
  {key:'gartenhelfer',title:'Gartenhelfer auswählen: Einsatz, Eigenschaften und Produktvergleich',
    match:/garten|garden|pflanz|bewässer|bewaesser/i,
    intro:'Gartenzubehör sollte zur geplanten Tätigkeit und zu den vorhandenen Bedingungen passen. Die beschriebenen Eigenschaften helfen dabei, unterschiedliche Lösungen einzuordnen. Hier findest du ausgewählte Homestro-Produkte und Hinweise für einen Vergleich vor dem Einkauf.',
    tips:['Bestimme zuerst den vorgesehenen Einsatz, beispielsweise Pflege oder Organisation. Vergleiche die Produktangaben danach mit deiner tatsächlichen Aufgabe.',
      'Prüfe Maße und benötigte Anschlüsse, sofern sie für das Produkt relevant sind. Eignung für den Außenbereich oder bestimmte Wetterbedingungen sollte ausdrücklich angegeben sein.',
      'Beachte Anwendung und Pflege laut Produktbeschreibung. Aus einer allgemeinen Garten-Kategorie lassen sich keine zusätzlichen Material- oder Haltbarkeitsversprechen ableiten.']}
];

export function guideProducts(products,topic,cfg={}) {
  return [...new Map(products.filter(p=>p.status==='ACTIVE'&&p.contentReviewed===true&&!p.rejected&&p.localized&&
    !cfg.excludedProductIds?.includes(p.id)&&p.variants?.some(v=>v.available&&v.price>0)&&
    topic.match.test(text(p.localized.title)+' '+text(p.productType))&&p.localized.benefits?.some(b=>text(b.text)))
    .filter(p=>{try{productURL(p.url);return true;}catch{return false;}}).map(p=>[p.id,p])).values()]
    .sort((a,b)=>a.id.localeCompare(b.id)).slice(0,6);
}
export function buildGuide(topic,products,cfg={}) {
  const selected=guideProducts(products,topic,cfg);
  if(selected.length<3)fail('SEO_GUIDE_INSUFFICIENT_PRODUCTS');
  const handle='homestro-ratgeber-'+topic.key;
  const cards=selected.map(p=>{
    const title=text(p.localized.title).slice(0,150),url=productURL(p.url).toString();
    const facts=[...new Set(p.localized.benefits.map(b=>text(b.text)).filter(Boolean))].slice(0,3);
    const image=p.media?.find(m=>m.mediaContentType==='IMAGE'&&m.status==='READY')?.image?.url;
    let photo='';
    try{const u=new URL(image);if(u.protocol==='https:'&&u.hostname==='cdn.shopify.com'&&!u.username&&!u.password)
      photo=`<img src="${esc(u.href)}" alt="${esc(title)}" loading="lazy" width="320" style="max-width:100%;height:auto">`;}catch{}
    return `<article><h3>${esc(title)}</h3>${photo}<ul>${facts.map(f=>`<li>${esc(f)}</li>`).join('')}</ul><p><a href="${esc(url)}">Produkt ansehen und aktuelle Variante auswählen</a></p></article>`;
  }).join('\n');
  // Internal links deliberately have no UTMs, preserving the visitor's original search attribution.
  const body=`<p>${esc(topic.intro)}</p><h2>Worauf du vor dem Kauf achten solltest</h2><ol>${topic.tips.map(t=>`<li>${esc(t)}</li>`).join('')}</ol><h2>Ausgewählte Produkte und ihre beschriebenen Eigenschaften</h2>${cards}<h2>So vergleichst du die Angebote</h2><p>Vergleiche die genannten Merkmale mit deiner geplanten Anwendung. Preis, Varianten und aktuelle Verfügbarkeit findest du auf der jeweiligen Produktseite. Die Reihenfolge ist kein Testurteil und keine Bewertung der Qualität.</p><h2>Häufige Fragen</h2><h3>Wo finde ich die genauen Angaben zu einem Artikel?</h3><p>Öffne die verlinkte Produktseite und prüfe dort Beschreibung, Varianten und Lieferumfang. Für die Auswahl sind die Angaben zur konkreten Ausführung entscheidend.</p><h3>Wie finde ich eine passende Ausführung?</h3><p>Gehe von deiner Anwendung und dem verfügbaren Platz aus. Vergleiche anschließend die ausdrücklich angegebenen Merkmale. Fehlt eine für dich wichtige Angabe, kläre sie vor dem Einkauf.</p>`;
  const fingerprint=hash({title:topic.title,body});
  return {handle,title:topic.title,body:body+`<!-- homestro-pilot-guide:${fingerprint} -->`,
    fingerprint,products:selected,isPublished:true,url:'https://homestro.de/pages/'+handle};
}
const ownBody=(page,fingerprint)=>{
  const marker=`<!-- homestro-pilot-guide:${fingerprint} -->`;
  if(typeof page.body!=='string'||!page.body.endsWith(marker))return false;
  const body=page.body.slice(0,-marker.length);
  if(hash({title:page.title,body})===fingerprint)return true;
  // Shopify adds formatting line breaks between HTML tags on page writes.
  // Restore only inter-tag whitespace and our known article separators.
  // Text, attributes, links, title and the ownership marker stay fingerprinted.
  const restored=body.replace(/>\s+</g,'><').trim().replace(/<\/article><article>/g,'</article>\n<article>');
  return hash({title:page.title,body:restored})===fingerprint;
};

export async function syncSeoGuides({pool,graphql,products,cfg,freshSnapshot}) {
  if(!cfg.seoAutopublishEnabled)return {status:'disabled',published:0};
  let client,locked=false,published=0,paused=0;
  try {
    const scopes=await accessScopes(graphql);
    if(!scopes.has('write_content')&&!scopes.has('write_online_store_pages')) {
      log('SEO_GUIDES_PERMISSION_REQUIRED',{missingScope:'write_content'});return {status:'permission_required',published:0};
    }
    client=await pool.connect();
    locked=(await client.query('SELECT pg_try_advisory_lock(73341004) AS locked')).rows[0]?.locked;
    if(!locked)return {status:'busy',published:0};
    for(const topic of GUIDE_TOPICS) {
      const handle='homestro-ratgeber-'+topic.key;
      const saved=(await client.query('SELECT * FROM marketing_seo_pages WHERE handle=$1',[handle])).rows[0];
      let guide;try{guide=buildGuide(topic,products,cfg);}catch(e){if(e.code!=='SEO_GUIDE_INSUFFICIENT_PRODUCTS')throw e;}
      if(!guide&&!saved?.shopify_id)continue;
      const response=await graphql(GUIDE_LOOKUP,{query:'handle:'+handle});
      if(!Array.isArray(response?.pages?.nodes))fail('SEO_PAGE_LOOKUP_UNCONFIRMED');
      const remote=response.pages.nodes.find(p=>p.handle===handle);
      if(!guide) {
        if(saved?.status==='published'&&remote?.id===saved.shopify_id&&ownBody(remote,saved.body_hash)&&remote.isPublished) {
          const result=await graphql(GUIDE_UPDATE,{id:remote.id,page:{isPublished:false}});
          if(result.pageUpdate?.userErrors?.length||result.pageUpdate?.page?.isPublished!==false)fail('SEO_PAGE_PAUSE_UNCONFIRMED');
          await client.query("UPDATE marketing_seo_pages SET status='paused',updated_at=now() WHERE handle=$1",[handle]);
          paused++;log('SEO_GUIDE_PAUSED',{handle,reason:'INSUFFICIENT_CURRENT_PRODUCTS'});
        }
        continue;
      }
      if(remote&&!saved?.shopify_id&&!['creating','recovery_required'].includes(saved?.status)){
        log('SEO_GUIDE_PENDING',{handle,reason:'EXISTING_PAGE_NOT_MANAGED'});continue;
      }
      if(saved&&['creating','recovery_required'].includes(saved.status)) {
        if(remote&&ownBody(remote,saved.content_hash)&&remote.isPublished) {
          await savePublished(client,{...guide,fingerprint:saved.content_hash},remote);log('SEO_GUIDE_RECONCILED',{handle,url:guide.url});
        }else log('SEO_GUIDE_PENDING',{handle,reason:'REMOTE_OUTCOME_UNCONFIRMED'});
        continue; // Never replay an uncertain create/update.
      }
      if(saved?.shopify_id&&(!remote||remote.id!==saved.shopify_id||!ownBody(remote,saved.body_hash))) {
        log('SEO_GUIDE_PENDING',{handle,reason:'MANAGED_PAGE_CHANGED'});continue;
      }
      if((saved?.status==='published'&&remote?.isPublished!==true)||
        (saved?.status==='paused'&&remote?.isPublished!==false)) {
        log('SEO_GUIDE_PENDING',{handle,reason:'MANAGED_PAGE_VISIBILITY_CHANGED'});continue;
      }
      if(saved?.body_hash===guide.fingerprint&&remote?.isPublished)continue;
      const used=Number((await client.query("SELECT count(*)::int AS count FROM marketing_seo_attempts WHERE attempted_at>now()-interval '24 hours'")).rows[0]?.count||0);
      if(used>=cfg.seoMaxDailyPages)continue;
      // Recheck every included product against Shopify immediately before publication.
      for(const source of guide.products) {
        const current=await freshSnapshot(source.id);
        if(!current||current.status!=='ACTIVE'||current.rejected||current.revision!==source.revision||
          !current.variants?.some(v=>v.available&&v.price>0))fail('SEO_SOURCE_CHANGED');
      }
      await client.query('BEGIN');
      try {
        await client.query(`INSERT INTO marketing_seo_pages(handle,content_hash,status,product_ids,attempted_at)
          VALUES($1,$2,'creating',$3,now()) ON CONFLICT(handle) DO UPDATE
          SET content_hash=$2,status='creating',product_ids=$3,attempted_at=now(),updated_at=now()`,
          [handle,guide.fingerprint,JSON.stringify(guide.products.map(p=>p.id))]);
        await client.query('INSERT INTO marketing_seo_attempts(handle) VALUES($1)',[handle]);
        await client.query('COMMIT');
      }catch(e){await client.query('ROLLBACK').catch(()=>{});throw e;}
      try {
        const page={title:guide.title,handle:guide.handle,body:guide.body,isPublished:true};
        const result=await graphql(remote?GUIDE_UPDATE:GUIDE_CREATE,remote?{id:remote.id,page}:{page});
        const payload=result?.[remote?'pageUpdate':'pageCreate'];
        if(payload?.userErrors?.length) {
          await client.query("UPDATE marketing_seo_pages SET status='failed',updated_at=now() WHERE handle=$1",[handle]);
          fail('SEO_PAGE_REJECTED');
        }
        const created=payload?.page;
        if(!/^gid:\/\/shopify\/Page\/\d+$/.test(created?.id||'')||created.handle!==handle||created.isPublished!==true)fail('SEO_PAGE_UNCONFIRMED');
        await savePublished(client,guide,created);published++;
        log('SEO_GUIDE_PUBLISHED',{handle,url:guide.url,sourceProducts:guide.products.length,updated:Boolean(remote),indexingConfirmed:false});
      }catch(e) {
        if(e.code!=='SEO_PAGE_REJECTED')await client.query("UPDATE marketing_seo_pages SET status='recovery_required',updated_at=now() WHERE handle=$1",[handle]);
        log('SEO_GUIDE_PENDING',{handle,reason:e.code||'SEO_PROVIDER_FAILED'});
      }
    }
    return {status:'enabled',published,paused,indexingConfirmed:false};
  }finally{if(locked)await client.query('SELECT pg_advisory_unlock(73341004)').catch(()=>{});client?.release();}
}
async function savePublished(client,guide,page) {
  await client.query(`UPDATE marketing_seo_pages SET status='published',shopify_id=$2,url=$3,
    body_hash=$4,published_at=COALESCE(published_at,now()),updated_at=now() WHERE handle=$1`,
    [guide.handle,page.id,guide.url,guide.fingerprint]);
}
