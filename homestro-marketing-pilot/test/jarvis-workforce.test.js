import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';

const require=createRequire(import.meta.url);
const {registerJarvisWorkforce,workforceStatus}=require('../../jarvis_agents/workforce-status.js');

test('workforce status is read-only, reports the flagship lock and safe runtime flags',async()=>{
  const status=workforceStatus({DRY_RUN:'true',PILOT_AD_DRY_RUN:'true',VIDEO_GENERATION_ENABLED:'false'});
  assert.equal(status.erazerPriority.rank,1);
  assert.equal(status.erazerPriority.handle,'lenovo-erazer-xp6-bluetooth-in-ear-kopfhoerer-ipx5');
  assert.equal(status.erazerPriority.referencePriceEUR,47.99);
  assert.equal(status.safety.adSpendEUR,0);
  assert.equal(status.safety.existingCampaigns,'read_only_untouched');
  assert.equal(status.safety.runtimeSwitches.VIDEO_GENERATION_ENABLED,false);
  assert.equal(status.agents.length,5);

  let route;
  const app={get(path,handler){assert.equal(path,'/api/jarvis/v1/workforce');route=handler;}};
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
