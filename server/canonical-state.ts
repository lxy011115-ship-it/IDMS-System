import {createHash} from 'node:crypto';

// Byte-compatible with imports.canonical, including its historical undefined
// behavior. The buffer is bounded; large strings are escaped in UTF-16 chunks.
export function emitCanonical(value:unknown,write:(text:string)=>void):void{
 const parents=new Set<object>();let pieces:string[]=[],length=0;
 const flush=()=>{if(length){write(pieces.join(''));pieces=[];length=0;}};
 const emit=(text:string)=>{if(length+text.length>32768)flush();pieces.push(text);length+=text.length;if(length>=32768)flush();};
 function string(text:string){emit('"');for(let start=0;start<text.length;){let end=Math.min(start+8192,text.length);if(end<text.length&&text.charCodeAt(end-1)>=0xd800&&text.charCodeAt(end-1)<=0xdbff&&text.charCodeAt(end)>=0xdc00&&text.charCodeAt(end)<=0xdfff)end--;emit(JSON.stringify(text.slice(start,end)).slice(1,-1));start=end;}emit('"');}
 function walk(item:unknown,position:'root'|'array'|'object'){
  if(typeof item==='string'){string(item);return;}
  if(item&&typeof item==='object'){
   if(parents.has(item))throw new TypeError('Cyclic canonical state');parents.add(item);
   if(Array.isArray(item)){emit('[');for(let i=0;i<item.length;i++){if(i)emit(',');walk(item[i],'array');}emit(']');}
   else{emit('{');const keys=Object.keys(item).sort();for(let i=0;i<keys.length;i++){if(i)emit(',');string(keys[i]);emit(':');walk((item as Record<string,unknown>)[keys[i]],'object');}emit('}');}
   parents.delete(item);return;
  }
  const scalar=JSON.stringify(item);if(scalar===undefined){if(position==='root')throw new TypeError('Canonical root has no digestable text');emit(position==='array'?'':'undefined');}else emit(scalar);
 }
 walk(value,'root');flush();
}
export function canonicalDigest(value:unknown):string{const hash=createHash('sha256');emitCanonical(value,text=>hash.update(text));return hash.digest('hex');}
const legacy=(value:unknown):string=>Array.isArray(value)?'['+value.map(legacy).join(',')+']':value&&typeof value==='object'?'{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+legacy((value as any)[k])).join(',')+'}':JSON.stringify(value);
// Persisted JSON values compare directly. The rare object/scalar mismatch keeps
// the old behavior for non-JSON functions with custom toJSON implementations.
export function canonicalEqual(a:unknown,b:unknown):boolean{
 if(typeof a==='string'&&typeof b==='string')return a===b;
 const ao=a!==null&&typeof a==='object',bo=b!==null&&typeof b==='object';
 if(!ao&&!bo)return JSON.stringify(a)===JSON.stringify(b);
 if(ao!==bo){const scalar=ao?b:a;return typeof scalar==='function'||typeof scalar==='bigint'?legacy(a)===legacy(b):false;}
 if(Array.isArray(a)!==Array.isArray(b))return false;
 if(Array.isArray(a)&&Array.isArray(b)){if(a.length!==b.length)return false;for(let i=0;i<a.length;i++)if(!canonicalEqual(a[i],b[i]))return false;return true;}
 const aa=a as Record<string,unknown>,bb=b as Record<string,unknown>,keys=Object.keys(aa).sort();if(keys.length!==Object.keys(bb).length)return false;
 for(const key of keys)if(!Object.hasOwn(bb,key)||!canonicalEqual(aa[key],bb[key]))return false;return true;
}
// Equivalent JSON wire values without allocating one aggregate JSON string.
// The domain supplies JSON objects; standard boxed primitives and toJSON are
// supported as they are by the previous JSON.stringify/parse normalization.
export function jsonWireClone<T>(value:T):T{
 const parents=new Set<object>();
 function walk(input:any,key:string):any{
  let item=input;
  if(item!==null&&['object','function','bigint'].includes(typeof item)&&typeof item.toJSON==='function')item=item.toJSON(key);
  if(item instanceof Number||item instanceof String||item instanceof Boolean)item=item.valueOf();
  if(item&&typeof item==='object'&&Object.prototype.toString.call(item)==='[object BigInt]')throw new TypeError('BigInt cannot enter JSON wire state');
  if(item===null||typeof item==='string'||typeof item==='boolean')return item;
  if(typeof item==='number')return Number.isFinite(item)?(item===0?0:item):null;
  if(typeof item==='bigint')throw new TypeError('BigInt cannot enter JSON wire state');
  if(typeof item!=='object')return undefined;
  if(parents.has(item))throw new TypeError('Cyclic JSON wire state');parents.add(item);let result:any;
  if(Array.isArray(item)){result=[];for(let i=0;i<item.length;i++){const entry=walk(item[i],String(i));result.push(entry===undefined?null:entry);}}
  else{result={};for(const name of Object.keys(item)){const entry=walk(item[name],name);if(entry!==undefined){if(name==='__proto__')Object.defineProperty(result,name,{value:entry,writable:true,enumerable:true,configurable:true});else result[name]=entry;}}}
  parents.delete(item);return result;
 }
 const result=walk(value,'');if(result===undefined)throw new SyntaxError('JSON wire root is undefined');return result as T;
}
