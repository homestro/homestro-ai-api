import test from 'node:test';
import assert from 'node:assert/strict';
import {refreshPerformance,parsePerformanceTable,performanceQueries,readPerformance} from '../modules/performance.js';

const table=values=>({shopifyqlQuery:{parseErrors:[],tableData:{columns:Object.keys(values).map(name=>({name})),rows:[values]}}});
const traffic={sessions:7,online_store_visitors:3,sessions_with_cart_additions:0,sessions_that_reached_checkout:0,sessions_that_completed_checkout:0,conversion_rate:0};
function fixture({scopes=['read_reports'],failSales=false,cached=null}={}) {
  const writes=[],queries=[];
  const pool={query:async(sql,args)=>{
    if(sql.startsWith('SELECT'))return {rows:cached?[cached]:[]};
    writes.push(args);return {rows:[]};
  }};
  const graphql=async(q,args)=>{
    queries.push({q,args});
    if(q.includes('PilotAccessScopes'))return {currentAppInstallation:{accessScopes:scopes.map(handle=>({handle}))}};
    if(args.query.includes('FROM sessions'))return table(traffic);
    if(failSales)throw new Error('provider failure');
    return table({orders:0,total_sales:0});
  };
  return {pool,graphql,writes,queries};
}
test('reports confirmed human traffic and shop totals without calling them Pilot sales',async()=>{
  const f=fixture(),r=await refreshPerformance({...f,enabled:true});
  assert.equal(r.connected,true);assert.equal(r.visitors,3);assert.equal(r.orders,0);
  assert.equal(r.cartSessions,0);assert.match(r.salesScope,/not orders attributed to Pilot/);
  assert.ok(f.queries.some(q=>q.args?.query?.includes("human_or_bot_session = 'human'")));
  assert.equal(f.writes.length,1);
});
test('missing report access is explicit and no zero visits/orders are invented',async()=>{
  const f=fixture({scopes:['read_products','write_content']});
  const r=await refreshPerformance({...f,enabled:true});
  assert.equal(r.status,'permission_required');assert.deepEqual(r.missingScopes,['read_reports']);
  assert.equal(r.sessions,null);assert.equal(r.orders,null);assert.equal(f.queries.length,1);
});
test('one unavailable source cannot erase the other confirmed measurement',async()=>{
  const f=fixture({failSales:true}),r=await refreshPerformance({...f,enabled:true});
  assert.equal(r.status,'partial');assert.equal(r.sessions,7);assert.equal(r.orders,null);
  assert.equal(r.sources.sessions.connected,true);assert.equal(r.sources.sales.connected,false);
});
test('fresh persisted measurements avoid repeated API requests',async()=>{
  const payload={connected:true,status:'connected',sessions:7};
  const f=fixture({cached:{payload,updated_at:'2026-10-13T20:00:00Z'}});
  assert.deepEqual(await refreshPerformance({...f,enabled:true,now:new Date('2026-10-13T20:30:00Z')}),payload);
  assert.equal(f.queries.length,0);assert.equal(f.writes.length,0);
});
test('malformed results or parse errors are not treated as zero sales',()=>{
  for(const value of [null,{shopifyqlQuery:{parseErrors:['invalid']}},table({orders:'secret'}),table({other:0})])
    assert.throws(()=>parsePerformanceTable(value,['orders']));
  assert.equal(parsePerformanceTable(table({orders:0}),['orders']).orders,0);
});
test('parses the live Admin API object rows and legacy array rows',()=>{
 const actual={shopifyqlQuery:{tableData:{columns:[{name:'orders',dataType:'INTEGER'},{name:'total_sales',dataType:'MONEY'}],rows:[{orders:'0',total_sales:'0'}]},parseErrors:[]}};
 assert.deepEqual(parsePerformanceTable(actual,['orders','total_sales']),{orders:0,total_sales:0});
 actual.shopifyqlQuery.tableData.rows=[['0','0']];
 assert.deepEqual(parsePerformanceTable(actual,['orders','total_sales']),{orders:0,total_sales:0});
});
test('refund periods can report negative revenue but never negative visitor or order counts',()=>{
  assert.equal(parsePerformanceTable(table({orders:0,total_sales:-25.5}),['orders','total_sales']).total_sales,-25.5);
  assert.throws(()=>parsePerformanceTable(table({orders:-1}),['orders']));
  assert.throws(()=>parsePerformanceTable(table({sessions:1.5}),['sessions']));
});
test('report windows are bounded and stale snapshots are labelled',async()=>{
  assert.throws(()=>performanceQueries('30; DROP TABLE'));
  const pool={query:async()=>({rows:[{payload:{sessions:7},updated_at:'2026-10-13T10:00:00Z'}]})};
  assert.equal((await readPerformance(pool,30,new Date('2026-10-13T13:00:00Z'))).stale,true);
});
