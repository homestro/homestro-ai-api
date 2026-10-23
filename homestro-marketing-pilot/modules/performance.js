import {fail,log} from './core.js';
import {reportWindow} from './growth-report.js';

export const ACCESS_SCOPES='query PilotAccessScopes { currentAppInstallation { accessScopes { handle } } }';
export const PERFORMANCE_QUERY='query PilotPerformance($query: String!) { shopifyqlQuery(query: $query) { tableData { columns { name dataType } rows } parseErrors } }';
export async function accessScopes(graphql) {
  const result=await graphql(ACCESS_SCOPES,{});
  if(!Array.isArray(result?.currentAppInstallation?.accessScopes))fail('SHOPIFY_SCOPES_UNCONFIRMED');
  return new Set(result.currentAppInstallation.accessScopes.map(s=>s.handle));
}
export function performanceQueries(days=30) {
  days=reportWindow(days);
  return {
    sessions:`FROM sessions SHOW sessions, online_store_visitors, sessions_with_cart_additions, sessions_that_reached_checkout, sessions_that_completed_checkout, conversion_rate WHERE human_or_bot_session = 'human' SINCE -${days}d UNTIL today`,
    sales:`FROM sales SHOW orders, total_sales SINCE -${days}d UNTIL today`,
    pilotSales:`FROM campaign_sales SHOW campaign_last_non_direct_click_order_count, campaign_last_non_direct_click_total_sales WHERE utm_campaign = 'homestro_pilot' GROUP BY utm_source, utm_medium SINCE -${days}d UNTIL today`
  };
}
export function parsePerformanceTable(result,required) {
  const response=result?.shopifyqlQuery;
  if(!response||response.parseErrors?.length||!response.tableData)fail('SHOPIFY_REPORT_UNAVAILABLE');
  const {columns,rows}=response.tableData;
  if(!Array.isArray(columns)||!Array.isArray(rows)||rows.length!==1)fail('SHOPIFY_REPORT_INVALID');
  const metrics={};
  for(const name of required) {
    const index=columns.findIndex(c=>c.name===name),row=rows[0];
    const value=Array.isArray(row)?row[index]:row&&typeof row==='object'?row[name]:undefined;
    if(index<0||value===null||value===undefined||value==='')fail('SHOPIFY_REPORT_INVALID');
    const n=Number(value);
    if(!Number.isFinite(n)||(name!=='total_sales'&&n<0)||
      (!['total_sales','conversion_rate'].includes(name)&&!Number.isInteger(n)))fail('SHOPIFY_REPORT_INVALID');
    metrics[name]=n;
  }
  return metrics;
}
export function parsePilotSalesTable(result) {
  const response=result?.shopifyqlQuery;
  if(!response||response.parseErrors?.length||!response.tableData)fail('SHOPIFY_REPORT_UNAVAILABLE');
  const {columns,rows}=response.tableData;
  const orderMetric='campaign_last_non_direct_click_order_count';
  const salesMetric='campaign_last_non_direct_click_total_sales';
  if(!Array.isArray(columns)||!Array.isArray(rows))fail('SHOPIFY_REPORT_INVALID');
  const index=name=>columns.findIndex(c=>c.name===name);
  const orderIndex=index(orderMetric),salesIndex=index(salesMetric),sourceIndex=index('utm_source'),mediumIndex=index('utm_medium');
  if([orderIndex,salesIndex,sourceIndex,mediumIndex].some(i=>i<0))fail('SHOPIFY_REPORT_INVALID');
  const bySource=new Map();
  let orders=0,revenue=0;
  for(const row of rows) {
    const valueAt=i=>Array.isArray(row)?row[i]:row&&typeof row==='object'?row[columns[i].name]:undefined;
    const orderValue=valueAt(orderIndex),salesValue=valueAt(salesIndex);
    if(orderValue===null||orderValue===undefined||orderValue===''||salesValue===null||salesValue===undefined||salesValue==='')fail('SHOPIFY_REPORT_INVALID');
    const orderCount=Number(orderValue),sales=Number(salesValue);
    if(!Number.isInteger(orderCount)||orderCount<0||!Number.isFinite(sales))fail('SHOPIFY_REPORT_INVALID');
    const source=String(valueAt(sourceIndex)||'unknown'),medium=String(valueAt(mediumIndex)||'unknown');
    const key=JSON.stringify([source,medium]);
    const item=bySource.get(key)||{source,medium,orders:0,revenue:0};
    item.orders+=orderCount;item.revenue+=sales;bySource.set(key,item);
    orders+=orderCount;revenue+=sales;
  }
  return {orders,revenue,bySource:[...bySource.values()]};
}
export async function refreshPerformance({pool,graphql,days=30,enabled=false,now=new Date()}) {
  days=reportWindow(days);
  if(!enabled)return {connected:false,status:'disabled'};
  const old=(await pool.query('SELECT payload,updated_at FROM marketing_performance WHERE window_days=$1',[days])).rows[0];
  if(old&&now.getTime()-new Date(old.updated_at).getTime()<60*60*1000)return old.payload;
  const report={connected:false,status:'unavailable',windowDays:days,checkedAt:now.toISOString(),
    sessions:null,visitors:null,cartSessions:null,checkoutSessions:null,completedCheckoutSessions:null,
    conversionRate:null,orders:null,revenueEUR:null,pilotAttributedOrders:null,pilotAttributedRevenueEUR:null,
    pilotAttributedBySource:[],currency:'EUR',
    salesScope:'shop totals; not orders attributed to Pilot',pilotSalesScope:'Shopify last non-direct click attribution for utm_campaign=homestro_pilot',
    trafficScope:'Shopify human sessions only',
    sources:{sessions:{connected:false},sales:{connected:false},pilotSales:{connected:false}},missingScopes:[]};
  try {
    const scopes=await accessScopes(graphql);
    if(!scopes.has('read_reports')){report.status='permission_required';report.missingScopes=['read_reports'];}
    else {
      const queries=performanceQueries(days);
      const names=['sessions','sales','pilotSales'];
      const results=await Promise.allSettled(names.map(name=>graphql(PERFORMANCE_QUERY,{query:queries[name]})));
      for(let i=0;i<results.length;i++) {
        const source=names[i];
        try {
          if(results[i].status!=='fulfilled')fail('SHOPIFY_REPORT_UNAVAILABLE');
          if(source==='sessions') {
            const m=parsePerformanceTable(results[i].value,['sessions','online_store_visitors',
              'sessions_with_cart_additions','sessions_that_reached_checkout','sessions_that_completed_checkout','conversion_rate']);
            Object.assign(report,{sessions:m.sessions,visitors:m.online_store_visitors,
              cartSessions:m.sessions_with_cart_additions,checkoutSessions:m.sessions_that_reached_checkout,
              completedCheckoutSessions:m.sessions_that_completed_checkout,conversionRate:m.conversion_rate});
          } else if(source==='sales') {
            const m=parsePerformanceTable(results[i].value,['orders','total_sales']);
            Object.assign(report,{orders:m.orders,revenueEUR:m.total_sales});
          } else {
            const m=parsePilotSalesTable(results[i].value);
            Object.assign(report,{pilotAttributedOrders:m.orders,pilotAttributedRevenueEUR:m.revenue,
              pilotAttributedBySource:m.bySource});
          }
          report.sources[source]={connected:true};
        }catch{report.sources[source]={connected:false,reason:'SHOPIFY_REPORT_UNAVAILABLE'};}
      }
      report.connected=Object.values(report.sources).every(s=>s.connected);
      report.status=report.connected?'connected':Object.values(report.sources).some(s=>s.connected)?'partial':'unavailable';
    }
  }catch{report.status='SHOPIFY_ACCESS_UNCONFIRMED';}
  // Store only aggregated measurements, never customers, orders, or provider errors.
  await pool.query(`INSERT INTO marketing_performance(window_days,payload,updated_at) VALUES($1,$2,now())
    ON CONFLICT(window_days) DO UPDATE SET payload=$2,updated_at=now()`,[days,report]);
  log('SHOPIFY_PERFORMANCE_STATUS',{status:report.status,windowDays:days,missingScopes:report.missingScopes});
  return report;
}
export async function readPerformance(pool,days=30,now=new Date()) {
  days=reportWindow(days);
  const row=(await pool.query('SELECT payload,updated_at FROM marketing_performance WHERE window_days=$1',[days])).rows[0];
  if(!row)return {connected:false,status:'not_collected',windowDays:days,orders:null,revenueEUR:null,sessions:null,pilotAttributedOrders:null,pilotAttributedRevenueEUR:null};
  return {...row.payload,stale:now.getTime()-new Date(row.updated_at).getTime()>2*60*60*1000};
}
