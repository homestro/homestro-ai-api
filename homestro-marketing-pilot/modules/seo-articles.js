import {hash,fail,productURL} from './core.js';

export const ARTICLE_CREATE = `mutation PilotArticleDraft($article: ArticleCreateInput!) {
  articleCreate(article: $article) {
    article { id title handle isPublished }
    userErrors { field message }
  }
}`;
export const ARTICLE_LOOKUP = `query PilotArticleLookup($query:String!) {
  articles(first:3,query:$query) { nodes { id handle title isPublished tags blog { id } } pageInfo { hasNextPage endCursor } }
}`;

const plain=value=>String(value??'').replace(/<[^>]*>/g,' ').replace(/\s+/g,' ').trim();
const escapeHtml=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function articleDraftInput({blogId,author,input,publish=false}) {
  const title=plain(input?.title),summary=plain(input?.summary),body=String(input?.body||'').trim();
  const handle=String(input?.handle||'').trim().toLowerCase();
  const tags=Array.isArray(input?.tags)?input.tags.map(plain).filter(Boolean):[];
  if(!/^gid:\/\/shopify\/Blog\/\d+$/.test(blogId||''))fail('SEO_BLOG_NOT_CONFIGURED');
  if(!title||title.length<10||title.length>100||!summary||summary.length<40||summary.length>320)fail('SEO_ARTICLE_CONTENT_INVALID');
  if(!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(handle)||handle.length>100)fail('SEO_ARTICLE_HANDLE_INVALID');
  if(body.length<800||body.length>15000||/<\/?(?:script|style|iframe|object|form)\b/i.test(body))fail('SEO_ARTICLE_CONTENT_INVALID');
  if(tags.length>5||tags.some(x=>x.length>40))fail('SEO_ARTICLE_TAGS_INVALID');
  let productUrl=null;
  if(input?.productUrl) {
    try {const u=productURL(input.productUrl);if(u.origin!=='https://homestro.de'||!u.pathname.startsWith('/products/'))fail('SEO_ARTICLE_CONTENT_INVALID');productUrl=u.toString();}
    catch {fail('SEO_ARTICLE_CONTENT_INVALID');}
  }
  const paragraphs=body.split(/\n\s*\n/).map(x=>x.trim()).filter(Boolean);
  const safeBody=paragraphs.map(p=>`<p>${escapeHtml(p).replace(/\n/g,'<br>')}</p>`).join('')+
    (productUrl?`<p><a href="${escapeHtml(productUrl)}">Produktdetails bei Homestro ansehen</a></p>`:'');
  return {blogId,title,handle,body:safeBody,summary,author:{name:plain(author||'Homestro Redaktion')},tags,isPublished:publish===true};
}
export async function createSeoArticleDraft({pool,graphql,blogId,author,input,publish=false}) {
  const article=articleDraftInput({blogId,author,input,publish}),fingerprint=hash(article);
  const ownershipTag=`homestro-pilot-${fingerprint.slice(0,16)}`;
  article.tags=[...new Set([...article.tags.slice(0,4),ownershipTag])].slice(0,5);
  const c=await pool.connect();let reserved=false;
  try {
    const remoteResult=await graphql(ARTICLE_LOOKUP,{query:`handle:${article.handle}`});
    const remoteMatches=remoteResult?.articles?.nodes;
    if(!Array.isArray(remoteMatches)||remoteResult.articles.pageInfo?.hasNextPage)fail('SEO_ARTICLE_LOOKUP_UNCONFIRMED');
    const remote=remoteMatches.find(x=>x.handle===article.handle&&x.blog?.id===blogId);
    await c.query('BEGIN');
    if(remote) {
      if(remote.tags?.includes(ownershipTag)&&remote.isPublished===article.isPublished) {
        const status=publish?'published':'draft_created';
        await c.query(`INSERT INTO marketing_seo_articles(handle,content_hash,status,shopify_id)
          VALUES($1,$2,$3,$4) ON CONFLICT(handle) DO UPDATE SET content_hash=$2,status=$3,shopify_id=$4,updated_at=now()`,
          [article.handle,fingerprint,status,remote.id]);
        await c.query('COMMIT');
        return {created:false,status,id:remote.id,handle:article.handle,isPublished:remote.isPublished};
      }
      await c.query(`INSERT INTO marketing_seo_articles(handle,content_hash,status)
        VALUES($1,$2,'external_exists') ON CONFLICT(handle) DO NOTHING`,[article.handle,fingerprint]);
      await c.query('COMMIT');
      return {created:false,status:'external_exists',handle:article.handle,isPublished:remote.isPublished};
    }
    const inserted=await c.query(`INSERT INTO marketing_seo_articles(handle,content_hash,status)
      VALUES($1,$2,'creating') ON CONFLICT(handle) DO NOTHING RETURNING handle`,[article.handle,fingerprint]);
    if(!inserted.rowCount) {
      const existing=(await c.query('SELECT content_hash,shopify_id,status FROM marketing_seo_articles WHERE handle=$1 FOR UPDATE',[article.handle])).rows[0];
      if(existing.content_hash!==fingerprint)fail('SEO_ARTICLE_HANDLE_CONFLICT');
      if(existing.shopify_id){ await c.query('COMMIT'); return {created:false,status:existing.status,id:existing.shopify_id,handle:article.handle,isPublished:existing.status==='published'}; }
      if(existing.status==='failed') {
        await c.query('UPDATE marketing_seo_articles SET status=\'creating\',updated_at=now() WHERE handle=$1',[article.handle]);
        reserved=true;await c.query('COMMIT');
      } else fail('SEO_ARTICLE_RECOVERY_REQUIRED');
    }
    reserved=true;await c.query('COMMIT');
  } catch(e) { await c.query('ROLLBACK').catch(()=>{});throw e; }
  finally { c.release(); }
  if(!reserved)fail('SEO_ARTICLE_RECOVERY_REQUIRED');
  try {
    const result=await graphql(ARTICLE_CREATE,{article});
    const payload=result?.articleCreate;
    if(payload?.userErrors?.length) {
      await pool.query('UPDATE marketing_seo_articles SET status=\'failed\',updated_at=now() WHERE handle=$1',[article.handle]);
      fail('SHOPIFY_ARTICLE_DRAFT_REJECTED');
    }
    const created=payload?.article;
      if(!created?.id||created.isPublished!==article.isPublished) {
      await pool.query('UPDATE marketing_seo_articles SET status=\'recovery_required\',updated_at=now() WHERE handle=$1',[article.handle]);
      fail('SHOPIFY_ARTICLE_DRAFT_UNCONFIRMED');
    }
    const status=publish?'published':'draft_created';
    await pool.query('UPDATE marketing_seo_articles SET status=$3,shopify_id=$2,updated_at=now() WHERE handle=$1',[article.handle,created.id,status]);
    return {created:true,status,id:created.id,handle:article.handle,isPublished:publish};
  } catch(e) {
    if(e?.code!=='SHOPIFY_ARTICLE_DRAFT_REJECTED'&&e?.code!=='SHOPIFY_ARTICLE_DRAFT_UNCONFIRMED')
      await pool.query('UPDATE marketing_seo_articles SET status=\'recovery_required\',updated_at=now() WHERE handle=$1',[article.handle]).catch(()=>{});
    throw e;
  }
}

export function productSeoArticle(product) {
  const c=product?.localized||{},title=plain(c.searchTitle||c.title||c.seoTitle),description=plain(c.description);
  const benefits=[...new Set((c.benefits||[]).map(x=>plain(x?.text)).filter(Boolean))].slice(0,6);
  if(product?.status!=='ACTIVE'||product?.contentReviewed!==true||product?.rejected||!title||!description||benefits.length<3||
    !product?.variants?.some(v=>v.available&&Number(v.price)>0))return null;
  let url;try{url=productURL(product.url);if(url.origin!=='https://homestro.de'||!url.pathname.startsWith('/products/'))return null;}catch{return null;}
  const productHandle=String(url.pathname.split('/').filter(Boolean).at(-1)||'');
  const idSuffix=String(product.id||'').match(/\d+$/)?.[0]?.slice(-6)||hash(product.id).slice(-6);
  const handle=`homestro-${productHandle}-ratgeber-${idSuffix}`.slice(0,100).replace(/-+$/,'');
  const articleTitle=`Kaufberatung: ${title}`.slice(0,100).trim();
  const summary=`${description} ${benefits[0]}`.slice(0,320).trim();
  const body=[
    `Produkt im Überblick\n\n${description}`,
    `Beschriebene Merkmale\n\n${benefits.map(x=>`• ${x}`).join('\n')}`,
    `So vergleichst du die Ausführung\n\nPrüfe vor dem Kauf die Maße, Varianten und den Lieferumfang direkt auf der Produktseite. Gleiche die dort genannten Eigenschaften mit deinem geplanten Einsatz ab. Eine allgemeine Produktbezeichnung ersetzt keine Prüfung der konkreten Variante.`,
    `Fragen vor der Bestellung\n\nWelche Angaben sind entscheidend? Nutze die Produktbeschreibung und die ausgewählte Variante als Grundlage. Wenn eine wichtige Angabe fehlt, kläre sie vor dem Kauf.\n\nWie findest du die passende Ausführung? Vergleiche die ausdrücklich angegebenen Merkmale mit deinen Anforderungen und prüfe den Lieferumfang der gewählten Variante.`,
    `Zusammenfassung\n\nDie Auswahl sollte sich an den beschriebenen Eigenschaften und deiner geplanten Anwendung orientieren. Aktuelle Varianten, Preis und Verfügbarkeit können sich ändern und sind auf der Produktseite maßgeblich.`
  ].join('\n\n');
  return {title:articleTitle,handle,summary,body,productUrl:url.toString(),tags:['Kaufberatung','Homestro'],productId:product.id};
}

export async function publishNextSeoArticle({pool,graphql,products,blogId,author,maxDaily=1}) {
  if(!blogId)return {status:'blog_not_configured',published:0};
  const limit=Math.max(1,Math.min(3,Math.floor(Number(maxDaily)||1)));
  const today=Number((await pool.query(`SELECT count(*)::int AS count FROM marketing_seo_articles
    WHERE status='published' AND created_at>now()-interval '24 hours'`)).rows[0]?.count||0);
  if(today>=limit)return {status:'daily_limit',published:0,limit};
  const existing=(await pool.query('SELECT handle,status FROM marketing_seo_articles')).rows;
  const known=new Map(existing.map(x=>[x.handle,x.status]));let skipped=0,recoveryPending=0;
  for(const product of products) {
    const draft=productSeoArticle(product);if(!draft)continue;
    const prior=known.get(draft.handle);
    if(prior&&!['creating','recovery_required'].includes(prior))continue;
    // Reconcile uncertain writes, but never replay them or starve unrelated products.
    if(['creating','recovery_required'].includes(prior)&&recoveryPending>=5)continue;
    let result;
    try{result=await createSeoArticleDraft({pool,graphql,blogId,author,publish:true,input:draft});}
    catch(e){
      if(e?.code!=='SEO_ARTICLE_RECOVERY_REQUIRED')throw e;
      recoveryPending++;continue;
    }
    if(result.status==='external_exists'){skipped++;known.set(draft.handle,'external_exists');continue;}
    if(result.status==='published')return {status:result.created?'published':'reconciled_published',published:1,handle:result.handle,productId:draft.productId,skipped,recoveryPending};
    return {status:result.status,published:0,handle:result.handle,productId:draft.productId,skipped,recoveryPending};
  }
  return {status:recoveryPending?'recovery_pending':skipped?'external_duplicates_skipped':'no_eligible_product',published:0,skipped,recoveryPending};
}
