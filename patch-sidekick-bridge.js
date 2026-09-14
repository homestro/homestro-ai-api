const fs=require('fs');
const p='server.js';
let s=fs.readFileSync(p,'utf8');
if(s.includes('/api/sidekick/automation/run')){console.log('sidekick bridge already installed');process.exit(0);}
const marker='\napp.listen(';
const idx=s.indexOf(marker);
if(idx<0) throw new Error('app.listen marker not found');
const code=`
// HOMESTRO_SIDEKICK_RAILWAY_BRIDGE: Sidekick -> Railway -> Shopify
app.get('/api/sidekick/automation/status',sidekick,(_q,res)=>res.json({ok:true,source:'railway',enabled:process.env.HOMESTRO_AUTOPILOT_ENABLED!=='false',intervalMs:autopilotInterval(),running:autopilot.running,lastRun:autopilot.lastRun,lastError:autopilot.lastError,totals:{processed:autopilot.processed,rejected:autopilot.rejected,failed:autopilot.failed}}));
app.post('/api/sidekick/automation/run',sidekick,async(_q,res)=>{try{res.json(await autopilotRun());}catch(e){res.status(e.status||502).json({ok:false,error:e.message});}});
`;
s=s.slice(0,idx)+code+s.slice(idx);
fs.writeFileSync(p,s);
console.log('sidekick bridge installed');
