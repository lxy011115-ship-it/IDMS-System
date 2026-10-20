import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {AuthAuditCryptoV4,deriveAuthAuditKeyRingV4,authAuditPayloadV4,verifyAuthAuditEventV4} from './auth-audit-event-v4.ts';
import {sealState,openState} from './auth-state.ts';
const ring={format:1 as const,activeKeyId:'audit',keys:[{keyId:'audit',key:randomBytes(32).toString('base64url')}]},binding={deployment:'a'.repeat(64),databaseOid:'17'},draft={scope:'b'.repeat(64),tenantId:'sandbox',eventId:randomUUID(),position:'1',action:'AUTH_LOGIN' as const,occurredAtMs:String(Date.now()),previousHash:'0'.repeat(64)};
test('auth audit event is a minimal frozen historical identity, with canonical roles and no token/session authority fields',()=>{
 const crypto=new AuthAuditCryptoV4(ring,binding),event=crypto.event(draft,crypto.sessionRef(draft.scope,'c'.repeat(64)),'issuer-subject',['data-uploader','tenant-admin','data-uploader']);assert.deepEqual(event.payload.roles,['data-uploader','tenant-admin']);assert.deepEqual(Object.keys(event.payload).sort(),['actorId','format','reason','roles']);assert.equal(event.payload.reason,'OIDC_LOGIN');assert.throws(()=>verifyAuthAuditEventV4({...event,payload:{...event.payload,access_token:'private'} as any}));assert.throws(()=>authAuditPayloadV4('x',['r'.repeat(129)],'AUTH_LOGIN'));
});
test('delivery key export cannot decrypt session state; key witness detects an empty-queue misconfiguration',()=>{
 const derived=deriveAuthAuditKeyRingV4(ring,binding),crypto=new AuthAuditCryptoV4(derived,binding),witness=crypto.witness();assert.notEqual(derived.keys[0].key,ring.keys[0].key);crypto.verifyWitness(witness);assert.throws(()=>new AuthAuditCryptoV4(ring,binding).verifyWitness(witness));const aad={deployment:binding.deployment,scope:draft.scope,kind:'SESSION' as const,lookup:'c'.repeat(64),revision:1,expires:123},session=sealState({access_token:'private-session-token'},aad,ring);assert.throws(()=>openState(session,aad,derived));
});
test('audit AES-GCM binds source database/deployment, scope, tenant, sequence, action, identity digest and source chain; role OIDs are excluded',()=>{
 const app=new AuthAuditCryptoV4(ring,{...binding,roleOid:'3',catalogHash:'d'.repeat(64)} as any),delivery=new AuthAuditCryptoV4(ring,{...binding,roleOid:'4',catalogHash:'d'.repeat(64)} as any),event=app.event(draft,app.sessionRef(draft.scope,'c'.repeat(64)),'issuer-subject',['data-uploader']),box=app.seal(event);assert.deepEqual(delivery.open(event.header,box),event);
 for(const patch of [{tenantId:'other'},{scope:'e'.repeat(64)},{position:'2'},{action:'AUTH_LOGOUT'},{sessionRef:'f'.repeat(64)},{occurredAtMs:String(Number(draft.occurredAtMs)+1)},{previousHash:'a'.repeat(64)},{digest:'c'.repeat(64)}])assert.throws(()=>delivery.open({...event.header,...patch} as any,box),/BOX_INVALID/);
 assert.throws(()=>new AuthAuditCryptoV4(ring,{...binding,databaseOid:'18'}).open(event.header,box),/BOX_INVALID/);assert.throws(()=>delivery.open(event.header,{...box,tag:box.tag.replace(/^./,box.tag[0]==='A'?'B':'A')}),/BOX_INVALID/);
});
