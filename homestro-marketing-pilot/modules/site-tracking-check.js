import {fail} from './core.js';

// Ephemeral own-store browser. Observe configured requests, suppress all Meta beacons:
// no artificial Purchase/PageView is delivered to an ad platform.
export async function checkStorefrontTracking({url,expectedPixelId,launch}){
  const target=new URL(url);
  if(target.protocol!=='https:'||target.hostname!=='homestro.de'||target.username||target.password||target.port||!target.pathname.startsWith('/products/')||!/^\d{4,30}$/.test(expectedPixelId))fail('TRACKING_CHECK_SOURCE_INVALID');
  if(!launch){const {chromium}=await import('playwright');launch=options=>chromium.launch(options);}
  const browser=await launch({headless:true,executablePath:'/usr/bin/chromium',args:['--no-sandbox','--disable-dev-shm-usage']});
  const observed=new Set();let context;
  try{
    context=await browser.newContext({userAgent:'HomestroReadinessProbe/1.0',locale:'de-DE',serviceWorkers:'block'});
    const page=await context.newPage();
    await page.route('**/*',async route=>{
      const request=route.request();let u;try{u=new URL(request.url());}catch{return route.abort();}
      const meta=['www.facebook.com','facebook.com','www.facebook.net'].includes(u.hostname);
      if(meta&&u.pathname.startsWith('/tr')){
        const id=u.searchParams.get('id'),event=u.searchParams.get('ev');
        if(/^\d{4,30}$/.test(id||'')&&event==='PageView')observed.add(id);
        return route.abort();
      }
      const allowed=u.hostname==='homestro.de'||u.hostname==='www.homestro.de'||u.hostname==='connect.facebook.net'||u.hostname==='cdn.shopify.com'||u.hostname.endsWith('.shopify.com')||u.hostname.endsWith('.shopifycdn.com');
      if(u.protocol!=='https:'||!allowed||['image','media','font'].includes(request.resourceType()))return route.abort();
      return route.continue();
    });
    const response=await page.goto(target.href,{waitUntil:'domcontentloaded',timeout:20000});
    if(response?.status()!==200)fail('TRACKING_LANDING_HTTP_NOT_200');
    // This grants consent only in the disposable owner test browser, not to customers.
    try{await page.getByRole('button',{name:/^(Alle akzeptieren|Alle zulassen|Accept all)$/i}).first().click({timeout:2000});}catch{}
    // Timer bound includes deferred Shopify app pixels; no indefinite browser wait.
    const deadline=Date.now()+10000;
    while(Date.now()<deadline&&!observed.has(expectedPixelId))await new Promise(resolve=>setTimeout(resolve,250));
    return {status:'checked',checkedAt:new Date().toISOString(),configured:observed.has(expectedPixelId),
      expectedPixelId,observedPixelIds:[...observed],pixelBeaconsSuppressed:true,
      evidence:'runtime_pageview_request_configuration_not_conversion_delivery',
      purchaseEventDelivered:false,orderCreated:false,storeConfigurationChanged:false};
  }finally{await context?.close().catch(()=>{});await browser.close();}
}
