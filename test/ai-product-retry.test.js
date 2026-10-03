'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { extractOpenAiResponseText } = require('../openai-response');

const source = fs.readFileSync(require.resolve('../server.js'), 'utf8');
const body = source.slice(source.indexOf('async function aiProduct'), source.indexOf('\n\napp.post(\'/api/ai/product\''));
const plain = value => String(value || '').replace(/<[^>]*>/g, '').trim();
const sanitize = (product, input) => ({
  ...product,
  title: product.title || input.title,
  description: String(product.description || ''),
  seoTitle: product.seoTitle || product.title || input.title,
  seoDescription: product.seoDescription || plain(product.description),
  tags: product.tags || []
});
const load = consoleStub => new Function('cleanJson','homestroSanitizeProduct','homestroPlain','homestroStripEmoji','homestroCleanHandle','extractOpenAiResponseText','console',body+';return aiProduct;')(
  JSON.parse,sanitize,plain,value=>String(value || ''),()=> 'produkt',extractOpenAiResponseText,consoleStub
);
const response = product => ({ ok:true,status:200,text:async()=>JSON.stringify({output_text:JSON.stringify(product)}) });
const messageResponse = product => ({ ok:true,status:200,text:async()=>JSON.stringify({
  status:'completed',
  output:[
    {type:'reasoning',summary:[]},
    {type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:JSON.stringify(product),annotations:[]}]}
  ]
}) });
const product = length => ({title:'Deutsches Testprodukt',description:'<p>'+'D'.repeat(length)+'</p>',seoTitle:'Testprodukt',seoDescription:'Beschreibung'});

async function run(responses) {
  const calls=[];
  const logs=[];
  const originalFetch=global.fetch;
  const originalKey=process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY='test-key-not-logged';
  global.fetch=async(_url,request)=>{calls.push(JSON.parse(request.body));const next=responses.shift();if(next instanceof Error)throw next;return next;};
  try {
    const aiProduct=load({log:(...args)=>logs.push(args.join(' ')),error:(...args)=>logs.push(args.join(' '))});
    return {result:await aiProduct({title:'Quelle',description:'Belegte Quelldaten'}),calls,logs};
  } finally {
    global.fetch=originalFetch;
    if(originalKey===undefined)delete process.env.OPENAI_API_KEY;else process.env.OPENAI_API_KEY=originalKey;
  }
}

test('top-level output_text containing valid JSON is parsed without retry', async()=>{
  const {result,calls}=await run([response(product(1000))]);
  assert.equal(result.fallback,false);
  assert.equal(calls.length,1);
});

test('Responses API assistant output_text content is parsed as valid product JSON', async()=>{
  const {result,calls}=await run([messageResponse(product(1000))]);
  assert.equal(result.fallback,false);
  assert.equal(plain(result.product.description).length,1000);
  assert.equal(calls.length,1);
});

test('missing or empty assistant text produces a safe structural diagnostic', async()=>{
  const {result,logs}=await run([{
    ok:true,status:200,text:async()=>JSON.stringify({status:'completed',secret:'must-not-appear',output:[
      {type:'reasoning',summary:[{text:'private reasoning'}]},
      {type:'message',role:'assistant',content:[{type:'output_text',text:'   '},{type:'refusal',refusal:'private refusal'}]}
    ]})
  }]);
  assert.equal(result.fallback,true);
  assert.match(result.reason,/httpStatus=200,responseStatus=completed,outputStructure=reasoning\[\]\|message:assistant\[output_text,refusal\]/);
  assert.doesNotMatch(result.reason+logs.join('\n'),/must-not-appear|private reasoning|private refusal/);
});

test('short first description is repaired once and successful repair is used', async()=>{
  const {result,calls,logs}=await run([response(product(200)),response(product(1000))]);
  assert.equal(result.fallback,false);
  assert.equal(result.retried,true);
  assert.equal(calls.length,2);
  assert.match(logs.join('\n'),/AI PRODUCT DESCRIPTION RETRY currentLength=200/);
  assert.match(logs.join('\n'),/AI PRODUCT DESCRIPTION RETRY SUCCESS length=1000/);
  const repairText=calls[1].input[1].content[0].text;
  assert.match(repairText,/"currentDescriptionLength": 200/);
  assert.match(repairText,/"firstGeneratedProduct"/);
  assert.match(repairText,/"sourceProduct"/);
});

test('short repair result uses local fallback', async()=>{
  const {result,calls,logs}=await run([response(product(200)),response(product(300))]);
  assert.equal(result.fallback,true);
  assert.equal(calls.length,2);
  assert.match(logs.join('\n'),/AI PRODUCT DESCRIPTION RETRY FAILED/);
});

test('repair API error uses local fallback', async()=>{
  const {result,calls,logs}=await run([response(product(200)),new Error('repair unavailable')]);
  assert.equal(result.fallback,true);
  assert.equal(calls.length,2);
  assert.match(logs.join('\n'),/AI PRODUCT DESCRIPTION RETRY FAILED repair unavailable/);
  assert.doesNotMatch(logs.join('\n'),/test-key-not-logged/);
});
