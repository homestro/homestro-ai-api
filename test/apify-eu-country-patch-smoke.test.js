const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('fs');
test('runtime includes concrete-country Apify warehouse detector',()=>{
 const s=fs.readFileSync('sourcing-evidence.js','utf8');
 assert.match(s,/\['GERMANY', 'Germany'\]/);
 assert.match(s,/shipFromCountry/);
 assert.match(s,/DESTINATION_FIELDS/);
});
