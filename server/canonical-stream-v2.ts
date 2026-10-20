import {createHash} from 'node:crypto';
// Keep the existing equality and JSON-wire contracts in their original module.
export {canonicalEqual,jsonWireClone} from './canonical-state.ts';

// An opt-in byte-compatible encoder. No digest format or root field changes.
// The key cache is local to one traversal: at most 128 short key prefixes.
export function emitCanonical(value:unknown,write:(text:string)=>void):void{
 const parents=new Set<object>(),keys=new Map<string,string>();let pieces:string[]=[],length=0;
 const flush=()=>{if(length){write(pieces.join(''));pieces=[];length=0;}};
 const emit=(text:string)=>{if(length+text.length>32768)flush();pieces.push(text);length+=text.length;if(length>=32768)flush();};
 function string(text:string){
  if(text.length<=8192){emit(JSON.stringify(text));return;}
  emit('"');for(let start=0;start<text.length;){let end=Math.min(start+8192,text.length);if(end<text.length&&text.charCodeAt(end-1)>=0xd800&&text.charCodeAt(end-1)<=0xdbff&&text.charCodeAt(end)>=0xdc00&&text.charCodeAt(end)<=0xdfff)end--;emit(JSON.stringify(text.slice(start,end)).slice(1,-1));start=end;}emit('"');
 }
 function key(text:string){
  if(text.length<=128){let encoded=keys.get(text);if(encoded===undefined){encoded=JSON.stringify(text)+':';if(keys.size<128)keys.set(text,encoded);}emit(encoded);}
  else{string(text);emit(':');}
 }
 function walk(item:unknown,position:'root'|'array'|'object'){
  if(typeof item==='string'){string(item);return;}
  if(item&&typeof item==='object'){
   if(parents.has(item))throw new TypeError('Cyclic canonical state');parents.add(item);
   if(Array.isArray(item)){emit('[');for(let i=0;i<item.length;i++){if(i)emit(',');walk(item[i],'array');}emit(']');}
   else{emit('{');const names=Object.keys(item).sort();for(let i=0;i<names.length;i++){if(i)emit(',');key(names[i]);walk((item as Record<string,unknown>)[names[i]],'object');}emit('}');}
   parents.delete(item);return;
  }
  const scalar=JSON.stringify(item);if(scalar===undefined){if(position==='root')throw new TypeError('Canonical root has no digestable text');emit(position==='array'?'':'undefined');}else emit(scalar);
 }
 walk(value,'root');flush();
}
export function canonicalDigest(value:unknown):string{const hash=createHash('sha256');emitCanonical(value,text=>hash.update(text));return hash.digest('hex');}
