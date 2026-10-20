import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {sealState,openState,validateKeyRing,sha,sessionLifetime,MemoryAuthStore,opaqueId,type CryptoBinding} from './auth-state.ts';
const ring=()=>validateKeyRing({format:1,activeKeyId:'key-1',keys:[{keyId:'key-1',key:randomBytes(32).toString('base64url')}]}),binding:CryptoBinding={deployment:sha('business'),scope:sha('issuer/client/audience/origin'),kind:'SESSION',lookup:sha('random-cookie'),revision:1,expires:Date.now()+3600000};
test('authenticated session encryption hides tokens and binds namespace, lookup, kind, revision, expiry and key',()=>{
 const keys=ring(),plain={tokens:{access_token:'access-secret',refresh_token:'refresh-secret'},csrf:'csrf-secret'},a=sealState(plain,binding,keys),b=sealState(plain,binding,keys);assert.notEqual(a.iv,b.iv);assert.deepEqual(openState(a,binding,keys),plain);assert.ok(!JSON.stringify(a).includes('secret'));
 for(const patch of [{deployment:sha('other')},{scope:sha('other')},{kind:'LOGIN' as const},{lookup:sha('other')},{revision:2},{expires:binding.expires+1}])assert.throws(()=>openState(a,{...binding,...patch},keys),/无法验证/);
 for(const patch of [{data:(a.data[0]==='A'?'B':'A')+a.data.slice(1)},{tag:(a.tag[0]==='A'?'B':'A')+a.tag.slice(1)},{keyId:'missing'},{iv:'invalid'},{extra:'untrusted'}])assert.throws(()=>openState({...a,...patch},binding,keys),/无法验证/);assert.throws(()=>openState(a,binding,ring()),/无法验证/);
});
test('key rings require distinct complete keys and can read retained prior keys while writing with the active key',()=>{
 const old=ring(),sealed=sealState({ok:true},binding,old),next=validateKeyRing({format:1,activeKeyId:'key-2',keys:[...old.keys,{keyId:'key-2',key:randomBytes(32).toString('base64url')}]});assert.deepEqual(openState(sealed,binding,next),{ok:true});assert.equal(sealState({ok:true},binding,next).keyId,'key-2');
 for(const value of [{...old,activeKeyId:'unknown'},{...old,keys:[...old.keys,old.keys[0]]},{...old,keys:[...old.keys,{keyId:'alias',key:old.keys[0].key}]},{...old,keys:[{keyId:'key-1',key:'short'}]},{...old,script:'run'}])assert.throws(()=>validateKeyRing(value));
});
test('login state is consumed once and concurrent session operations serialize without reviving a removed session',async()=>{
 const s=new MemoryAuthStore(),id=opaqueId(),pending={verifier:opaqueId(),nonce:opaqueId(),returnTo:'/',expires:Date.now()+10000};await s.putAttempt(id,pending);const taken=await Promise.all([s.takeAttempt(id),s.takeAttempt(id)]);assert.equal(taken.filter(Boolean).length,1);
 const sid=opaqueId(),session={identity:{tenantId:'acme',actorId:'real-sub',actorType:'USER',username:'qa',name:'QA',correlationId:''},tokens:{access_token:'token'},createdAt:Date.now(),expiresAt:Date.now()+60000,csrf:opaqueId()};await s.createSession(sid,session);let refreshes=0;await Promise.all(Array.from({length:6},()=>s.withSession(sid,async current=>{if(current.tokens.access_token==='token'){refreshes++;current.tokens.access_token='new-token';return {session:current,value:true};}return {value:true};})));assert.equal(refreshes,1);await s.withSession(sid,async current=>({remove:true,value:current}));assert.equal(await s.withSession(sid,async()=>({value:true})),undefined);
 await s.createSession(sid,{...session,createdAt:Date.now()-sessionLifetime-1});assert.equal(await s.withSession(sid,async()=>({value:true})),undefined);
});
