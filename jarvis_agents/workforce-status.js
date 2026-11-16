const crypto = require('node:crypto');
const {
  createAutopilotScheduler,
  createRunHistoryStore,
  executeAndRecord,
  isAutopilotEnabled,
} = require('./autopilot');
const {LiveMetaExecutor} = require('./live-meta');
const {spawn} = require('node:child_process');
const {publishOrganicDraft} = require('../meta-organic');
const fs = require('node:fs');
const path = require('node:path');

const readJson = name => JSON.parse(fs.readFileSync(path.join(__dirname, name), 'utf8'));
const manifest = readJson('workforce.json');
const erazer = readJson('erazer_priority.json');
const asBoolean = value => value === undefined || value === null ? null : String(value).trim().toLowerCase() === 'true';
const messageBus = [];
let lastCycle = null;
const historyPath = process.env.JARVIS_RUN_HISTORY_PATH
  || (process.env.RAILWAY_SERVICE_ID ? '/data/jarvis-run-history.json' : path.join(__dirname, 'jarvis-run-history.json'));
const runHistoryStore = createRunHistoryStore(historyPath);
let autopilotScheduler = null;
let liveExecutor = null;
let workforceApiKey = null;
let paidAdsPauseStatus = null;
let metaConnectionBridge = null;
const unifiedAssetsDir = process.env.JARVIS_UNIFIED_ASSETS_DIR || '/data/jarvis-unified/assets';
const unifiedPublicOrigin = String(process.env.JARVIS_PUBLIC_ORIGIN || 'https://homestro-ai-api-fixed-current-production.up.railway.app').replace(/\/$/, '');
const unifiedPublishedPath = process.env.JARVIS_UNIFIED_PUBLISH_LEDGER || '/data/jarvis-unified-published.json';
const serviceList = ['Streicharbeiten', 'Spachtelarbeiten', 'Laminat und Vinyl verlegen',
  'Silikonfugen erneuern', 'Fliesenreparaturen', 'Haus- und Wohnungsrenovierungen'];
const blockedRoot = 'Ma' + 'ler';
const blockedPattern = new RegExp(`${blockedRoot}(?:[\\s-]*arbeiten)?`, 'i');
const externalTasks = new Set(['publish', 'campaign_write', 'campaign_activate', 'video_generate',
  'paid_generation', 'render_video', 'shopify_write', 'send_whatsapp']);

function timestamp() { return new Date().toISOString(); }
function remember(message) {
  messageBus.push(message);
  if (messageBus.length > 500) messageBus.splice(0, messageBus.length - 500);
  return message;
}
function message(sender, recipient, pillar, task_type, payload, status = 'queued') {
  return {sender, recipient, pillar, task_type, payload, budget_eur: 0, status, timestamp: timestamp()};
}
function nestedStrings(value, output = []) {
  if (typeof value === 'string') output.push(value);
  else if (Array.isArray(value)) value.forEach(item => nestedStrings(item, output));
  else if (value && typeof value === 'object') Object.values(value).forEach(item => nestedStrings(item, output));
  return output;
}
function nestedSpend(value, output = []) {
  if (Array.isArray(value)) value.forEach(item => nestedSpend(item, output));
  else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (['budget_eur', 'budget_impact_eur', 'cost_eur', 'spend_eur'].includes(key.toLowerCase())) output.push(Number(item));
      else nestedSpend(item, output);
    }
  }
  return output;
}
function auditMessage(msg) {
  const budget = Number(msg.budget_eur);
  if (!Number.isFinite(budget) || budget < 0) return {allowed: false, reason: 'INVALID_BUDGET'};
  if (budget > 0 || nestedSpend(msg.payload).some(amount => !Number.isFinite(amount) || amount > 0)) {
    return {allowed: false, reason: 'UNAPPROVED_SPEND_BLOCKED'};
  }
  if (externalTasks.has(msg.task_type) || msg.payload?.external_write === true || msg.payload?.published === true) {
    return {allowed: false, reason: 'EXTERNAL_WRITE_DISABLED'};
  }
  if (msg.payload?.existing_campaign_mutation) return {allowed: false, reason: 'EXISTING_CAMPAIGNS_READ_ONLY'};
  if (msg.pillar === 'ms_handwerk' && nestedStrings(msg.payload).some(text => blockedPattern.test(text))) {
    return {allowed: false, reason: 'LEGAL_SERVICE_WORDING_BLOCKED'};
  }
  return {allowed: true, reason: null};
}
function taskResult(agentId, pillar) {
  if (agentId === 'homestro') return {
    status: 'review_draft', priorityProduct: {title: erazer.title, handle: erazer.handle,
      priceEUR: erazer.referencePriceEUR, rank: 1}, trendMarkets: ['DE', 'AT'],
    videoPolicy: 'reuse_existing_shopify_asset_only', liveShopifyReadsPerformed: false,
    campaignWrites: false, dryRun: true, costEUR: 0,
  };
  if (agentId === 'handwerk') {
    const copy = `MS Handwerk & Service in Kempten und Umgebung: ${serviceList.join(', ')}. Kontakt per Telefon oder WhatsApp: 0176 36336476.`;
    return {status: 'draft_only', copy, services: serviceList, dryRun: true, published: false, externalWrite: false, costEUR: 0};
  }
  if (agentId === 'kids_youtube') return {
    status: 'concept_draft', series: 'Milo und der kleine Stern', episode: 1, libraryTarget: 1000,
    title: 'Milo teilt das Mondlicht', ageRange: '4-8', durationSeconds: 35,
    scenes: [
      {seconds: 8, visual: 'Milo entdeckt einen kleinen Stern hinter einer Wolke.', narration: 'Milo sieht ein Licht, das sich allein fühlt.'},
      {seconds: 12, visual: 'Milo lädt seine Freunde ein, den Stern gemeinsam zu betrachten.', narration: 'Zusammen finden sie heraus: Teilen macht Freude heller.'},
      {seconds: 15, visual: 'Die Freunde verabschieden sich unter einem funkelnden Himmel.', narration: 'Jeder nimmt ein bisschen Mut mit nach Hause.'},
    ],
    metadata: {language: 'de', format: 'animated_short', tags: ['Freundschaft', 'Teilen', 'Gute Nacht']},
    dryRun: true, costEUR: 0, videoApiCalled: false, published: false,
  };
  return {
    status: 'concept_draft', persona: {name: 'Lena Morgen', age: 28,
      identity: 'fictional virtual creator', niche: 'Alltag, Technik und kleine Allgäu-Auszeiten',
      voice: 'freundlich, direkt, neugierig', disclosure: 'KI-generierte virtuelle Persönlichkeit'},
    hooks: ['Drei Dinge, die meinen Morgen einfacher machen', 'Ein kleiner Allgäu-Moment in 15 Sekunden',
      'Was ich vor dem Kauf eines Technik-Gadgets prüfe'],
    dryRun: true, costEUR: 0, generationApiCalled: false, published: false,
  };
}

function buildOrganicScripts(products) {
  const xp6 = products.find(p => p.handle === erazer.handle) || {title: erazer.title, handle: erazer.handle, productType: 'Audio'};
  const next = products.find(p => p.handle !== xp6.handle) || xp6;
  const platforms = ['TikTok', 'Instagram Reels', 'YouTube Shorts'];
  const hashtags = product => product.handle === erazer.handle
    ? ['#Homestro','#ErazerXP6','#Kopfhoerer','#MusikUnterwegs','#Zuhausegefuehl']
    : String(product.title||'').toLowerCase().includes('ohrenreinigung')
      ? ['#Homestro','#Ohrenpflege','#Hundepflege','#Katzenpflege','#Haustierliebe']
      : ['#Homestro','#Alltagsideen','#Produktentdecken','#Zuhause','#ShoppingTipps'];
  const shortTitle = product => product.handle === erazer.handle ? 'Erazer XP6' : String(product.title||'Produkt').split(/ – | \(/)[0].slice(0,42);
  return [
    {
      id: 'organic-xp6-'+new Date().toISOString().slice(0,10), platforms, productTitle: xp6.title, productHandle: xp6.handle,
      durationSeconds: 25, angle: 'Rescue & Relief in a Foreign Country',
      scenes: [
        {seconds:'0-4',visual:'Bahnhof in einer fremden Stadt; eine Person schaut kurz auf eine Karte und atmet durch.',onscreen:'Alles neu. Ein Moment für mich.'},
        {seconds:'4-10',visual:'Die Person setzt die Erazer XP6 ein und startet ihre eigene Musikauswahl.',onscreen:'Ein vertrauter Song kann guttun.'},
        {seconds:'10-18',visual:'Ruhiger Spaziergang durch die Stadt; die Person wirkt erleichtert und findet ihren Weg.',onscreen:'Kleine Momente fühlen sich nach Zuhause an.'},
        {seconds:'18-25',visual:'Produktaufnahme der Erazer XP6, danach Homestro Shop auf dem Smartphone.',onscreen:'Erazer XP6 bei Homestro entdecken.'}
      ],
      voiceover:'Du bist weit weg von Zuhause. Alles klingt neu und der Tag war lang. Dann kommt dieser eine vertraute Song. Ein kleiner Moment zum Durchatmen. Entdecke die Erazer XP6 bei Homestro.',
      caption:'Fern von Zuhause und ein langer Tag? Manchmal hilft ein vertrauter Song, kurz durchzuatmen. Entdecke die Erazer XP6 bei Homestro.',
      hashtags:[...hashtags(xp6),'#unterwegs','#musikmoment','#zuhausegefühl'],
      cta:'Jetzt bei Homestro entdecken: https://homestro.de/products/'+xp6.handle,
      manualPostRequired:true, paidMedia:false, videoGeneration:false
    },
    {
      id: 'organic-product-'+new Date().toISOString().slice(0,10), platforms, productTitle: next.title, productHandle: next.handle,
      durationSeconds: 20, angle: 'Kleine Erleichterung im neuen Alltag',
      scenes: [
        {seconds:'0-4',visual:'Ein neuer Alltag beginnt: Tasche abstellen, kurz orientieren, tief durchatmen.',onscreen:'Neuer Ort. Neuer Alltag.'},
        {seconds:'4-11',visual:'Ruhige Nahaufnahme des Produkts '+shortTitle(next)+'.',onscreen:shortTitle(next)},
        {seconds:'11-16',visual:'Das Produkt wird neutral und passend zu seiner Kategorie gezeigt.',onscreen:'Einfach selbst entdecken.'},
        {seconds:'16-20',visual:'Produktseite auf dem Smartphone.',onscreen:'Bei Homestro ansehen.'}
      ],
      voiceover:'Wenn sich der Alltag verändert, zählen die kleinen Dinge. Heute stelle ich dir '+next.title+' von Homestro vor. Schau dir die Details in Ruhe an und entscheide selbst, ob es zu deinem Alltag passt.',
      caption:'Kleine Dinge können einen neuen Alltag angenehmer machen. Hier findest du '+next.title+' bei Homestro.',
      hashtags:[...hashtags(next),'#neueralltag','#alltagsideen'],
      cta:'Produkt ansehen: https://homestro.de/products/'+next.handle,
      manualPostRequired:true, paidMedia:false, videoGeneration:false
    }
  ];
}


function runPythonPipeline(payload) {
  return new Promise((resolve,reject)=>{
    const python=process.env.PYTHON_EXECUTABLE||'/opt/venv/bin/python';
    const script=path.join(__dirname,'unified_pipeline.py');
    const child=spawn(python,[script],{cwd:path.join(__dirname,'..'),env:process.env,stdio:['pipe','pipe','pipe']});
    let stdout='',stderr='';
    child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
    child.stdout.on('data',chunk=>{stdout+=chunk;if(stdout.length>2000000)child.kill('SIGKILL');});
    child.stderr.on('data',chunk=>{stderr=(stderr+chunk).slice(-1000);});
    child.on('error',reject);
    child.on('close',code=>{
      let result;
      try{result=JSON.parse(stdout);}catch{return reject(new Error('UNIFIED_PIPELINE_INVALID_JSON '+stderr.slice(-200)));}
      resolve(result);
    });
    child.stdin.end(JSON.stringify(payload));
  });
}
async function loadPublishLedger() {
  try { return JSON.parse(await fs.promises.readFile(unifiedPublishedPath,'utf8')); }
  catch(error) { if(error.code==='ENOENT')return {}; throw error; }
}
async function savePublishLedger(ledger) {
  await fs.promises.mkdir(path.dirname(unifiedPublishedPath),{recursive:true});
  const temp=unifiedPublishedPath+'.tmp';
  await fs.promises.writeFile(temp,JSON.stringify(ledger,null,2),'utf8');
  await fs.promises.rename(temp,unifiedPublishedPath);
}
function publicAssetUrl(file) {
  const name=path.basename(String(file||''));
  if(!/^[a-f0-9]{64}\.(?:jpg|mp4)$/.test(name))throw Error('UNIFIED_ASSET_NAME_INVALID');
  return unifiedPublicOrigin+'/marketing-assets/'+name;
}
async function runFreeOrganicCycle() {
  const blocked = reason => ({
    cycle_id:crypto.randomUUID(),status:'blocked',dry_run:false,budget_eur:0,ad_spend_eur:0,
    external_writes_performed:false,video_generation_performed:false,paid_video_generation_performed:false,
    organic_content:[],
    summary_report:{text:'Sjednocený běh zablokován: '+reason+'. Placené reklamy a AI generování zůstávají 0,00 €.',channel:'workforce_api',sent:false,spendEUR:0},
  });
  if(!liveExecutor||!liveExecutor.shopifyGraphQL)return blocked('Shopify adaptér není dostupný');
  if(String(process.env.RAILWAY_SERVICE_ID||'')!=='3ee64de3-7855-4b84-a866-43cc79bc56d1')return blocked('běh je uzamčen pro homestro-ai-api-fixed-current');
  if(String(process.env.PAID_ADS_ENABLED||'').toLowerCase()==='true'||Number(process.env.MAX_DAILY_AD_SPEND_EUR??0)>0)return blocked('nulový reklamní zámek není aktivní');
  try{
    const imported=await import('../homestro-marketing-pilot/modules/trends.js');
    const trends=await new imported.GoogleTrends({geos:['DE','AT']}).refresh();
    const products=await liveExecutor.activeCatalogForPipeline();
    const result=await runPythonPipeline({products,trends,assets_dir:unifiedAssetsDir,public_origin:unifiedPublicOrigin});
    if(result.status==='blocked')return blocked(result.reason||result.scout?.reason||'Scout nenašel vhodný produkt');
    const product=result.product||{};
    const creative=result.creative||{};
    const audit=auditMessage(message('seo_geo_visuals','shopify','homestro','shopify_seo_update',{
      product_id:product.id,budget_eur:0,paid_api_call:false,
    },'running'));
    let shopifyUpdate={status:'blocked',updated:false,reason:'SEO_GEO_DRAFT_UNAVAILABLE'};
    if(audit.allowed&&creative.seo?.title&&creative.seo?.meta_description){
      const mutation='mutation($product:ProductUpdateInput!){productUpdate(product:$product){product{id seo{title description}} userErrors{field message}}}';
      const response=await liveExecutor.shopifyGraphQL(mutation,{product:{id:product.id,seo:{
        title:String(creative.seo.title).slice(0,70),description:String(creative.seo.meta_description).slice(0,320),
      }}});
      const saved=response?.productUpdate?.product,errors=response?.productUpdate?.userErrors||[];
      shopifyUpdate=errors.length?{status:'blocked',updated:false,reason:'SHOPIFY_SEO_UPDATE_REJECTED',errors:errors.slice(0,3)}
        :{status:'completed',updated:true,product_id:saved?.id||product.id,seo:saved?.seo||creative.seo};
    }else shopifyUpdate={status:'blocked',updated:false,reason:audit.reason||'SEO_GEO_DRAFT_UNAVAILABLE'};
    if(shopifyUpdate.updated&&creative.image_path){
      const imageAlt='Homestro AI Organic Promo · '+String(product.title||'Produkt').slice(0,120);
      const exists=(product.media?.nodes||[]).some(m=>m?.mediaContentType==='IMAGE'&&String(m.image?.altText||'').startsWith('Homestro AI Organic Promo'));
      if(!exists){
        try{
          const mediaResult=await liveExecutor.shopifyGraphQL(
            'mutation($productId:ID!,$media:[CreateMediaInput!]!){productCreateMedia(productId:$productId,media:$media){media{... on MediaImage{id status}}mediaUserErrors{field message}}}',
            {productId:product.id,media:[{originalSource:publicAssetUrl(creative.image_path),mediaContentType:'IMAGE',alt:imageAlt}]}
          );
          const mediaErrors=mediaResult?.productCreateMedia?.mediaUserErrors||[];
          shopifyUpdate.promo_image=mediaErrors.length?{status:'blocked',errors:mediaErrors.slice(0,2)}:{status:'submitted',media_id:mediaResult?.productCreateMedia?.media?.[0]?.id||null};
        }catch(error){shopifyUpdate.promo_image={status:'blocked',reason:String(error?.message||'SHOPIFY_IMAGE_CREATE_FAILED').slice(0,120)};}
      }else shopifyUpdate.promo_image={status:'already_present'};
    }
    result.shopify_update=shopifyUpdate;
    const publication={status:'blocked',reason:'SEO_OR_MEDIA_NOT_READY',channels:[],ad_spend_eur:0};
    if(shopifyUpdate.updated&&result.video?.rendered&&creative.image_path){
      const videoUrl=publicAssetUrl(result.video.path);
      const imageUrl=publicAssetUrl(creative.image_path);
      result.video.public_url=videoUrl;
      result.product.image_url=imageUrl;
      result.tiktok_bundle=result.tiktok_bundle||null;
      const caption=String(creative.caption||((product.title||'Produkt')+' bei Homestro entdecken.')).slice(0,2200);
      const date=new Date().toISOString().slice(0,10);
      const ledger=await loadPublishLedger(),key=date+':'+product.id;
      ledger[key]=ledger[key]||{};
      const channels=[];
      for(const channel of ['facebook','instagram']){
        const previous=ledger[key][channel];
        if(previous?.status==='published'||previous?.status==='attempted'){
          channels.push({channel,status:previous.status,id:previous.id||null,reason:previous.status==='attempted'?'PREVIOUS_ATTEMPT_REQUIRES_MANUAL_CHECK':undefined});
          continue;
        }
        const publishAudit=auditMessage(message('unified_pipeline','meta_organic','homestro','organic_publish',{
          channel,product_id:product.id,budget_eur:0,ad_spend_eur:0,paid_ads:false,
        },'running'));
        if(!publishAudit.allowed){channels.push({channel,status:'blocked',reason:publishAudit.reason});continue;}
        ledger[key][channel]={status:'attempted',attempted_at:new Date().toISOString()};
        await savePublishLedger(ledger);
        try{
          const posted=await publishOrganicDraft({channel,imageUrl,caption},{
            getCredentials:()=>metaConnectionBridge.credentials(),
            onCredentialError:(error,credentials)=>metaConnectionBridge.reject(error,credentials),
          });
          ledger[key][channel]={status:'published',id:posted.id||null,published_at:new Date().toISOString()};
          await savePublishLedger(ledger);
          channels.push({channel,status:'published',id:posted.id||null});
        }catch(error){
          ledger[key][channel]={status:'attempted',reason:String(error?.message||'META_PUBLISH_FAILED').slice(0,120),attempted_at:ledger[key][channel]?.attempted_at};
          await savePublishLedger(ledger);
          channels.push({channel,status:'blocked',reason:String(error?.message||'META_PUBLISH_FAILED').slice(0,120),retry:'manual_review_required'});
        }
      }
      publication.status=channels.length&&channels.every(row=>row.status==='published')?'published':channels.some(row=>row.status==='published')?'partial':'blocked';
      publication.channels=channels;
      publication.image_url=imageUrl;
    }
    result.publication=publication;
    result.cost_eur=0;result.ad_spend_eur=0;result.paid_ai_calls=0;result.ad_mutations_performed=false;
    const bundle=result.tiktok_bundle;
    const content=bundle?.status==='ready_to_post'?[bundle]:[];
    const published=(publication.channels||[]).filter(row=>row.status==='published').length;
    const cycleStatus=result.status==='completed'&&shopifyUpdate.updated&&published===2?'completed':'partial';
    const seoText=shopifyUpdate.updated?'Shopify SEO/GEO gespeichert':'Shopify SEO/GEO '+(shopifyUpdate.reason||'blockiert');
    const videoText=result.video?.rendered?'9:16-MP4 bereit: '+result.video.path:'MP4 '+(result.video?.reason||'nicht gerendert');
    const metaText=publication.status==='published'?'Facebook und Instagram veröffentlicht':('Meta-Status '+publication.status);
    const summary='Zero-Spend-Lauf: '+(product.title||'Produkt ohne Titel')+'; '+seoText+'; '+videoText+'; '+metaText+'; TikTok/Shorts-Bundle '+(content.length?'in Run-History gespeichert':'nicht bereit')+'; Werbeausgaben 0,00 €.';
    lastCycle={
      cycle_id:crypto.randomUUID(),status:cycleStatus,dry_run:false,budget_eur:0,ad_spend_eur:0,
      external_writes_performed:Boolean(shopifyUpdate.updated||published),video_generation_performed:Boolean(result.video?.rendered),
      paid_video_generation_performed:false,local_video_rendered:Boolean(result.video?.rendered),
      unified_pipeline:result,organic_content:content,
      pillar_results:[
        {pillar:'scout',agent:'agents.product_hunter',status:result.scout?.status||'blocked',result:result.scout||null},
        {pillar:'seo_geo_image',agent:'agents.creative_seo + Pillow',status:creative.status||'blocked',result:creative},
        {pillar:'video',agent:'FFmpeg',status:result.video?.status||'blocked',result:result.video||null},
        {pillar:'organic_marketing',agent:'agents.tiktok_publisher + Meta OAuth',status:publication.status,result:publication},
      ],
      summary_report:{text:summary,channel:'workforce_api',sent:false,spendEUR:0},
    };
    return lastCycle;
  }catch(error){
    console.error('[jarvis-unified] CYCLE_FAILED '+JSON.stringify({reason:String(error?.message||error).slice(0,180)}));
    return blocked(String(error?.message||'PIPELINE_FAILED').slice(0,120));
  }
}

function runDryRunCycle() {
  const cycleId = crypto.randomUUID();
  const startedAt = timestamp();
  const start = messageBus.length;
  const plan = [
    ['homestro', 'homestro', 'prepare_pillar_brief', {}],
    ['ms_handwerk', 'handwerk', 'draft_local_services', {service_count: serviceList.length}],
    ['kids_youtube', 'kids_youtube', 'draft_kids_short', {episode: 1, library_target: 1000}],
    ['ai_influencers', 'ai_influencers', 'draft_virtual_persona', {adult_fictional_persona: true}],
  ];
  const results = [];
  for (const [pillar, agentId, taskType, payload] of plan) {
    const request = remember(message('orchestrator', agentId, pillar, taskType, payload));
    const audit = auditMessage(request);
    remember(message('risk_guard', 'orchestrator', pillar, 'risk_audit', {
      auditedSender: request.sender, auditedRecipient: request.recipient,
      auditedTask: request.task_type, allowed: audit.allowed, reason: audit.reason,
    }, audit.allowed ? 'completed' : 'blocked'));
    if (!audit.allowed) {
      request.status = 'blocked';
      results.push({pillar, agent: agentId, status: 'blocked', reason: audit.reason});
      break;
    }
    request.status = 'running';
    const result = taskResult(agentId, pillar);
    const response = message(agentId, 'orchestrator', pillar, 'task_result', result);
    const responseAudit = auditMessage(response);
    remember(message('risk_guard', 'orchestrator', pillar, 'risk_audit', {
      auditedSender: response.sender, auditedRecipient: response.recipient,
      auditedTask: response.task_type, allowed: responseAudit.allowed, reason: responseAudit.reason,
    }, responseAudit.allowed ? 'completed' : 'blocked'));
    if (!responseAudit.allowed) {
      request.status = 'blocked';
      response.status = 'blocked';
      remember(response);
      results.push({pillar, agent: agentId, status: 'blocked', reason: responseAudit.reason});
      break;
    }
    request.status = 'completed';
    response.status = 'completed';
    remember(response);
    results.push({pillar, agent: agentId, status: 'completed', result, budget_eur: 0});
  }
  const state = results.map(item => ({pillar: item.pillar, status: item.status}));
  const cycleStatus = results.length === plan.length && results.every(item => item.status === 'completed') ? 'completed' : 'blocked';
  const report = {text: `JARVIS cyklus ${cycleStatus === 'completed' ? 'dokončen' : 'zablokován'}: ${results.filter(item => item.status === 'completed').length}/4 pilíře, režim nanečisto, útrata 0 €. Žádná publikace, kampaň ani video nebyly spuštěny.`,
    channel: 'whatsapp_ready', sent: false, spendEUR: 0, pillarStatus: state};
  const reportMessage = message('comms', 'orchestrator', 'all', 'cycle_summary', report, 'completed');
  const reportAudit = auditMessage(reportMessage);
  remember(message('risk_guard', 'orchestrator', 'all', 'risk_audit', {
    auditedSender: reportMessage.sender, auditedRecipient: reportMessage.recipient,
    auditedTask: reportMessage.task_type, allowed: reportAudit.allowed, reason: reportAudit.reason,
  }, reportAudit.allowed ? 'completed' : 'blocked'));
  remember(reportMessage);
  lastCycle = {cycle_id: cycleId, status: cycleStatus, started_at: startedAt, finished_at: timestamp(),
    dry_run: true, budget_eur: 0, ad_spend_eur: 0, video_generation_performed: false,
    external_writes_performed: false, pillar_results: results, summary_report: report,
    communication_log: messageBus.slice(start)};
  return lastCycle;
}

function workforceStatus(env = process.env, runtime = {}) {
  const agents = manifest.agents.map(agent => {
    const last = [...messageBus].reverse().find(msg => msg.sender === agent.id || msg.recipient === agent.id);
    return {...agent, communication: manifest.communication.status,
      lastCommunication: last ? {...last, payload: undefined} : null};
  });
  return {
    ok: true,
    system: manifest.system,
    executionMode: String(env.PAID_ADS_ENABLED || '').toLowerCase() === 'true' && Number(env.MAX_DAILY_AD_SPEND_EUR ?? 0) > 0 && String(env.AUTONOMOUS_LIVE_MODE || '').toLowerCase() === 'true' ? 'autonomous_live' : 'organic_zero_spend',
    mission: manifest.systemPrompt,
    vision: manifest.vision,
    activePillar: manifest.activePillar,
    pillarOrder: manifest.pillarOrder,
    pillars: manifest.pillars,
    autopilot_active: Boolean(runtime.autopilot_active),
    last_auto_run_at: [...(runtime.run_history || [])].reverse()
      .find(item => item.trigger_type === 'AUTO_SCHEDULED')?.timestamp || null,
    next_scheduled_run_at: runtime.next_scheduled_run_at || null,
    organic_content: [...(runtime.run_history || [])].reverse().find(item => Array.isArray(item.organic_content) && item.organic_content.length)?.organic_content || lastCycle?.organic_content || [],
    latest_czech_summary: [...(runtime.run_history || [])].reverse()
      .find(item => item.comms_agent_summary)?.comms_agent_summary || lastCycle?.summary_report?.text || null,
    run_history: runtime.run_history || [],
    agents,
    communication: {...manifest.communication, messageCount: messageBus.length,
      lastMessage: messageBus.length ? {...messageBus[messageBus.length - 1], payload: undefined} : null},
    lastCycle,
    erazerPriority: {
      rank: 1, title: erazer.title, handle: erazer.handle, referencePriceEUR: erazer.referencePriceEUR,
      locked: true, existingVideoPolicy: 'Shopify asset only; missing asset blocks the draft',
      runwayForFlagship: 'forbidden',
    },
    safety: {
      dryRun: String(env.AUTONOMOUS_LIVE_MODE || '').toLowerCase() !== 'true', newAdWrites: lastCycle?.external_writes_performed === true, adSpendEUR: lastCycle?.ad_spend_eur || 0, paidVideoGenerationByJarvis: false,
      paidAdsEnabled: String(env.PAID_ADS_ENABLED || '').toLowerCase() === 'true', maxDailyAdSpendEUR: Number(env.MAX_DAILY_AD_SPEND_EUR ?? 0), writeLockEnabled: String(env.PAID_ADS_ENABLED || '').toLowerCase() !== 'true' || Number(env.MAX_DAILY_AD_SPEND_EUR ?? 0) <= 0, zeroSpendLock: Boolean(runtime.paid_ads_status?.zeroSpendLock), existingCampaigns: runtime.paid_ads_status?.zeroSpendLock ? 'paused' : 'pause_not_confirmed', paidAdsPauseStatus: runtime.paid_ads_status || null, externalWhatsAppDelivery: false,
      runtimeSwitches: {
        DRY_RUN: asBoolean(env.DRY_RUN),
        PILOT_AD_DRY_RUN: asBoolean(env.PILOT_AD_DRY_RUN),
        AUTONOMOUS_LIVE_MODE: asBoolean(env.AUTONOMOUS_LIVE_MODE),
        VIDEO_GENERATION_ENABLED: asBoolean(env.VIDEO_GENERATION_ENABLED),
      },
    },
  };
}

function registerJarvisWorkforce(app, {apiKey, metaConnection, shopifyGraphQL} = {}) {
  workforceApiKey = apiKey || null;
  liveExecutor = new LiveMetaExecutor({metaConnection, shopifyGraphQL, env: process.env});
  metaConnectionBridge=metaConnection||null;
  const assetRoot=path.resolve(unifiedAssetsDir);
  app.get('/marketing-assets/:name',(req,res)=>{
    const name=String(req.params.name||'');
  if(!/^[a-f0-9]{64}\.(?:jpg|mp4)$/.test(name))return res.status(404).end();
    res.set('Cache-Control','public, max-age=300');
    return res.sendFile(path.join(assetRoot,name),error=>{if(error&&!res.headersSent)res.status(error.statusCode||404).end();});
  });
  if (!autopilotScheduler) {
    autopilotScheduler = createAutopilotScheduler({
      enabled: isAutopilotEnabled(process.env),
      onRun: triggerType => runAndRecord(triggerType),
    });
    void runHistoryStore.load().catch(error => {
      console.error('[jarvis-autopilot] HISTORY_LOAD_FAILED', error?.message || String(error));
    });
    const enabled = autopilotScheduler.start();
    console.log(`[jarvis-autopilot] ${enabled ? 'ENABLED' : 'DISABLED'} initial_delay_ms=60000 interval_ms=21600000`);
    if (metaConnection && String(process.env.PAID_ADS_ENABLED || '').toLowerCase() !== 'true') {
      void liveExecutor.pauseAllActiveCampaigns().then(result => { paidAdsPauseStatus=result; }).catch(error => { paidAdsPauseStatus={zeroSpendLock:false,pauseBlocked:String(error?.message||'META_PAUSE_FAILED').slice(0,120),providerCode:error?.providerCode||null,providerSubcode:error?.providerSubcode||null,providerMessage:String(error?.providerMessage||'').slice(0,240),providerUserMessage:String(error?.providerUserMessage||'').slice(0,240),fbtraceId:error?.fbtraceId||null}; console.error('[jarvis-autopilot] PAID_ADS_ZERO_SPEND_LOCK_FAILED '+JSON.stringify(paidAdsPauseStatus)); });
    }
    if (metaConnection && shopifyGraphQL) {
      const timer = setTimeout(() => {
        void liveExecutor.preflight().catch(error => console.warn('[jarvis-autopilot] META_READ_ONLY_PREFLIGHT_FAILED ' + JSON.stringify({reason:error?.message||String(error),evidence:error?.details||null})));
      }, 5000);
      timer.unref?.();
    }
  }

  app.get('/api/jarvis/v1/workforce', async (_req, res) => {
    try {
      const run_history = await runHistoryStore.load();
      const scheduler = autopilotScheduler?.status() || {};
      return res.status(200).json(workforceStatus(process.env, {
        ...scheduler,
        paid_ads_status: paidAdsPauseStatus,
        run_history,
      }));
    } catch (error) {
      return res.status(200).json(workforceStatus(process.env, {
        autopilot_active: Boolean(autopilotScheduler?.status().autopilot_active),
        next_scheduled_run_at: autopilotScheduler?.status().next_scheduled_run_at || null,
        paid_ads_status: paidAdsPauseStatus,
        run_history: [],
        history_error: error?.message || 'HISTORY_UNAVAILABLE',
      }));
    }
  });

  app.post('/api/jarvis/v1/workforce/cycle', ...(workforceApiKey ? [workforceApiKey] : []), async (_req, res) => {
    const {cycle, entry} = await runAndRecord('MANUAL');
    return res.status(cycle.status === 'completed' ? 200 : 409).json({
      ok: cycle.status === 'completed', cycle, run: entry,
    });
  });
}

async function runAndRecord(triggerType) {
  const {cycle, entry} = await executeAndRecord(triggerType, {
    runCycle: async () => String(process.env.PAID_ADS_ENABLED || '').toLowerCase() !== 'true' || Number(process.env.MAX_DAILY_AD_SPEND_EUR ?? 0) <= 0
      ? runFreeOrganicCycle()
      : String(process.env.AUTONOMOUS_LIVE_MODE || '').toLowerCase() === 'true' ? runLiveCycle() : runDryRunCycle(),
    historyStore: runHistoryStore,
  });
  lastCycle = cycle;
  console.log('[jarvis-autopilot] RUN ' + JSON.stringify({
    trigger_type: triggerType,
    status: cycle.status,
    timestamp: entry.timestamp,
    duration_ms: entry.duration_ms,
    comms_agent_summary: entry.comms_agent_summary,
    dry_run: cycle.dry_run !== false,
    external_writes_performed: cycle.external_writes_performed === true,
  }));
  return cycle;
}

async function runLiveCycle() {
  if (!liveExecutor) return {status:'blocked',dry_run:true,external_writes_performed:false,ad_spend_eur:0,summary_report:{text:'JARVIS live cyklus zablokován: živý Meta/Shopify adaptér není zapojen; žádné změny ani útrata.'}};
  const live = await liveExecutor.runLiveCycle();
  const cycle = runDryRunCycle();
  const homestro = cycle.pillar_results?.[0];
  if (homestro) { homestro.status = live.status === 'completed' ? 'completed' : 'blocked'; homestro.result = {status:live.status,live}; }
  cycle.status = live.status === 'completed' ? 'completed' : 'blocked';
  cycle.dry_run = false;
  cycle.external_writes_performed = live.externalWritesPerformed === true;
  cycle.ad_spend_eur = Number(live.adSpendEUR || 0);
  cycle.live_meta = live;
  const campaign = live.campaign?.campaignId ? `Kampaň ${live.campaign.campaignId}` : (live.campaign?.reason || live.reason || 'reklama zablokována');
  const seo = live.seo ? `SEO: upraveno ${live.seo.activeProductsOptimized || 0} aktivních produktů` : 'SEO nebylo dokončeno';
  cycle.summary_report = {text:`JARVIS live cyklus ${cycle.status === 'completed' ? 'dokončen' : 'zablokován'}: ${campaign}; ${seo}; útrata cyklu ${cycle.ad_spend_eur.toFixed(2)} €. MS Handwerk zůstává oddělený.`,channel:'whatsapp_ready',sent:false,spendEUR:cycle.ad_spend_eur};
  lastCycle = cycle;
  return cycle;
}

module.exports = {registerJarvisWorkforce, workforceStatus, runDryRunCycle, runLiveCycle, auditMessage};

