const test=require('node:test');
const assert=require('node:assert/strict');

const {detectEuWarehouse}=require('../sourcing-evidence');
function evidence(v){return detectEuWarehouse(v).confirmed;}

test('recognizes concrete European warehouse countries in Apify-shaped data',()=>{
 assert.equal(evidence({shipping:{shipFromCountry:'Poland'}}),true);
 assert.equal(evidence({shipping:{warehouseCountry:'Spain'}}),true);
 assert.equal(evidence({variants:[{warehouse:{country:'Belgium'}}]}),true);
 assert.equal(evidence({shipping:{originCountryCode:'DE'}}),true);
});

test('does not treat China as EU warehouse',()=>{
 assert.equal(evidence({shipping:{shipFromCountry:'China'}}),false);
 assert.equal(evidence({variants:[{warehouse:{country:'CN'}}]}),false);
});
