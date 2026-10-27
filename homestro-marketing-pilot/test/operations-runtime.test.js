import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {once} from 'node:events';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {attachMarketing} from '../modules/index.js';
import {config} from '../modules/core.js';

test('real attachMarketing mounts protected operations/provider/quote routes and starts/stops the durable coordinator',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'pilot-runtime-'));let server,instance,report;
 try{
  const key='test-owner-private-key-at-least-32-characters';
  const app=express();app.use(express.json());
  const query=async(sql,args=[])=>{
   if(sql.includes('pg_try_advisory_lock'))return {rows:[{locked:true}]};
   if(sql.startsWith('INSERT INTO marketing_daily_operations'))report=args[1];
   if(sql.startsWith('SELECT report FROM marketing_daily_operations'))return {rows:report?[{report}]:[]};
   return {rows:[],rowCount:0};
  };
  const pool={query,connect:async()=>({query,release(){}})};
  const cfg={...config({PILOT_DATA_DIR:dir,PILOT_ADMIN_KEY:key}),social:null};
  instance=await attachMarketing(app,{pool,cfg,graphql:async()=>assert.fail('disabled runtime must not call Shopify'),localizer:async()=>assert.fail('must not generate')});
  assert.equal(instance.enabled,true);assert.ok(instance.operations.timer);
  server=app.listen(0,'127.0.0.1');await once(server,'listening');
  const url='http://127.0.0.1:'+server.address().port;
  for(const path of ['/operations','/providers/openai'])assert.equal((await fetch(url+'/api/marketing/v2'+path)).status,401);
  const headers={Authorization:'Bearer '+key,'Content-Type':'application/json'};
  const response=await fetch(url+'/api/marketing/v2/operations',{headers});
  assert.equal(response.status,200);const body=await response.json();
  assert.equal(body.brand,'Homestro');assert.equal(body.adSpendAuthorizedEUR,0);assert.equal(body.generationPerformed,false);
  assert.equal(body.planning.blockers[0].reason,'PUBLISHING_DISABLED');
  const provider=await (await fetch(url+'/api/marketing/v2/providers/openai',{headers})).json();
  assert.equal(provider.generationPerformed,false);assert.equal(JSON.stringify(provider).includes(key),false);
  const quote=await fetch(url+'/api/marketing/v2/generated-videos/quote',{method:'POST',headers,body:'{}'});
  assert.notEqual(quote.status,404); // Route exists; invalid/missing source is not a price or generation.
  instance.stop();assert.equal(instance.operations.timer,null);
 }finally{instance?.stop();if(server)await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true});}
});
