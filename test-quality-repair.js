const assert=require('assert');
const q=require('./homestro-quality-repair');
assert.equal(q.optionNameForValues('Farbe',['Heat-Massage','HOT-MASSAGE-TRACTION']),'Ausführung');
assert.equal(q.germanVariantLabel('HOT-MASSAGE-TRACTION'),'Wärme + Massage + Traktion');
const repaired=q.repairVariantOptions([
 {id:'1',selectedOptions:[{name:'Color',value:'Heat-Massage'}]},
 {id:'2',selectedOptions:[{name:'Color',value:'HOT_MASSAGE'}]}
]);
assert.deepEqual(repaired.map(v=>v.selectedOptions[0].name),['Ausführung','Ausführung']);
assert.deepEqual(repaired.map(v=>v.selectedOptions[0].value),['Wärme + Massage','Wärme + Massage – Variante 2']);
const longDescription='Natürlich formulierter deutscher Produkttext. '.repeat(25);
assert.equal(q.qualityCheck({title:'Massagekissen',description:longDescription,seoTitle:'Massagekissen',seoDescription:'Massagekissen für den Alltag',variants:[]}).ok,true);
assert.equal(q.qualityCheck({title:'Produkt laut Herstellerangaben',description:'Electronic: No',seoTitle:'Produkt',seoDescription:'Test',variants:[]}).ok,false);
assert.deepEqual(q.qualityCheck({title:'Massagekissen',description:longDescription,seoTitle:'SEO',seoDescription:'SEO Text',variants:[{selectedOptions:[{name:'Farbe',value:'Heat'}]}]}).reasons,['raw-variant-label','functional-variant-as-color']);
console.log('quality repair tests passed');
