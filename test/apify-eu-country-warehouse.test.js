const test=require('node:test');
const assert=require('node:assert/strict');

const countries=/Germany|Deutschland|Poland|Polen|Czechia|Czech Republic|Tschechien|Spain|Spanien|France|Frankreich|Italy|Italien|Netherlands|Niederlande|Belgium|Belgien|Austria|Österreich|DE|PL|CZ|ES|FR|IT|NL|BE|AT/i;
function evidence(v){
 const text=JSON.stringify(v||{});
 return countries.test(text)&&/(warehouse|stock|ship|shipping|delivery|origin)/i.test(text);
}

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
