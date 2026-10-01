const assert=require('assert');
const q=require('./homestro-quality-repair');
assert.equal(q.optionNameForValues('Farbe',['Heat-Massage','HOT-MASSAGE-TRACTION']),'Ausführung');
assert.equal(q.germanVariantLabel('HOT-MASSAGE-TRACTION'),'Wärme + Massage + Traktion');
assert.equal(q.qualityCheck({title:'Massagekissen',description:'Praktisches Massagekissen',seoTitle:'Massagekissen',seoDescription:'Massagekissen für den Alltag',variants:[]}).ok,true);
assert.equal(q.qualityCheck({title:'Produkt laut Herstellerangaben',description:'Electronic: No',seoTitle:'Produkt',seoDescription:'Test',variants:[]}).ok,false);
console.log('quality repair tests passed');
