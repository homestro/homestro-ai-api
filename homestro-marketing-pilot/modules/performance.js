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
    sales:`FROM sales SHOW orders, total_sales SINCE -${days}d UNTIL today`
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
export async function refreshPerformance({pool,graphql,days=30,enabled=false,now=new Date()}) {
  days=reportWindow(days);
  if(!enabled)return {connected:false,status:'disabled'};
  const old=(await pool.query('SELECT payload,updated_at FROM marketing_performance WHERE window_days=$1',[days])).rows[0];
  if(old&&now.getTime()-new Date(old.updated_at).getTime()<60*60*1000)return old.payload;
  const report={connected:false,status:'unavailable',windowDays:days,checkedAt:now.toISOString(),
    sessions:null,visitors:null,cartSessions:null,checkoutSessions:null,completedCheckoutSessions:null,
    conversionRate:null,orders:null,revenueEUR:null,currency:'EUR',
    salesScope:'shop totals; not orders attributed to Pilot',trafficScope:'Shopify human sessions only',
    sources:{sessions:{connected:false},sales:{connected:false}},missingScopes:[]};
  try {
    const scopes=await accessScopes(graphql);
    if(!scopes.has('read_reports')){report.status='permission_required';report.missingScopes=['read_reports'];}
    else {
      const queries=performanceQueries(days);
      const results=await Promise.allSettled(Object.values(queries).map(query=>graphql(PERFORMANCE_QUERY,{query})));
      for(let i=0;i<results.length;i++) {
        const source=i===0?'sessions':'sales';
        try {
          if(results[i].status!=='fulfilled')fail('SHOPIFY_REPORT_UNAVAILABLE');
          const m=parsePerformanceTable(results[i].value,i===0?['sessions','online_store_visitors',
            'sessions_with_cart_additions','sessions_that_reached_checkout','sessions_that_completed_checkout','conversion_rate']:['orders','total_sales']);
          if(i===0)Object.assign(report,{sessions:m.sessions,visitors:m.online_store_visitors,
            cartSessions:m.sessions_with_cart_additions,checkoutSessions:m.sessions_that_reached_checkout,
            completedCheckoutSessions:m.sessions_that_completed_checkout,conversionRate:m.conversion_rate});
          else Object.assign(report,{orders:m.orders,revenueEUR:m.total_sales});
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
  if(!row)return {connected:false,status:'not_collected',windowDays:days,orders:null,revenueEUR:null,sessions:null};
  return {...row.payload,stale:now.getTime()-new Date(row.updated_at).getTime()>2*60*60*1000};
}
