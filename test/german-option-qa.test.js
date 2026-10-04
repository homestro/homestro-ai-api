'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeOptionName, qaProduct } = require('../autopilot-core');
const { contentReadiness } = require('../content-readiness');
test('imported color aliases rename the option without touching variant commerce data', () => {
  for (const name of ['Color Name', 'colour name', 'Color_Name', 'color-name']) {
    const variant = { id:'variant-1', sku:'200000182:193#White', price:'18.17', selectedOptions:[{name,value:'Weiß'}] };
    const normalized = {...variant,selectedOptions:variant.selectedOptions.map(o=>({...o,name:normalizeOptionName(o.name)}))};
    assert.equal(normalized.selectedOptions[0].name,'Farbe');
    assert.equal(normalized.id,variant.id);
    assert.equal(normalized.sku,variant.sku);
    assert.equal(normalized.price,variant.price);
  }
});
test('QA cannot mark a product with an untranslated option name content-complete', () => {
  const product = {status:'DRAFT',variants:[{price:'18.17',selectedOptions:[{name:'Color Name',value:'Weiß'}]}]};
  const qa = qaProduct(product);
  assert.ok(qa.reasons.includes('variant-option-name:0'));
  assert.ok(contentReadiness(qa,{aiSucceeded:true,imagesVerified:true}).pendingReasons.includes('variant-option-name:0'));
  product.variants[0].selectedOptions[0].name='Farbe';
  assert.ok(!qaProduct(product).reasons.includes('variant-option-name:0'));
});
test('QA distinguishes real size and eyelash-curl labels from unresolved supplier codes', () => {
  for (const [name,value] of [['Größe','S'],['Größe','M'],['Größe','L'],['Schwung','C']]) {
    assert.ok(!qaProduct({variants:[{selectedOptions:[{name,value}]}]}).reasons.includes('variant-label:0'));
  }
  assert.ok(qaProduct({variants:[{selectedOptions:[{name:'Farbe',value:'A'}]}]}).reasons.includes('variant-label:0'));
});
test('legacy composite color translations match words, not literal backslashes', () => {
  const source=require('node:fs').readFileSync(require('node:path').join(__dirname,'../server.js'),'utf8');
  const body=source.slice(source.indexOf('function homestroVariantLabel('),source.indexOf('function homestroGermanOptionName('));
  const context={homestroStripEmoji:s=>String(s),normalizeVariantValue:require('../autopilot-core').normalizeVariantValue};
  require('node:vm').createContext(context); require('node:vm').runInContext(body,context);
  assert.equal(context.homestroVariantLabel('Sky Blue'),'Himmelblau');
  assert.equal(context.homestroVariantLabel('2 pcs Black'),'2 Stück Schwarz');
  assert.equal(context.homestroVariantLabel('Grey Camo'),'Tarnmuster Grau');
});
