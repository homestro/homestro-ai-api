import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {socialReviewPage} from '../modules/social-review.js';
class Element {
 constructor(tag){this.tagName=tag.toUpperCase();this.children=[];this.value='';this.checked=false;this.disabled=false;this.dataset={};}
 append(n){n.parent=this;this.children.push(n);}prepend(n){n.parent=this;this.children.unshift(n);}
 replaceChildren(){this.children=[];}scrollIntoView(){}
 get nextElementSibling(){return this.parent?.children[this.parent.children.indexOf(this)+1];}
 querySelectorAll(selector){const tags=selector.split(',').map(x=>x.toUpperCase()),out=[];for(const child of this.children){if(tags.includes(child.tagName))out.push(child);out.push(...child.querySelectorAll(selector));}return out;}
}
function descendants(root){return root.children.flatMap(n=>[n,...descendants(n)]);}
async function fixture(partial=false){
 const nodes=Object.fromEntries(['key','reviewer','load','message','posts','bulk','schedule'].map(id=>[id,new Element(id==='load'?'button':'div')]));
 nodes.key.value='not-a-real-key';nodes.reviewer.value='Mirko';const writes=[];
 const document={getElementById:id=>nodes[id],createElement:tag=>new Element(tag)};
 const fetch=async(path,opts)=>{
  let result;
  if(path.endsWith('/status'))result={configured:true,publishEveryHours:4,maximumDailyPerChannel:6,publishAroundClock:true};
  else if(path.endsWith('/posts'))result=[0,1].map(i=>({id:'job-'+i,revision:'draft-'+i,channel:'tiktok',payload:{title:'Produkt '+i,caption:'Preview',format:'carousel',imageURLs:[],productURL:'https://homestro.de/products/test'}}));
  else if(path.endsWith('/tiktok-settings'))result={privacyLevels:[{value:'PUBLIC_TO_EVERYONE'}],postingLimits:{interactionSettings:{allow_comment:{enabled:true}}}};
  else if(path.endsWith('/approve')){writes.push({path,body:JSON.parse(opts.body)});if(partial&&path.includes('job-1'))return {ok:false,json:async()=>({error:'SOCIAL_REVIEW_STALE'})};result={status:'approved'};}
  return {ok:true,json:async()=>result};
 };
 const script=socialReviewPage('test').match(/<script[^>]*>([\s\S]*?)<\/script>/)[1];
 vm.runInNewContext(script,{document,fetch});await nodes.load.onclick();
 const panel=()=>descendants(nodes.bulk),all=panel().find(n=>n.tagName==='BUTTON'&&n.textContent.startsWith('Vybrat'));
 const batch=panel().find(n=>n.tagName==='BUTTON'&&n.textContent==='Schválit vybranou dávku');
 return {nodes,writes,panel,all,batch};
}
async function consent(f){
 f.all.onclick();assert.equal(f.batch.disabled,true);assert.equal(f.writes.length,0);
 const inputs=f.panel().filter(n=>n.tagName==='INPUT'),privacy=f.panel().find(n=>n.tagName==='SELECT');
 privacy.value='PUBLIC_TO_EVERYONE';privacy.onchange();
 inputs.at(-2).checked=true;inputs.at(-2).onchange();assert.equal(f.batch.disabled,true);
 inputs.at(-1).checked=true;inputs.at(-1).onchange();assert.equal(f.batch.disabled,false);
}
test('bulk UI needs actual user preview and consent, then sends each frozen draft revision once',async()=>{
 const f=await fixture();await consent(f);await f.batch.onclick();assert.equal(f.writes.length,2);
 f.writes.forEach((w,i)=>{assert.equal(w.body.expectedRevision,'draft-'+i);assert.equal(w.body.tiktokSettings.express_consent_given,true);assert.equal(w.body.tiktokSettings.content_preview_confirmed,true);});
 assert.equal(f.nodes.posts.children.filter(n=>n.dataset.approved==='true').length,2);
 assert.equal(f.nodes.load.disabled,false);assert.equal(f.batch.disabled,true);
});
test('batch failure preserves remaining unapproved item and never silently retries it',async()=>{
 const f=await fixture(true);await consent(f);await f.batch.onclick();
 assert.equal(f.writes.length,2);assert.equal(f.nodes.posts.children.filter(n=>n.dataset.approved==='true').length,1);
 assert.match(f.nodes.message.textContent,/SOCIAL_REVIEW_STALE/);assert.equal(f.batch.disabled,true);
});
test('changing the selected manifest clears previous batch consent',async()=>{
 const f=await fixture();await consent(f);f.all.onclick();assert.equal(f.batch.disabled,true);
 f.all.onclick();assert.equal(f.batch.disabled,true);assert.equal(f.writes.length,0);
});
