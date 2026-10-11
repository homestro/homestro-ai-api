import test from 'node:test';
import assert from 'node:assert/strict';
import {buildGrowthReport,reportWindow} from '../modules/growth-report.js';

test('accepts only supported report windows and defaults to 30 days',()=>{
  assert.equal(reportWindow(undefined),30);
  assert.equal(reportWindow('7'),7);
  assert.throws(()=>reportWindow('15'),e=>e.code==='INVALID_REPORT_WINDOW');
  assert.throws(()=>reportWindow('90.5'),e=>e.code==='INVALID_REPORT_WINDOW');
});

test('aggregates pilot evidence and leaves unavailable attribution unknown',()=>{
  const report=buildGrowthReport({
    days:30,generatedAt:'2026-10-11T12:00:00.000Z',
    products:[
      {status:'ready',count:4,seo_copy_ready:3,seo_copy_missing:1},
      {status:'pending_marketing',count:2,seo_copy_ready:0,seo_copy_missing:0}
    ],
    posts:[
      {channel:'facebook',status:'published',count:2,confirmed_permalink_count:2},
      {channel:'instagram',status:'published',count:1,confirmed_permalink_count:0},
      {channel:'tiktok',status:'draft_queued',count:3,confirmed_permalink_count:0}
    ],
    pendingReasons:[{reason:'NO_PUBLIC_PRODUCT_URL',count:1}]
  });
  assert.equal(report.catalog.total,6);
  assert.equal(report.catalog.readyProducts,4);
  assert.equal(report.catalog.seoCopyReady,3);
  assert.equal(report.catalog.seoCopyMissing,1);
  assert.equal(report.organic.publishedRows,3);
  assert.equal(report.organic.confirmedPublications,2);
  assert.equal(report.organic.byChannel.tiktok.draftQueued,3);
  assert.equal(report.attribution.sessions,null);
  assert.equal(report.attribution.orders,null);
  assert.equal(report.adSpendEUR,0);
  assert.ok(report.recommendations.some(x=>x.includes('missing prepared SEO')));
});

test('empty datasets report no fabricated impressions, clicks, or sales',()=>{
  const report=buildGrowthReport({products:[],posts:[],pendingReasons:[]});
  assert.equal(report.catalog.total,0);
  assert.equal(report.organic.publishedRows,0);
  assert.equal(report.attribution.clicks,null);
  assert.equal(report.attribution.revenueEUR,null);
  assert.ok(report.attribution.missing.includes('Search Console impressions and clicks'));
});
