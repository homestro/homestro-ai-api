import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';

const require=createRequire(import.meta.url);
const {registerJarvisWorkforce,workforceStatus,runDryRunCycle,auditMessage}=require('../../jarvis_agents/workforce-status.js');

test('workforce status is read-only, reports the flagship lock and safe runtime flags',async()=>{
  const status=workforceStatus({DRY_RUN:'true',PILOT_AD_DRY_RUN:'true',VIDEO_GENERATION_ENABLED:'false'});
  assert.equal(status.erazerPriority.rank,1);
  assert.equal(status.erazerPriority.handle,'lenovo-erazer-xp6-bluetooth-in-ear-kopfhoerer-ipx5');
  assert.equal(status.erazerPriority.referencePriceEUR,47.99);
  assert.equal(status.safety.adSpendEUR,0);
  assert.equal(status.safety.existingCampaigns,'read_only_untouched');
  assert.equal(status.safety.runtimeSwitches.VIDEO_GENERATION_ENABLED,false);
  assert.equal(status.agents.length,6);

  let route;
  const app={get(path,handler){assert.equal(path,'/api/jarvis/v1/workforce');route=handler;},post(){}};
  registerJarvisWorkforce(app);
  let statusCode;
  let body;
  route({}, {status(code){statusCode=code;return this;},json(value){body=value;return this;}});
  assert.equal(statusCode,200);
  assert.equal(body.ok,true);
  assert.equal(body.erazerPriority.locked,true);
  assert.equal(body.safety.newAdWrites,false);
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

test('POST cycle endpoint returns the coordinated zero-cost report',()=>{
  let postRoute;
  const app={get(){},post(path,handler){assert.equal(path,'/api/jarvis/v1/workforce/cycle');postRoute=handler;}};
  registerJarvisWorkforce(app);
  let statusCode;
  let responseBody;
  postRoute({}, {status(code){statusCode=code;return this;},json(value){responseBody=value;return this;}});
  assert.equal(statusCode,200);
  assert.equal(responseBody.ok,true);
  assert.equal(responseBody.cycle.pillar_results.length,4);
  assert.equal(responseBody.cycle.budget_eur,0);
});
