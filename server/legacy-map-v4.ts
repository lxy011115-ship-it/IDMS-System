import {createHash} from 'node:crypto';
import {emitCanonical} from './canonical-stream-v2.ts';
import {canonicalDigest} from './canonical-state.ts';
import {validateTenantPayload,type TenantPayload} from './entity-repository.ts';
import {entityTables} from './entity-schema.ts';
import {stateValueText,type StateOperation} from './state-map-v1.ts';
export const legacyMapFormat='IDMS_LEGACY_V3_MAP_V1';
export const legacyChunkBytes=256*1024,legacyMaximumTextBytes=64*1024*1024;
const sha=(b:Uint8Array)=>createHash('sha256').update(b).digest('hex');
function need(ok:unknown):asserts ok{if(!ok)throw Error('LEGACY_MAP_INTEGRITY');}
const hash=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const ordinal=(n:number)=>{need(Number.isSafeInteger(n)&&n>0);return String(n).padStart(20,'0');};
export interface LegacyEntry {namespace:string;key:string;valueText:string}
export type LegacyLookup=(namespace:string,key:string)=>Promise<unknown>;
interface TextDescriptor {format:'IDMS_LEGACY_TEXT_V1';scope:string;key:string;bytes:number;sha256:string;inline?:string;chunks?:string[]}
export function legacyJsonText(value:unknown){const out:string[]=[];let bytes=0;emitCanonical(value,part=>{bytes+=Buffer.byteLength(part);need(bytes<=legacyMaximumTextBytes);out.push(part);});return out.join('');}
/** Exact source text; never parse PostgreSQL int8/numeric JSON through JS numbers. */
export function encodeLegacyText(namespace:string,key:string,text:string):LegacyEntry[]{
 need(typeof text==='string');const bytes=Buffer.from(text);need(bytes.length<=legacyMaximumTextBytes&&bytes.toString('utf8')===text);const digest=sha(bytes),base:TextDescriptor={format:'IDMS_LEGACY_TEXT_V1',scope:namespace,key,bytes:bytes.length,sha256:digest};
 if(bytes.length<=legacyChunkBytes)return [{namespace,key,valueText:stateValueText({...base,inline:text})}];
 const entries:LegacyEntry[]=[],chunks:string[]=[];
 for(let at=0,index=0;at<bytes.length;at+=legacyChunkBytes,index++){
  const part=bytes.subarray(at,at+legacyChunkBytes),name='legacy-text:'+digest+':'+index;chunks.push(sha(part));entries.push({namespace:'blob',key:name,valueText:stateValueText({format:'IDMS_LEGACY_CHUNK_V1',index,bytes:part.length,sha256:sha(part),base64:part.toString('base64')})});
 }entries.push({namespace,key,valueText:stateValueText({...base,chunks})});return entries;
}
export async function decodeLegacyText(namespace:string,key:string,get:LegacyLookup){
 const d=await get(namespace,key) as TextDescriptor;need(d&&d.format==='IDMS_LEGACY_TEXT_V1'&&d.scope===namespace&&d.key===key&&Number.isSafeInteger(d.bytes)&&d.bytes>=0&&d.bytes<=legacyMaximumTextBytes&&hash(d.sha256));let bytes:Buffer;
 if(Object.hasOwn(d,'inline')){need(Object.keys(d).length===6&&typeof d.inline==='string'&&!Object.hasOwn(d,'chunks'));bytes=Buffer.from(d.inline);need(bytes.length<=legacyChunkBytes&&bytes.toString('utf8')===d.inline);}
 else{
  need(Object.keys(d).length===6&&Array.isArray(d.chunks)&&d.chunks.length===Math.ceil(d.bytes/legacyChunkBytes)&&d.bytes>legacyChunkBytes);const parts:Buffer[]=[];
  for(let index=0;index<d.chunks.length;index++){
   const c=await get('blob','legacy-text:'+d.sha256+':'+index) as {format:string;index:number;bytes:number;sha256:string;base64:string};need(c&&Object.keys(c).length===5&&c.format==='IDMS_LEGACY_CHUNK_V1'&&c.index===index&&typeof c.base64==='string'&&hash(c.sha256));const part=Buffer.from(c.base64,'base64'),expected=Math.min(legacyChunkBytes,d.bytes-index*legacyChunkBytes);
   need(c.bytes===expected&&part.length===expected&&part.toString('base64')===c.base64&&sha(part)===c.sha256&&c.sha256===d.chunks[index]);parts.push(part);
  }bytes=Buffer.concat(parts);
 }need(bytes.length===d.bytes&&sha(bytes)===d.sha256);const text=bytes.toString('utf8');need(Buffer.from(text).equals(bytes));return text;
}
export interface LegacyPayloadIndex {format:typeof legacyMapFormat;tenantId:string;canonicalDigest:string;collections:{name:string;count:number}[]}
function collections(payload:TenantPayload){return [
 ...Object.keys(entityTables).sort().map(name=>({name:'business/'+name,rows:(payload.business as any)[name] as unknown[]})),
 ...(['batches','records','requests'] as const).map(name=>({name:'imports/'+name,rows:payload.imports[name] as unknown[]})),
 {name:'audits',rows:payload.audits as unknown[]},{name:'idempotency',rows:payload.idempotency as unknown[]}
 ];}
export function* encodeLegacyPayload(tenantId:string,payload:TenantPayload):Generator<LegacyEntry>{
 validateTenantPayload(payload,tenantId);const groups=collections(payload),index:LegacyPayloadIndex={format:legacyMapFormat,tenantId,canonicalDigest:canonicalDigest(payload),collections:groups.map(g=>({name:g.name,count:g.rows.length}))};
 for(const g of groups)for(let i=0;i<g.rows.length;i++)yield* encodeLegacyText('legacy_payload',g.name+':'+ordinal(i+1),legacyJsonText(g.rows[i]));
 yield {namespace:'legacy_meta',key:'payload',valueText:stateValueText(index)};
}
export async function decodeLegacyPayload(tenantId:string,get:LegacyLookup){
 const index=await get('legacy_meta','payload') as LegacyPayloadIndex;need(index&&index.format===legacyMapFormat&&index.tenantId===tenantId&&hash(index.canonicalDigest)&&Array.isArray(index.collections));
 const payload:TenantPayload={business:Object.fromEntries(Object.keys(entityTables).map(k=>[k,[]])) as unknown as TenantPayload['business'],imports:{batches:[],records:[],requests:[]},audits:[],idempotency:[]},expected=collections(payload).map(g=>g.name);need(index.collections.length===expected.length);
 for(let n=0;n<index.collections.length;n++){
  const c=index.collections[n];need(c&&Object.keys(c).length===2&&c.name===expected[n]&&Number.isSafeInteger(c.count)&&c.count>=0&&c.count<=1000000);const rows:unknown[]=[];
  for(let i=0;i<c.count;i++)rows.push(JSON.parse(await decodeLegacyText('legacy_payload',c.name+':'+ordinal(i+1),get)));
  if(c.name.startsWith('business/'))(payload.business as any)[c.name.slice(9)]=rows;
  else if(c.name.startsWith('imports/'))(payload.imports as any)[c.name.slice(8)]=rows;
  else (payload as any)[c.name]=rows;
 }need(canonicalDigest(payload)===index.canonicalDigest);validateTenantPayload(payload,tenantId);return payload;
}
export function legacySqlRowKey(table:string,index:number){need(/^[a-z][a-z0-9_]{0,62}$/.test(table));return table+':'+ordinal(index);}
export function legacyOperations(entries:readonly LegacyEntry[]):StateOperation[]{return entries.map(e=>({...e,expected:null}));}
