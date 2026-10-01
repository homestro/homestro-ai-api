const assert = require('assert');
const fs = require('fs');

const source = fs.readFileSync('server.js', 'utf8');
assert.match(source, /if\(!p\)throw new Error\('Product not found'\);if\(String\(p\.status\)!=='DRAFT'\)throw new Error\('Safety guard: only DRAFT products may be modified'\)/);
assert.match(source, /if\(!checked\|\|String\(checked\.status\)!=='DRAFT'\)throw new Error\('Safety guard: product is no longer DRAFT'\)/);
assert.match(source, /HOMESTRO_ACCEPTANCE_PRODUCT_ID='16104465301886'/);
assert.match(source, /HOMESTRO_BULK_AUTOPILOT_ENABLED==='true'/);
assert.doesNotMatch(source, /tags\.push\('homestro-ai-images-verified','homestro-ai-complete'\)/);
assert.match(source, /if\(!profitPending&&!imagePending&&!qualityPending\)finalTags\.push\('homestro-ai-complete'\)/);
console.log('autopilot safety tests passed');
