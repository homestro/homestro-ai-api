const fs=require('fs');
const p='server.js';
let s=fs.readFileSync(p,'utf8');
const start=s.indexOf('async function getClientToken()');
const end=s.indexOf('\nfunction b64',start);
if(start<0||end<0)throw new Error('getClientToken block not found');
const fn=`async function getClientToken(){const c=cfg();if(!c.domain)throw Object.assign(new Error('Shopify is not configured.'),{status:503});const direct=String(process.env.SHOPIFY_ACCESS_TOKEN||process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN||'').trim();if(direct)return direct;if(!c.clientId||!c.clientSecret)throw Object.assign(new Error('Shopify credentials are not configured.'),{status:503});if(cached.token&&Date.now()<cached.expires-60000)return cached.token;const body=new URLSearchParams({client_id:c.clientId,client_secret:c.clientSecret,grant_type:'client_credentials'});const r=await fetch(\`https://\${c.domain}/admin/oauth/access_token\`,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded','Accept':'application/json'},body});const text=await r.text();let d={};try{d=JSON.parse(text);}catch{throw Object.assign(new Error(\`Shopify token endpoint returned HTTP \${r.status} instead of JSON (content-type: \${r.headers.get('content-type')||'unknown'}). Check Shopify app credentials/installation.\`),{status:502});}if(!r.ok||!d.access_token)throw Object.assign(new Error(d.error_description||d.error||\`Shopify token request failed (HTTP \${r.status})\`),{status:502});cached={token:d.access_token,expires:Date.now()+Number(d.expires_in||86400)*1000};return cached.token;}`;
s=s.slice(0,start)+fn+s.slice(end);
fs.writeFileSync(p,s);
console.log('Shopify auth fixed: form-urlencoded + direct token fallback');
// Railway trigger: keep this patch in the watched set.
