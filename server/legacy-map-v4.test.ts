import {test} from 'node:test';
import assert from 'node:assert/strict';
import {encodeLegacyText,decodeLegacyText,encodeLegacyPayload,decodeLegacyPayload,legacyChunkBytes,legacyJsonText} from './legacy-map-v4.ts';
import {stateValueHash} from './state-map-v1.ts';
import {seedStore} from './store.ts';
import {tenantPayload} from './entity-repository.ts';
import {canonicalDigest} from './canonical-state.ts';
const lookup=(entries:ReturnType<typeof encodeLegacyText>)=>{const m=new Map(entries.map(e=>[e.namespace+'\0'+e.key,JSON.parse(e.valueText)]));return {m,get:async(ns:string,key:string)=>m.get(ns+'\0'+key)};};
test('exact PostgreSQL text preserves bigint, numeric, time, bytea and split UTF8',async()=>{
 const texts=['{"bigint":9223372036854775807,"numeric":1234567890123456789.123456789,"at":"2026-10-19T19:00:00+00:00","raw":"\\\\x00ff"}',JSON.stringify('中😀'.repeat(110000))];
 for(const text of texts){const e=encodeLegacyText('legacy_sql','table:1',text),l=lookup(e);assert.equal(await decodeLegacyText('legacy_sql','table:1',l.get),text);assert.ok(e.every(x=>Buffer.byteLength(x.valueText)<=1024*1024));if(Buffer.byteLength(text)>legacyChunkBytes){assert.ok(e.length>2);const key=e[0].namespace+'\0'+e[0].key;(l.m.get(key) as any).base64='AA==';await assert.rejects(decodeLegacyText('legacy_sql','table:1',l.get));}}
 assert.throws(()=>encodeLegacyText('legacy_sql','x','\ud800'));
});
test('descriptor cannot move scopes or omit/reorder chunks',async()=>{
 const e=encodeLegacyText('legacy_sql','x','z'.repeat(legacyChunkBytes+1)),l=lookup(e),d=l.m.get('legacy_sql\0x') as any;
 d.chunks.reverse();await assert.rejects(decodeLegacyText('legacy_sql','x',l.get));d.chunks.reverse();d.scope='other';await assert.rejects(decodeLegacyText('legacy_sql','x',l.get));
});
test('all tenant payload collections retain ordering and old canonical digest',async()=>{
 const s=seedStore(),{audits,idempotency,...business}=s,full={version:2,business,audits,idempotency:[...idempotency],imports:{batches:[],records:[],requests:[]}};
 for(const t of ['acme','sandbox']){const p=tenantPayload(full,t),entries=[...encodeLegacyPayload(t,p)],l=lookup(entries),decoded=await decodeLegacyPayload(t,l.get);assert.deepEqual(decoded,p);assert.equal(canonicalDigest(decoded),canonicalDigest(p));await assert.rejects(decodeLegacyPayload(t==='acme'?'sandbox':'acme',l.get));
  const first=entries.find(e=>e.namespace==='legacy_payload')!;const original=stateValueHash(first.valueText);assert.equal(typeof original,'string');l.m.delete(first.namespace+'\0'+first.key);await assert.rejects(decodeLegacyPayload(t,l.get));}
 assert.equal(legacyJsonText({b:1,a:[null,true]}),'{"a":[null,true],"b":1}');
});
