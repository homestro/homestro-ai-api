import express from 'express';
import pg from 'pg';
import {attachMarketing} from './modules/index.js';
import {createShopifyClient} from './modules/shopify.js';
import {config,log} from './modules/core.js';

const app=express();
app.get('/health',(_req,res)=>res.json({ok:true}));
const pool=new pg.Pool({connectionString:process.env.DATABASE_URL,max:5,
  connectionTimeoutMillis:10000,query_timeout:15000});
pool.on('error',()=>log('DATABASE_CONNECTION_ERROR'));
let pilot;
try {
  const graphql=createShopifyClient({domain:process.env.SHOPIFY_STORE_DOMAIN,token:process.env.SHOPIFY_ADMIN_ACCESS_TOKEN});
  pilot=await attachMarketing(app,{pool,graphql,cfg:config()});
}catch{log('MARKETING_SETUP_FAILED');}
const server=app.listen(Number(process.env.PORT||8080));
process.on('SIGTERM',()=>{
  pilot?.stop();server.close(()=>void pool.end());
  setTimeout(()=>process.exit(0),30000).unref();
});
