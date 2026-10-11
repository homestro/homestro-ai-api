import test from 'node:test';
import assert from 'node:assert/strict';
import {articleDraftInput,createSeoArticleDraft} from '../modules/seo-articles.js';

const valid={title:'Ordnung im kleinen Flur: praktische Ideen',handle:'ordnung-kleiner-flur',
  summary:'Praktische, alltagstaugliche Hinweise für mehr Ordnung in einem kleinen Flur.',
  body:'Ein klarer Plan hilft, den vorhandenen Platz besser zu nutzen.\n\nMiss zuerst Breite, Höhe und Tiefe des Bereichs. Notiere, welche Gegenstände dort regelmäßig abgelegt werden. Vergleiche mögliche Lösungen anhand der tatsächlichen Maße und der Produktangaben.\n\nRäume häufig benutzte Dinge in gut erreichbare Bereiche. Lege Schlüssel und andere Alltagsgegenstände an einen festen Platz. Beginne mit einer kleinen Fläche und prüfe nach einigen Tagen, ob die Anordnung im Alltag funktioniert.\n\nVor dem Kauf solltest du Maße, Materialangaben und Varianten sorgfältig vergleichen. Verwende für Pflege und Reinigung ausschließlich die Hinweise des Herstellers. So bleibt die Auswahl an den verfügbaren Angaben orientiert, ohne Eigenschaften zu unterstellen, die nicht belegt sind.',
  tags:['Ordnung','Flur']};
const config={blogId:'gid://shopify/Blog/105535177023',author:'Homestro Redaktion'};

test('creates escaped Shopify article body as a private draft',()=>{
  const article=articleDraftInput({...config,input:{...valid,body:valid.body+' <script>alert(1)</script>'}});
  assert.equal(article.isPublished,false);
  assert.equal(article.blogId,config.blogId);
  assert.ok(article.body.includes('&lt;script&gt;'));
  assert.ok(!article.body.includes('<script>'));
  assert.ok(article.body.startsWith('<p>'));
});

test('rejects short, unsafe, malformed, or unconfigured article input',()=>{
  assert.throws(()=>articleDraftInput({...config,input:{...valid,body:'too short'}}),e=>e.code==='SEO_ARTICLE_CONTENT_INVALID');
  assert.throws(()=>articleDraftInput({...config,input:{...valid,handle:'Bad Handle'}}),e=>e.code==='SEO_ARTICLE_HANDLE_INVALID');
  assert.throws(()=>articleDraftInput({...config,input:{...valid,body:valid.body+' <iframe src=x></iframe>'}}),e=>e.code==='SEO_ARTICLE_CONTENT_INVALID');
  assert.throws(()=>articleDraftInput({blogId:'',input:valid}),e=>e.code==='SEO_BLOG_NOT_CONFIGURED');
});

test('creates a draft once and returns the Shopify-confirmed result',async()=>{
  let captured,created=false;
  const client={query:async(sql,params=[])=>{
    if(sql==='BEGIN'||sql==='COMMIT')return {rowCount:0,rows:[]};
    if(sql.includes('INSERT INTO marketing_seo_articles'))return {rowCount:1,rows:[{handle:params[0]}]};
    if(sql.includes('UPDATE marketing_seo_articles'))return {rowCount:1,rows:[]};
    throw new Error('Unexpected SQL');
  },release(){}};
  const pool={connect:async()=>client,query:async()=>({rowCount:1,rows:[]})};
  const result=await createSeoArticleDraft({pool,graphql:async(_query,vars)=>{
    captured=vars.article;
    return {articleCreate:{article:{id:'gid://shopify/Article/10',isPublished:false},userErrors:[]}};
  },...config,input:valid});
  created=true;
  assert.ok(created);
  assert.equal(result.created,true);
  assert.equal(result.isPublished,false);
  assert.equal(captured.isPublished,false);
  assert.equal(captured.handle,valid.handle);
});

test('does not create a duplicate when a Shopify draft is already recorded',async()=>{
  let mutationCalled=false,committed=false;
  const client={query:async(sql)=>{
    if(sql==='BEGIN')return {rows:[]};
    if(sql==='COMMIT'){committed=true;return {rows:[]};}
    if(sql.includes('INSERT INTO marketing_seo_articles'))return {rowCount:0,rows:[]};
    if(sql.includes('SELECT content_hash'))return {rows:[{content_hash:undefined,shopify_id:'gid://shopify/Article/10',status:'draft_created'}]};
    throw new Error('Unexpected SQL');
  },release(){}};
  // The fingerprint is intentionally obtained through a prior valid input.
  const {hash}=await import('../modules/core.js');
  const article=articleDraftInput({...config,input:valid});
  const fingerprint=hash(article);
  client.query=async(sql,params=[])=>{
    if(sql==='BEGIN')return {rows:[]};
    if(sql==='COMMIT'){committed=true;return {rows:[]};}
    if(sql.includes('INSERT INTO marketing_seo_articles'))return {rowCount:0,rows:[]};
    if(sql.includes('SELECT content_hash'))return {rows:[{content_hash:fingerprint,shopify_id:'gid://shopify/Article/10',status:'draft_created'}]};
    throw new Error('Unexpected SQL');
  };
  const pool={connect:async()=>client,query:async()=>({rowCount:1,rows:[]})};
  const result=await createSeoArticleDraft({pool,graphql:async()=>{mutationCalled=true;},...config,input:valid});
  assert.equal(result.created,false);
  assert.equal(result.id,'gid://shopify/Article/10');
  assert.equal(committed,true);
  assert.equal(mutationCalled,false);
});
