const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const readJson = name => JSON.parse(fs.readFileSync(path.join(__dirname, name), 'utf8'));
const manifest = readJson('workforce.json');
const erazer = readJson('erazer_priority.json');
const asBoolean = value => value === undefined || value === null ? null : String(value).trim().toLowerCase() === 'true';
const messageBus = [];
let lastCycle = null;
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
  const report = {text: `JARVIS ${cycleStatus}: ${results.filter(item => item.status === 'completed').length}/4 pilíře, dry-run, útrata 0 €. Žádná publikace, kampaň ani video nebyly spuštěny.`,
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

function workforceStatus(env = process.env) {
  const agents = manifest.agents.map(agent => {
    const last = [...messageBus].reverse().find(msg => msg.sender === agent.id || msg.recipient === agent.id);
    return {...agent, communication: manifest.communication.status,
      lastCommunication: last ? {...last, payload: undefined} : null};
  });
  return {
    ok: true,
    system: manifest.system,
    executionMode: manifest.executionMode,
    mission: manifest.systemPrompt,
    vision: manifest.vision,
    activePillar: manifest.activePillar,
    pillarOrder: manifest.pillarOrder,
    pillars: manifest.pillars,
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
      dryRun: true, newAdWrites: false, adSpendEUR: 0, paidVideoGenerationByJarvis: false,
      existingCampaigns: 'read_only_untouched', externalWhatsAppDelivery: false,
      runtimeSwitches: {
        DRY_RUN: asBoolean(env.DRY_RUN),
        PILOT_AD_DRY_RUN: asBoolean(env.PILOT_AD_DRY_RUN),
        VIDEO_GENERATION_ENABLED: asBoolean(env.VIDEO_GENERATION_ENABLED),
      },
    },
  };
}

function registerJarvisWorkforce(app) {
  app.get('/api/jarvis/v1/workforce', (_req, res) => res.status(200).json(workforceStatus()));
  app.post('/api/jarvis/v1/workforce/cycle', (_req, res) => {
    const cycle = runDryRunCycle();
    return res.status(cycle.status === 'completed' ? 200 : 409).json({ok: cycle.status === 'completed', cycle});
  });
}

module.exports = {registerJarvisWorkforce, workforceStatus, runDryRunCycle, auditMessage};
