'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const {summarizeAutopilotResults}=require('../autopilot-results');
test('skips never count as processed and pending remain distinct from complete',()=>{
 const summary=summarizeAutopilotResults([{id:'missing',processed:false,skipped:true,reason:'source-missing',pendingChecks:['supplier-link']},{id:'draft',processed:true,complete:false,qa:{reasons:['landed-cost-unverified']}},{id:'done',processed:true,complete:true},{id:'fail',processed:false,error:'supplier timeout'}]);
 assert.equal(summary.processed,2);assert.equal(summary.complete,1);assert.equal(summary.skipped,1);assert.equal(summary.pending,2);assert.equal(summary.failed,1);
 assert.deepEqual(summary.products[0].pendingChecks,['supplier-link']);
});
