import test from 'node:test';
import assert from 'node:assert/strict';
import {memoryAuditCursorCodec} from './audit-cursor.ts';
import {parsePredictiveReadPageV4,predictiveReadIdentityV4} from './predictive-read-contract-v4.ts';
const ctx={tenantId:'sandbox',actorId:'analyzer',actorType:'USER',authMode:'oidc' as const,roles:['data-uploader'],scope:{provided:true,sites:['SITE-A'],lines:['*'],devices:['*']},correlationId:'test'};
const now=Date.now(),codec=memoryAuditCursorCodec(),root={revision:'12',rootId:'a'.repeat(64),rootHash:'b'.repeat(64),count:'20',receiptHash:'c'.repeat(64)};
const cursor=()=>({purpose:'PREDICTIVE_PAGE_V4_1',identity:predictiveReadIdentityV4(ctx),deployment:'d'.repeat(64),configuration:'e'.repeat(64),catalog:'f'.repeat(64),route:'ALERTS',device:'PUMP-1',state:'AWAITING_APPROVAL',pageSize:5,root,position:'10',createdAt:now,expiresAt:now+1800000});
test('predictive page binds current actor, effective roles and scope, route, device and fixed filters',()=>{
 const params=new URLSearchParams({cursor:codec.seal(cursor())});assert.equal(parsePredictiveReadPageV4(params,'ALERTS',ctx,codec,undefined,now).pageSize,5);
 for(const changed of [{...ctx,actorId:'other'},{...ctx,roles:['final-approver']},{...ctx,scope:{...ctx.scope,sites:['SITE-B']}}])assert.throws(()=>parsePredictiveReadPageV4(params,'ALERTS',changed,codec,undefined,now),/PREDICTIVE_CURSOR/);
 assert.throws(()=>parsePredictiveReadPageV4(params,'HEALTH',ctx,codec,undefined,now),/PREDICTIVE_CURSOR/);
 for(const extra of [{device:'PUMP-2'},{state:'RESOLVED'},{pageSize:'6'}])assert.throws(()=>parsePredictiveReadPageV4(new URLSearchParams({cursor:params.get('cursor')!,...extra}),'ALERTS',ctx,codec,undefined,now),/QUERY_CHANGED/);
});
test('a signed cursor still rejects future or expired times, malformed roots and out-of-range positions',()=>{
 for(const patch of [{createdAt:now+31000,expiresAt:now+1831000},{root:{...root,revision:'01'}},{root:{...root,unexpected:true}},{position:'9223372036854775808'},{unknown:true}])assert.throws(()=>parsePredictiveReadPageV4(new URLSearchParams({cursor:codec.seal({...cursor(),...patch})}),'ALERTS',ctx,codec,undefined,now),/PREDICTIVE_CURSOR/);
 assert.throws(()=>parsePredictiveReadPageV4(new URLSearchParams({cursor:codec.seal(cursor())}),'ALERTS',ctx,codec,undefined,now+1800000),/CURSOR_EXPIRED/);
});
test('device activity pages reject duplicate or unknown parameters and cannot change the path device using query parameters',()=>{
 for(const p of ['pageSize=1&pageSize=2','pageSize=0','pageSize=21','state=OPEN','unexpected=1','device=PUMP-2'])assert.throws(()=>parsePredictiveReadPageV4(new URLSearchParams(p),'JOBS',ctx,codec,'PUMP-1',now),/PREDICTIVE_QUERY/);
 assert.equal(parsePredictiveReadPageV4(new URLSearchParams(),'JOBS',ctx,codec,'PUMP-1',now).device,'PUMP-1');
});
