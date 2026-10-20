import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {createAuditCursorCodec,memoryAuditCursorCodec,AuditPageError} from './audit-cursor.ts';
import {validateKeyRing,sealState,sha,type CryptoBinding} from './auth-state.ts';
const key=()=>randomBytes(32).toString('base64url');
const ring=()=>validateKeyRing({format:1,activeKeyId:'key-1',keys:[{keyId:'key-1',key:key()}]});
const invalid=(error:unknown)=>error instanceof AuditPageError&&error.status===400&&error.code==='AUDIT_CURSOR_INVALID';
test('audit cursors hide private window bindings and survive another core and restart with the same namespace',()=>{
 const keys=ring(),a=createAuditCursorCodec(keys,'deployment','scope'),b=createAuditCursorCodec(structuredClone(keys),'deployment','scope'),plain={subject:'private-actor',head:{sequence:'123456789',eventId:'private-event'},tenant:'private-tenant'};
 const token=a.seal(plain);assert.deepEqual(b.open(token),plain);assert.notEqual(a.seal(plain),token);for(const word of ['private','123456789','tenant','sequence'])assert.equal(token.includes(word),false);
 for(const codec of [createAuditCursorCodec(keys,'other','scope'),createAuditCursorCodec(keys,'deployment','other'),createAuditCursorCodec(ring(),'deployment','scope')])assert.throws(()=>codec.open(token),invalid);
});
test('audit cursor rotation reads retained keys, writes only active keys and rejects a removed key',()=>{
 const old=ring(),token=createAuditCursorCodec(old,'d','s').seal({ok:true}),next=validateKeyRing({...old,activeKeyId:'key-2',keys:[...old.keys,{keyId:'key-2',key:key()}]}),codec=createAuditCursorCodec(next,'d','s');assert.deepEqual(codec.open(token),{ok:true});assert.ok(codec.seal({ok:true}).startsWith('a1.key-2.'));assert.throws(()=>createAuditCursorCodec({...next,keys:next.keys.slice(1)},'d','s').open(token),invalid);
});
test('audit cursors reject every modified component, noncanonical encodings and excessive sizes uniformly',()=>{
 const codec=createAuditCursorCodec(ring(),'d','s'),token=codec.seal({ok:true}),parts=token.split('.');
 for(let i=0;i<parts.length;i++){const changed=[...parts];changed[i]=(changed[i][0]==='A'?'B':'A')+changed[i].slice(1);assert.throws(()=>codec.open(changed.join('.')),invalid);}
 for(const bad of ['',token+'.extra',token.replace('a1.','a2.'),token+'=',token.replace(parts[2],parts[2]+'='),'a'.repeat(6145),'a1.key-1.a.b.c'])assert.throws(()=>codec.open(bad),invalid);
 assert.throws(()=>codec.seal({q:'x'.repeat(4096)}),e=>e instanceof AuditPageError&&e.code==='AUDIT_QUERY_INVALID');
});
test('session envelopes and cursor envelopes cannot cross their separate encryption purposes',()=>{
 const keys=ring(),binding:CryptoBinding={deployment:sha('d'),scope:sha('s'),kind:'SESSION',lookup:sha('cookie'),revision:1,expires:Date.now()+10000},session=sealState({secret:'token'},binding,keys),codec=createAuditCursorCodec(keys,binding.deployment,binding.scope);
 assert.throws(()=>codec.open(['a1',session.keyId,session.iv,session.data,session.tag].join('.')),invalid);assert.throws(()=>codec.open(JSON.stringify(session)),invalid);
 const a=memoryAuditCursorCodec(),b=memoryAuditCursorCodec();assert.throws(()=>b.open(a.seal({ok:true})),invalid);
});
