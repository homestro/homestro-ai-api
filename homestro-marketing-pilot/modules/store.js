import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {fail} from './core.js';

export class Store {
  constructor(pool) { this.pool=pool; }
  async migrate() { await this.pool.query(await readFile(new URL('../schema.sql',import.meta.url),'utf8')); }
  async saveProduct(p,status,reasons) {
    await this.pool.query(`INSERT INTO marketing_products(id,document,status,reasons) VALUES($1,$2,$3,$4)
      ON CONFLICT(id) DO UPDATE SET document=$2,status=$3,reasons=$4,updated_at=now()`,[p.id,p,status,JSON.stringify(reasons)]);
  }
  async product(id) { return (await this.pool.query('SELECT * FROM marketing_products WHERE id=$1',[id])).rows[0]; }
  async pending() { return (await this.pool.query("SELECT * FROM marketing_products WHERE status='pending_marketing' ORDER BY updated_at LIMIT 10")).rows; }
  async queue(productId,channel,revision,payload) {
    const c=await this.pool.connect();
    try {
      await c.query('BEGIN');
      // Old approvals are not valid for a changed product or changed compiled payload.
      await c.query(`UPDATE marketing_posts SET status='superseded',updated_at=now()
        WHERE product_id=$1 AND channel=$2 AND revision<>$3 AND status IN ('draft_queued','approved')`,[productId,channel,revision]);
      const r=await c.query(`INSERT INTO marketing_posts(id,product_id,channel,revision,payload,status)
        VALUES($1,$2,$3,$4,$5,'draft_queued') ON CONFLICT DO NOTHING RETURNING id`,[randomUUID(),productId,channel,revision,payload]);
      await c.query('COMMIT'); return r.rows[0]?.id;
    } catch(e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
  }
  async list(status='draft_queued') {
    return (await this.pool.query('SELECT * FROM marketing_posts WHERE status=$1 ORDER BY created_at LIMIT 100',[status])).rows;
  }
  async approve(id,reviewer) {
    const r=await this.pool.query(`UPDATE marketing_posts AS s SET status='approved',approved_by=$2,approved_at=now(),updated_at=now()
      FROM marketing_products AS p WHERE s.id=$1 AND s.product_id=p.id AND s.status='draft_queued'
      AND p.status='ready' AND (s.payload->>'productRevision')=(p.document->>'revision') RETURNING s.id`,[id,reviewer]);
    if (!r.rowCount) fail('NOT_APPROVABLE'); return r.rows[0];
  }
  async checkpoint(id,remote) {
    await this.pool.query('UPDATE marketing_posts SET remote=$2,updated_at=now() WHERE id=$1',[id,remote]);
  }
  async setStatus(id,status,errorCode=null) {
    await this.pool.query('UPDATE marketing_posts SET status=$2,error_code=$3,updated_at=now() WHERE id=$1',[id,status,errorCode]);
    await this.pool.query('INSERT INTO marketing_events(post_id,code) VALUES($1,$2)',[id,errorCode||status]);
  }
  async feedRows() {
    return (await this.pool.query("SELECT document FROM marketing_products WHERE status='ready' ORDER BY id")).rows.map(x=>x.document);
  }
  async withWorkerLock(fn) {
    const c=await this.pool.connect(); let locked=false;
    try {
      locked=(await c.query('SELECT pg_try_advisory_lock(73341001) AS locked')).rows[0].locked;
      if (!locked) return;
      // A process died after a side effect. Never auto-repeat uncertain publication.
      await c.query(`UPDATE marketing_posts SET status='recovery_required',error_code='INTERRUPTED_PUBLISH',updated_at=now()
        WHERE status='publishing'`);
      return await fn(c);
    } finally { if(locked) await c.query('SELECT pg_advisory_unlock(73341001)').catch(()=>{}); c.release(); }
  }
}
