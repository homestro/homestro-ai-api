const fs=require('fs');
const p='server.js';
let s=fs.readFileSync(p,'utf8');
if(s.includes('HOMESTRO_RAILWAY_SIDEKICK_QUEUE')){console.log('queue already installed');process.exit(0);}
const marker='\napp.listen(';
const idx=s.indexOf(marker);
if(idx<0) throw new Error('app.listen marker not found');
const code=`
// HOMESTRO_RAILWAY_SIDEKICK_QUEUE: Railway is the brain; Sidekick is the executor.
const railwayTaskQueue=[];
const railwayTaskResults=new Map();
function queueTask(task){const id='ht-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2,8);const item={id,createdAt:new Date().toISOString(),status:'queued',...task};railwayTaskQueue.push(item);return item;}
app.get('/api/sidekick/tasks/next',sidekick,(_q,res)=>{const task=railwayTaskQueue.find(x=>x.status==='queued');if(!task)return res.json({ok:true,task:null});task.status='leased';task.leasedAt=new Date().toISOString();res.json({ok:true,task});});
app.post('/api/sidekick/tasks/:id/result',sidekick,(q,res)=>{const task=railwayTaskQueue.find(x=>x.id===q.params.id);if(!task)return res.status(404).json({ok:false,error:'Task not found'});task.status='completed';task.completedAt=new Date().toISOString();task.result=q.body||{};railwayTaskResults.set(task.id,task.result);res.json({ok:true,task});});
app.get('/api/sidekick/tasks/status',sidekick,(_q,res)=>res.json({ok:true,queued:railwayTaskQueue.filter(x=>x.status==='queued').length,leased:railwayTaskQueue.filter(x=>x.status==='leased').length,completed:railwayTaskQueue.filter(x=>x.status==='completed').length}));
`;
s=s.slice(0,idx)+code+s.slice(idx);fs.writeFileSync(p,s);console.log('queue installed');