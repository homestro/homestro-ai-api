import test from 'node:test';
import assert from 'node:assert/strict';
import {articleDraftInput,createSeoArticleDraft,productSeoArticle,publishNextSeoArticle} from '../modules/seo-articles.js';

const valid={title:'Ordnung im kleinen Flur: praktische Ideen',handle:'ordnung-kleiner-flur',
  summary:'Praktische, alltagstaugliche Hinweise für mehr Ordnung in einem kleinen Flur.',
  body:'Ein klarer Plan hilft, den vorhandenen Platz besser zu nutzen.\n\nMiss zuerst Breite, Höhe und Tiefe des Bereichs. Notiere, welche Gegenstände dort regelmäßig abgelegt werden. Vergleiche mögliche Lösungen anhand der tatsächlichen Maße und der Produktangaben.\n\nRäume häufig benutzte Dinge in gut erreichbare Bereiche. Lege Schlüssel und andere Alltagsgegenstände an einen festen Platz. Beginne mit einer kleinen Fläche und prüfe nach einigen Tagen, ob die Anordnung im Alltag funktioniert.\n\nVor dem Kauf solltest du Maße, Materialangaben und Varianten sorgfältig vergleichen. Verwende für Pflege und Reinigung ausschließlich die Hinweise des Herstellers. So bleibt die Auswahl an den verfügbaren Angaben orientiert, ohne Eigenschaften zu unterstellen, die nicht belegt sind. Halte die wichtigsten Maße und Anforderungen schriftlich fest. Prüfe anschließend noch einmal, ob die ausgewählte Lösung zum vorgesehenen Platz und zur geplanten Nutzung passt.',
  tags:['Ordnung','Flur']};
const config={blogId:'gid://shopify/Blog/105535177023',author:'Homestro Redaktion'};

test('creates escaped Shopify article body as a private draft',()=>{
  const article=articleDraftInput({...config,input:{...valid,body:valid.body+' <b>mark</b>'}});
  assert.equal(article.isPublished,false);
  assert.equal(article.blogId,config.blogId);
  assert.ok(article.body.includes('&lt;b&gt;mark&lt;/b&gt;'));
  assert.ok(!article.body.includes('<script>'));
  assert.ok(article.body.startsWith('<p>'));
});

test('builds a product-specific German article only from reviewed available product facts',()=>{
  const product={id:'gid://shopify/Product/12345',status:'ACTIVE',contentReviewed:true,rejected:false,
    url:'https://homestro.de/products/ordnungsbox-kueche',variants:[{available:true,price:19.9}],localized:{
      title:'Aufbewahrungsbox für die Küche',searchTitle:'Aufbewahrungsbox Küche',
      description:'Diese Aufbewahrungsbox ist für die übersichtliche Aufbewahrung in der Küche beschrieben. Prüfe vor dem Kauf die Maße und Varianten auf der Produktseite.',
      benefits:[{text:'Die Box besitzt einen Deckel.'},{text:'Sie ist in mehreren Varianten verfügbar.'},{text:'Die angegebenen Maße stehen auf der Produktseite.'}]}};
  const article=productSeoArticle(product);
  assert.ok(article);
  assert.ok(article.body.length>=800);
  assert.match(article.handle,/ordnungsbox-kueche-ratgeber-12345$/);
  assert.equal(article.productUrl,product.url);
  assert.equal(productSeoArticle({...product,status:'DRAFT'}),null);
  assert.equal(productSeoArticle({...product,rejected:true}),null);
  assert.equal(productSeoArticle({...product,variants:[{available:false,price:19.9}]}),null);
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
    if(vars.query)return {articles:{nodes:[],pageInfo:{hasNextPage:false}}};
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
  const result=await createSeoArticleDraft({pool,graphql:async(_query,vars)=>{
    if(vars.query)return {articles:{nodes:[],pageInfo:{hasNextPage:false}}};
    mutationCalled=true;
  },...config,input:valid});
  assert.equal(result.created,false);
  assert.equal(result.id,'gid://shopify/Article/10');
  assert.equal(committed,true);
  assert.equal(mutationCalled,false);
});

test('auto-publishes at most one deduplicated fact-based article per day and links to the product',async()=>{
  const product={id:'gid://shopify/Product/12345',status:'ACTIVE',contentReviewed:true,rejected:false,
    url:'https://homestro.de/products/ordnungsbox-kueche',variants:[{available:true,price:19.9}],localized:{
      title:'Aufbewahrungsbox für die Küche',searchTitle:'Aufbewahrungsbox Küche',
      description:'Diese Aufbewahrungsbox ist für die übersichtliche Aufbewahrung in der Küche beschrieben. Prüfe vor dem Kauf die Maße und Varianten auf der Produktseite.',
      benefits:[{text:'Die Box besitzt einen Deckel.'},{text:'Sie ist in mehreren Varianten verfügbar.'},{text:'Die angegebenen Maße stehen auf der Produktseite.'}]}};
  let status='creating',mutation;
  const client={query:async(sql,params=[])=>{
    if(sql==='BEGIN'||sql==='COMMIT')return {rowCount:0,rows:[]};
    if(sql.includes('INSERT INTO marketing_seo_articles'))return {rowCount:1,rows:[{handle:params[0]}]};
    if(sql.includes('UPDATE marketing_seo_articles')){status=params[2];return {rowCount:1,rows:[]};}
    throw new Error('Unexpected SQL '+sql);
  },release(){}};
  const pool={connect:async()=>client,query:async(sql,params=[])=>{
    if(sql.includes("WHERE status='published'"))return {rows:[{count:0}]};
    if(sql.includes('SELECT handle,status FROM marketing_seo_articles'))return {rows:[]};
    if(sql.includes('UPDATE marketing_seo_articles')){status=params[2];return {rowCount:1,rows:[]};}
    throw new Error('Unexpected pool SQL '+sql);
  }};
  const result=await publishNextSeoArticle({pool,graphql:async(query,vars)=>{
    if(vars.query)return {articles:{nodes:[],pageInfo:{hasNextPage:false}}};
    mutation=vars.article;
    return {articleCreate:{article:{id:'gid://shopify/Article/55',handle:vars.article.handle,isPublished:true},userErrors:[]}};
  },products:[product],...config});
  assert.equal(result.status,'published');
  assert.equal(result.published,1);
  assert.equal(status,'published');
  assert.equal(mutation.isPublished,true);
  assert.ok(mutation.body.includes('https://homestro.de/products/ordnungsbox-kueche'));
  assert.ok(mutation.tags.some(x=>x.startsWith('homestro-pilot-')));
});
