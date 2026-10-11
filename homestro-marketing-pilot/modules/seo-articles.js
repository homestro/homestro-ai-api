import {hash,fail} from './core.js';

export const ARTICLE_CREATE = `mutation PilotArticleDraft($article: ArticleCreateInput!) {
  articleCreate(article: $article) {
    article { id title handle isPublished onlineStoreUrl }
    userErrors { field message }
  }
}`;

const plain=value=>String(value??'').replace(/<[^>]*>/g,' ').replace(/\s+/g,' ').trim();
const escapeHtml=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function articleDraftInput({blogId,author,input}) {
  const title=plain(input?.title),summary=plain(input?.summary),body=String(input?.body||'').trim();
  const handle=String(input?.handle||'').trim().toLowerCase();
  const tags=Array.isArray(input?.tags)?input.tags.map(plain).filter(Boolean):[];
  if(!/^gid:\/\/shopify\/Blog\/\d+$/.test(blogId||''))fail('SEO_BLOG_NOT_CONFIGURED');
  if(!title||title.length<10||title.length>100||!summary||summary.length<40||summary.length>320)fail('SEO_ARTICLE_CONTENT_INVALID');
  if(!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(handle)||handle.length>100)fail('SEO_ARTICLE_HANDLE_INVALID');
  if(body.length<800||body.length>15000||/<\/?(?:script|style|iframe|object|form)\b/i.test(body))fail('SEO_ARTICLE_CONTENT_INVALID');
  if(tags.length>5||tags.some(x=>x.length>40))fail('SEO_ARTICLE_TAGS_INVALID');
  const paragraphs=body.split(/\n\s*\n/).map(x=>x.trim()).filter(Boolean);
  const safeBody=paragraphs.map(p=>`<p>${escapeHtml(p).replace(/\n/g,'<br>')}</p>`).join('');
  return {blogId,title,handle,body:safeBody,summary,author:{name:plain(author||'Homestro Redaktion')},tags,isPublished:false};
}
export async function createSeoArticleDraft({pool,graphql,blogId,author,input}) {
  const article=articleDraftInput({blogId,author,input}),fingerprint=hash(article);
  const c=await pool.connect();let reserved=false;
  try {
    await c.query('BEGIN');
    const inserted=await c.query(`INSERT INTO marketing_seo_articles(handle,content_hash,status)
      VALUES($1,$2,'creating') ON CONFLICT(handle) DO NOTHING RETURNING handle`,[article.handle,fingerprint]);
    if(!inserted.rowCount) {
      const existing=(await c.query('SELECT content_hash,shopify_id,status FROM marketing_seo_articles WHERE handle=$1 FOR UPDATE',[article.handle])).rows[0];
      if(existing.content_hash!==fingerprint)fail('SEO_ARTICLE_HANDLE_CONFLICT');
      if(existing.shopify_id)return {created:false,status:existing.status,id:existing.shopify_id,handle:article.handle};
      fail('SEO_ARTICLE_RECOVERY_REQUIRED');
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
    if(!created?.id||created.isPublished!==false) {
      await pool.query('UPDATE marketing_seo_articles SET status=\'recovery_required\',updated_at=now() WHERE handle=$1',[article.handle]);
      fail('SHOPIFY_ARTICLE_DRAFT_UNCONFIRMED');
    }
    await pool.query('UPDATE marketing_seo_articles SET status=\'draft_created\',shopify_id=$2,updated_at=now() WHERE handle=$1',[article.handle,created.id]);
    return {created:true,status:'draft_created',id:created.id,handle:article.handle,isPublished:false};
  } catch(e) {
    if(e?.code!=='SHOPIFY_ARTICLE_DRAFT_REJECTED'&&e?.code!=='SHOPIFY_ARTICLE_DRAFT_UNCONFIRMED')
      await pool.query('UPDATE marketing_seo_articles SET status=\'recovery_required\',updated_at=now() WHERE handle=$1',[article.handle]).catch(()=>{});
    throw e;
  }
}
