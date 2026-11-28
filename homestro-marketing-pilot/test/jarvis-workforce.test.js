import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';

const require=createRequire(import.meta.url);
const {registerJarvisWorkforce,workforceStatus,runDryRunCycle,auditMessage,buildOrganicScripts}=require('../../jarvis_agents/workforce-status.js');

test('organic scripts are deterministic, German, fact-based and always return two zero-cost drafts',()=>{
  const handle='lenovo-erazer-xp6-bluetooth-in-ear-kopfhoerer-ipx5';
  const product={id:'gid://shopify/Product/1',handle,title:'Lenovo Erazer XP6',descriptionHtml:'<ul><li>Leicht zu reinigen.</li></ul>',variants:[{price:'19.90'}]};
  const scripts=buildOrganicScripts([product]);
  assert.equal(scripts.length,2);
  for(const script of scripts){
    assert.equal(script.productHandle,handle);
    assert.equal(script.manualPostRequired,true);
    assert.equal(script.paidMedia,false);
    assert.equal(script.videoGeneration,false);
    assert.match(script.voiceover,/Leicht zu reinigen/);
    assert.match(script.voiceover,/19,90 €/);
    assert.doesNotMatch(`${script.voiceover} ${script.caption}`,/Was macht .* im Alltag leichter\?|Gate B14|Klarna/i);
  }
  assert.deepEqual(buildOrganicScripts([{...product,handle:'dog-bathing-brush-pet-massage-shampoo-dispenser-rubber-bristle-shower-grooming-tool-for-dogs-and-cats'}]),[]);
  assert.deepEqual(buildOrganicScripts([{...product,status:'ARCHIVED'}]),[]);
});

test('workforce status is read-only, reports the flagship lock and safe runtime flags',async()=>{
  const status=workforceStatus({DRY_RUN:'true',PILOT_AD_DRY_RUN:'true',VIDEO_GENERATION_ENABLED:'false'});
  assert.equal(status.erazerPriority.rank,1);
  assert.equal(status.erazerPriority.handle,'lenovo-erazer-xp6-bluetooth-in-ear-kopfhoerer-ipx5');
  assert.equal(status.erazerPriority.referencePriceEUR,47.99);
  assert.equal(status.safety.adSpendEUR,0);
  assert.equal(status.safety.existingCampaigns,'read_only_untouched');
  assert.equal(status.safety.paidAdsEnabled,false);
  assert.equal(status.safety.paidAdsPauseStatus.campaignMutationPerformed,false);
  assert.equal(status.safety.runtimeSwitches.VIDEO_GENERATION_ENABLED,false);
  assert.equal(status.agents.length,6);

  const routes=new Map();
  const app={get(path,handler){routes.set(path,handler);},post(){}};
  registerJarvisWorkforce(app);
  let statusCode;
  let body;
  await routes.get('/api/jarvis/v1/workforce')({}, {status(code){statusCode=code;return this;},json(value){body=value;return this;}});
  assert.equal(statusCode,200);
  assert.equal(body.ok,true);
  assert.equal(body.erazerPriority.locked,true);
  assert.equal(body.safety.newAdWrites,false);
  assert.equal(body.script_count,0);
  assert.equal(body.script_generation.external_ai_called,false);
  assert.ok(body.agents.every(agent=>agent.mission && agent.communication));
});

test('workforce cycle coordinates four dry-run pillars and records audits',()=>{
  const cycle=runDryRunCycle();
  assert.equal(cycle.status,'completed');
  assert.deepEqual(cycle.pillar_results.map(item=>item.pillar),['homestro','ms_handwerk','kids_youtube','ai_influencers']);
  assert.equal(cycle.budget_eur,0);
  assert.equal(cycle.ad_spend_eur,0);
  assert.equal(cycle.video_generation_performed,false);
  assert.equal(cycle.external_writes_performed,false);
  assert.ok(cycle.communication_log.some(item=>item.task_type==='risk_audit'));
  assert.equal(cycle.summary_report.sent,false);
  assert.equal(cycle.pillar_results[2].result.videoApiCalled,false);
  assert.equal(cycle.pillar_results[3].result.generationApiCalled,false);
});

test('risk guard blocks positive spend and restricted local copy',()=>{
  const spend={sender:'orchestrator',recipient:'kids_youtube',pillar:'kids_youtube',task_type:'draft_kids_short',payload:{cost_eur:1},budget_eur:0};
  assert.equal(auditMessage(spend).reason,'UNAPPROVED_SPEND_BLOCKED');
  const restricted='Ma'+'ler';
  const handwerk={sender:'orchestrator',recipient:'handwerk',pillar:'ms_handwerk',task_type:'draft_local_services',payload:{copy:`${restricted} in Kempten`},budget_eur:0};
  assert.equal(auditMessage(handwerk).reason,'LEGAL_SERVICE_WORDING_BLOCKED');
});

test('POST cycle endpoint returns the coordinated zero-cost report',async()=>{
  const routes=new Map();
  const app={get(){},post(path,handler){routes.set(path,handler);}};
  registerJarvisWorkforce(app);
  let statusCode;
  let responseBody;
  await routes.get('/api/jarvis/v1/workforce/cycle')({}, {status(code){statusCode=code;return this;},json(value){responseBody=value;return this;}});
  assert.equal(statusCode,409);
  assert.equal(responseBody.ok,false);
  assert.equal(responseBody.cycle.status,'blocked');
  assert.equal(responseBody.cycle.ad_spend_eur,0);
  assert.match(responseBody.cycle.summary_report.text,/Shopify adaptér není dostupný/);
  assert.equal(responseBody.cycle.budget_eur,0);
});
