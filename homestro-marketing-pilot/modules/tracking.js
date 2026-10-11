import {createHmac,timingSafeEqual} from 'node:crypto';
import {fail,productURL} from './core.js';

const CHANNELS=new Set(['facebook','instagram','tiktok','pinterest']);
const FORMATS=new Set(['image','carousel','reels']);
const signature=(payload,secret)=>createHmac('sha256',secret).update(payload).digest('base64url');

export function createTrackedLink({productId,channel,format,publicOrigin,secret}) {
  if(!/^gid:\/\/shopify\/Product\/\d+$/.test(String(productId||'')))fail('INVALID_PRODUCT_ID');
  if(!CHANNELS.has(channel)||!FORMATS.has(format))fail('INVALID_TRACKING_SOURCE');
  if(typeof secret!=='string'||secret.length<32)fail('TRACKING_SECRET_REQUIRED');
  const origin=new URL(publicOrigin);
  if(origin.protocol!=='https:'||origin.username||origin.password)fail('HTTPS_REQUIRED');
  const payload=Buffer.from(JSON.stringify({productId,channel,format})).toString('base64url');
  return origin.origin+'/marketing-click/'+payload+'/'+signature(payload,secret);
}

export function parseTrackedLink(payload,providedSignature,secret) {
  if(typeof payload!=='string'||payload.length>512||typeof providedSignature!=='string')fail('INVALID_TRACKING_LINK');
  if(typeof secret!=='string'||secret.length<32)fail('TRACKING_SECRET_REQUIRED');
  const expected=Buffer.from(signature(payload,secret));
  const supplied=Buffer.from(providedSignature);
  if(expected.length!==supplied.length||!timingSafeEqual(expected,supplied))fail('INVALID_TRACKING_LINK');
  let value;
  try{value=JSON.parse(Buffer.from(payload,'base64url').toString('utf8'));}catch{fail('INVALID_TRACKING_LINK');}
  if(!/^gid:\/\/shopify\/Product\/\d+$/.test(value?.productId||'')||
    !CHANNELS.has(value?.channel)||!FORMATS.has(value?.format))fail('INVALID_TRACKING_LINK');
  return value;
}

export function trackedDestination(product,channel,format) {
  let url;
  try{url=productURL(product?.url);}catch{fail('INVALID_PRODUCT_URL');}
  for(const [key,value] of Object.entries({utm_source:channel,utm_medium:'organic',
    utm_campaign:'homestro_pilot',utm_content:format}))url.searchParams.set(key,value);
  return url.toString();
}
