const fs = require('node:fs');

const path = 'server.js';
const marker = 'HOMESTRO_SHOPIFY_READ_REPORTS_SCOPE_V1';
let source = fs.readFileSync(path, 'utf8');
if (source.includes(marker)) {
  console.log('Shopify read_reports patch already present');
  process.exit(0);
}

const oldScope = "const scopes=encodeURIComponent('write_products,read_products,write_content');";
const newScope = "const scopes=encodeURIComponent('read_reports,read_products,write_products,write_files,write_content');";
if (!source.includes(oldScope)) {
  throw new Error('Shopify OAuth scope target not found; refusing to patch an unexpected server.js');
}
source = source.replace(oldScope, newScope);

const oldDirectToken = "const direct=String(process.env.SHOPIFY_ACCESS_TOKEN||process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN||'').trim();if(direct)return direct;if(!c.clientId||!c.clientSecret)throw Object.assign(new Error('Shopify credentials are not configured.'),{status:503});";
const newDirectToken = "const direct=String(process.env.SHOPIFY_ACCESS_TOKEN||process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN||'').trim();if(!c.clientId||!c.clientSecret){if(direct)return direct;throw Object.assign(new Error('Shopify credentials are not configured.'),{status:503});}";
if (!source.includes(oldDirectToken)) {
  throw new Error('Shopify token precedence target not found; refusing to patch an unexpected server.js');
}
source = source.replace(oldDirectToken, newDirectToken);

const oldTokenFailure = "if(!r.ok||!d.access_token)throw Object.assign(new Error(d.error_description||d.error||`Shopify token request failed (HTTP ${r.status})`),{status:502});";
const newTokenFailure = "if(!r.ok||!d.access_token){if(direct)return direct;throw Object.assign(new Error(d.error_description||d.error||`Shopify token request failed (HTTP ${r.status})`),{status:502});}";
if (!source.includes(oldTokenFailure)) {
  throw new Error('Shopify token error fallback target not found; refusing to patch an unexpected server.js');
}
source = source.replace(oldTokenFailure, newTokenFailure);
source = source.replace("async function getClientToken(){", "// " + marker + "\nasync function getClientToken(){");

fs.writeFileSync(path, source);
console.log('Applied Shopify read_reports OAuth and token refresh patch');
