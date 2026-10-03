'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const {summarizeAutopilotResults}=require('../autopilot-results');
test('skips never count as processed and pending remain distinct from complete',()=>{
 const summary=summarizeAutopilotResults([{id:'missing',processed:false,skipped:true,reason:'source-missing',pendingChecks:['supplier-link']},{id:'draft',processed:true,complete:false,qa:{reasons:['landed-cost-unverified']}},{id:'done',processed:true,complete:true},{id:'fail',processed:false,error:'supplier timeout'}]);
 assert.equal(summary.processed,2);assert.equal(summary.complete,1);assert.equal(summary.skipped,1);assert.equal(summary.pending,2);assert.equal(summary.failed,1);
 assert.deepEqual(summary.products[0].pendingChecks,['supplier-link']);
});

test('actual background runner records skipped sources instead of successful processing', async()=>{
 const fs=require('node:fs');
 const source=fs.readFileSync(require.resolve('../server.js'),'utf8');
 const runner=source.slice(source.indexOf('async function draftAutopilotRun(){'),source.indexOf('\nasync function catalogRun(){'));
 const state={running:false,processed:0};
 const invoke=new Function('draftAutopilotState','getClientToken','shopifyGraphQL','isDsersImportedCandidate','processExistingDraftProduct','summarizeAutopilotResults','console',runner+';return draftAutopilotRun();');
 await invoke(state,async()=> 'test',async()=>({products:{nodes:[{id:'missing'},{id:'ready'}]}}),()=>true,async id=>id==='missing'?{id,processed:false,skipped:true,reason:'source-missing'}:{id,processed:true,complete:true},summarizeAutopilotResults,{log(){},error(){}});
 assert.equal(state.processed,1);assert.equal(state.skipped,1);assert.equal(state.lastResult.complete,1);assert.equal(state.lastError,null);assert.equal(state.running,false);
});

test('missing supplier evidence is counted as processed pending rather than skipped',()=>{
 const summary=summarizeAutopilotResults([{id:'dsers-draft',processed:true,skipped:false,complete:false,reason:'verified-supplier-reference-missing',pendingChecks:['supplier-verification','variant-landed-cost']}]);
 assert.equal(summary.processed,1);
 assert.equal(summary.pending,1);
 assert.equal(summary.skipped,0);
 assert.equal(summary.complete,0);
});
