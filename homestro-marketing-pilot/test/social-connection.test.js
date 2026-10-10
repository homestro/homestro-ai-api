import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectSocialConnection} from '../modules/social-connection.js';
const id='6aca3f628a43e7f438cb0f87';
const env={ZERNIO_API_KEY:'secret',ZERNIO_PINTEREST_ACCOUNT_ID:id};
test('setup discovery uses only GET and strips credentials and unrelated board fields',async()=>{
  const result=await inspectSocialConnection(env,async(url,options)=>{
    assert.equal(options.method,'GET');
    return {ok:true,json:async()=>url.endsWith('/accounts')?
      {accounts:[{_id:id,platform:'pinterest',isActive:true,accessToken:'secret'}]}:
      {boards:[{id:'123',name:'Homestro',privacy:'PUBLIC',accessToken:'secret'}]}};
  });
  assert.deepEqual(result,{accounts:[{id,platform:'pinterest',username:''}],boards:[{id:'123',name:'Homestro',privacy:'PUBLIC'}]});
  assert.ok(!JSON.stringify(result).includes('secret'));
});
test('setup discovery rejects wrong connected account before listing boards',async()=>{
  let calls=0;
  await assert.rejects(inspectSocialConnection(env,async()=>{calls++;return {ok:true,json:async()=>({accounts:[]})};}));
  assert.equal(calls,1);
});
