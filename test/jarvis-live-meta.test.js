'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {ACCOUNT_ID,DAILY_CAP_EUR,START_BUDGET_EUR,accountBudgetDecision,LiveMetaExecutor}=require('../jarvis_agents/live-meta');

test('account-wide spend gate blocks at the exact cap and above',()=>{
  assert.equal(DAILY_CAP_EUR,0);
  assert.equal(START_BUDGET_EUR,5);
  const exact=accountBudgetDecision({accountId:ACCOUNT_ID,currency:'EUR',spendTodayEur:2,activeDailyBudgetsEur:3,proposedDailyBudgetEur:5});
  assert.equal(exact.allowed,false);assert.equal(exact.reason,'META_ACCOUNT_DAILY_CAP_REACHED');
  const over=accountBudgetDecision({accountId:ACCOUNT_ID,currency:'EUR',spendTodayEur:10,activeDailyBudgetsEur:0});
  assert.equal(over.allowed,false);
});

test('account-wide spend gate allows only valid EUR commitments strictly below cap',()=>{
  const ok=accountBudgetDecision({accountId:ACCOUNT_ID,currency:'EUR',spendTodayEur:1,activeDailyBudgetsEur:2,proposedDailyBudgetEur:5,capEur:10});
  assert.equal(ok.allowed,true);assert.equal(ok.committedDailyEur,8);
  assert.equal(accountBudgetDecision({accountId:'act_123',currency:'EUR',spendTodayEur:0,activeDailyBudgetsEur:0,capEur:10}).reason,'META_AD_ACCOUNT_MISMATCH');
  assert.equal(accountBudgetDecision({accountId:ACCOUNT_ID,currency:'USD',spendTodayEur:0,activeDailyBudgetsEur:0,capEur:10}).reason,'META_ACCOUNT_CURRENCY_MUST_BE_EUR');
  assert.equal(accountBudgetDecision({accountId:ACCOUNT_ID,currency:'EUR',spendTodayEur:NaN,activeDailyBudgetsEur:0,capEur:10}).reason,'META_ACCOUNT_BUDGET_DATA_INVALID');
});

test('live switch fails closed before token lookup when disabled',async()=>{
  let tokenReads=0;
  const executor=new LiveMetaExecutor({env:{AUTONOMOUS_LIVE_MODE:'false',META_AD_ACCOUNT_ID:ACCOUNT_ID},metaConnection:{credentials:async()=>{tokenReads++;throw Error('should not read')}}});
  const result=await executor.runLiveCycle();
  assert.equal(result.reason,'META_ADS_READ_ONLY');assert.equal(tokenReads,0);
});

test('Meta executor is strictly read-only even if paid ads are accidentally enabled',async()=>{
  let tokenReads=0;
  const executor=new LiveMetaExecutor({env:{PAID_ADS_ENABLED:'true',MAX_DAILY_AD_SPEND_EUR:'99',AUTONOMOUS_LIVE_MODE:'true'},metaConnection:{credentials:async()=>{tokenReads++;throw Error('must not read credentials')}}});
  const result=await executor.runLiveCycle();
  assert.equal(result.reason,'META_ADS_READ_ONLY');
  assert.equal(result.externalWritesPerformed,false);
  assert.equal(result.adSpendEUR,0);
  assert.equal(tokenReads,0);
  assert.equal(typeof executor.pauseAllActiveCampaigns,'undefined');
});

test('OAuth user token is preferred and environment token is the fallback',async()=>{
  const oauth=new LiveMetaExecutor({env:{META_AD_ACCOUNT_ID:ACCOUNT_ID},metaConnection:{
    check:async()=>({state:'connected'}),credentials:async()=>({userToken:'oauth-user-token',adAccountId:ACCOUNT_ID}),
  }});
  assert.equal(await oauth.token(),'oauth-user-token');
  const fallback=new LiveMetaExecutor({env:{META_ACCESS_TOKEN:'env-fallback'},metaConnection:{
    check:async()=>({state:'reauth_required'}),credentials:async()=>{throw Error('not expected')},
  },logger:{warn(){}}});
  assert.equal(await fallback.token(),'env-fallback');
});

test('OAuth token is not accepted for a different selected account',async()=>{
  const fallback=new LiveMetaExecutor({env:{META_ACCESS_TOKEN:'env-fallback'},metaConnection:{
    check:async()=>({state:'connected'}),credentials:async()=>({userToken:'wrong-account-token',adAccountId:'act_123'}),
  },logger:{warn(){}}});
  assert.equal(await fallback.token(),'env-fallback');
});
