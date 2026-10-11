'use strict';
// Exact decimal arithmetic for exchange constraints; no dependencies or configuration reads.
function decimal(value, { positive = true, maxScale = 18 } = {}) {
  if (typeof value !== 'string' && typeof value !== 'number') throw new Error('Decimal must be a string or number');
  if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('Decimal must be finite');
  const text = String(value);
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(text)) throw new Error('Use a complete non-negative decimal without exponent');
  const [whole, fraction = ''] = text.split('.');
  if (fraction.length > maxScale) throw new Error('Decimal precision exceeds allowed scale');
  const units = BigInt(whole + fraction);
  if (positive && units === 0n) throw new Error('Amount must be positive');
  return { units, scale: fraction.length, text };
}
function align(a, b) { const s = Math.max(a.scale, b.scale); return [a.units * 10n ** BigInt(s-a.scale), b.units * 10n ** BigInt(s-b.scale), s]; }
function format(units, scale) { const neg=units<0n; let s=(neg?-units:units).toString().padStart(scale+1,'0'); if(scale) s=s.slice(0,-scale)+'.'+s.slice(-scale); return (neg?'-':'')+s; }
// Derived products can have more fractional digits than the exchange inputs.
const computed = value => decimal(value,{positive:false,maxScale:128});
function compare(a,b) { const [x,y]=align(computed(a),computed(b)); return x<y?-1:x>y?1:0; }
function add(a,b) { const [x,y,s]=align(computed(a),computed(b)); return format(x+y,s); }
function subtract(a,b) { const [x,y,s]=align(computed(a),computed(b)); return format(x-y,s); }
function multiply(a,b) { const x=computed(a),y=computed(b); return format(x.units*y.units,x.scale+y.scale); }
function divide(a,b,{scale=18,roundUp=false}={}) {
 if(!Number.isInteger(scale)||scale<0||scale>36)throw new Error('Invalid division scale');
 const x=computed(a),y=computed(b);if(y.units===0n)throw new Error('Division by zero');
 const numerator=x.units*10n**BigInt(y.scale+scale),denominator=y.units*10n**BigInt(x.scale);
 const quotient=numerator/denominator+(roundUp&&numerator%denominator!==0n?1n:0n);
 return format(quotient,scale);
}
function absDifference(a,b) { return compare(a,b)>=0?subtract(a,b):subtract(b,a); }
function onStep(value,step) { const [v,s]=align(decimal(value),decimal(step)); return v%s===0n; }
function floorStep(value,step) { const parsedStep=decimal(step),[v,s,scale]=align(decimal(value),parsedStep); return format(((v/s)*s)/10n**BigInt(scale-parsedStep.scale),parsedStep.scale); }
// Preserve integer IDs before JSON.parse rounds them, ignoring number-like text inside strings.
function parseLossless(text) {
 let out='',i=0;
 while(i<text.length) {
  if(text[i]==='"') { const start=i++; while(i<text.length) { if(text[i]==='\\') {i+=2;continue;} if(text[i++]==='"')break; } out+=text.slice(start,i); }
  else if(text[i]==='-' || /\d/.test(text[i])) {
   const match=text.slice(i).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/);
   if(!match) {out+=text[i++];continue;}
   const n=match[0]; out+=!/[.eE]/.test(n) && (BigInt(n)>BigInt(Number.MAX_SAFE_INTEGER)||BigInt(n)<BigInt(Number.MIN_SAFE_INTEGER))?JSON.stringify(n):n; i+=n.length;
  } else out+=text[i++];
 }
 return JSON.parse(out);
}
function idString(value) { if(typeof value==='number' && !Number.isSafeInteger(value))throw new Error('Unsafe numeric identifier'); const s=String(value??''); if(!/^[1-9]\d*$/.test(s))throw new Error('Invalid exchange identifier'); return s; }
module.exports={decimal,compare,add,subtract,multiply,divide,absDifference,onStep,floorStep,parseLossless,idString};
