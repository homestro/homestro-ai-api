const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('fs');
test('build patch includes concrete-country Apify warehouse detector',()=>{
 const s=fs.readFileSync('patch-autopilot-quality.js','utf8');
 assert.match(s,/countryPattern='Germany\|Deutschland\|Poland\|Polen/);
 assert.match(s,/shippingBlob/);
 assert.match(s,/variantsBlob/);
 assert.match(s,/homestroEuWarehouseValue\(warehouse\)/);
});
