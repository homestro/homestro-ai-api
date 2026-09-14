const fs=require('fs');
const p='server.js';
let s=fs.readFileSync(p,'utf8');
const before='function rules(){return{maxCost:Number(process.env.MAX_PRODUCT_COST||10),minSellingPrice:Number(process.env.MIN_SELLING_PRICE||34.9),minRatio:Number(process.env.MIN_PRICE_COST_RATIO||3)}}';
const after='function rules(){return{maxCost:Number(process.env.MAX_PRODUCT_COST||12),minSellingPrice:Number(process.env.MIN_SELLING_PRICE||0),minRatio:Number(process.env.MIN_PRICE_COST_RATIO||3)}}';
if(s.includes(before)) s=s.replace(before,after);
const route="app.get('/api/automation/status-public',(_q,res)=>res.json({ok:true,enabled:process.env.HOMESTRO_AUTOPILOT_ENABLED!=='false',intervalMs:autopilotInterval(),running:autopilot.running,lastRun:autopilot.lastRun,lastError:autopilot.lastError,totals:{processed:autopilot.processed,rejected:autopilot.rejected,failed:autopilot.failed}}));";
if(!s.includes('/api/automation/status-public')){
  const marker='\napp.listen(';
  const idx=s.indexOf(marker);
  if(idx<0) throw new Error('app.listen marker not found');
  s=s.slice(0,idx)+'\n'+route+s.slice(idx);
}
fs.writeFileSync(p,s);
console.log('rules/status patch applied');
