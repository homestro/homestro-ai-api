const fs=require('fs');
const p='server.js';
let s=fs.readFileSync(p,'utf8');
const before='function rules(){return{maxCost:Number(process.env.MAX_PRODUCT_COST||10),minSellingPrice:Number(process.env.MIN_SELLING_PRICE||34.9),minRatio:Number(process.env.MIN_PRICE_COST_RATIO||3)}}';
const after='function rules(){return{maxCost:Number(process.env.MAX_PRODUCT_COST||12),minSellingPrice:Number(process.env.MIN_SELLING_PRICE||0),minRatio:Number(process.env.MIN_PRICE_COST_RATIO||3)}}';
if(s.includes(after)){console.log('rules already patched');process.exit(0);}
if(!s.includes(before)) throw new Error('rules marker not found');
s=s.replace(before,after);
fs.writeFileSync(p,s);
console.log('rules patched: max cost 12, no fixed selling-price floor, ratio 3x');
