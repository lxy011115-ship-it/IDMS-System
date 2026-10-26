import test from 'node:test';
import assert from 'node:assert/strict';
import {resolve} from 'node:path';
import {createColdFieldTransportMaterialsV1,assertColdFieldTransportMaterialsV1} from '../scripts/cold-field-transport-materials-v1.mjs';

const uuid='d6be99e7-e43b-4ef6-b4cc-010315ed1404';
const raw=()=>({trust:{controlId:uuid,sourceHash:'b'.repeat(64),storeFile:resolve('work/no-such-cold-field-transport-case/control.sqlite')},recoveryId:uuid,tenantId:'sandbox',configurationFile:resolve('work/no-such-cold-field-transport-case/materials.json'),roots:[resolve('work/no-such-cold-field-transport-case')]});

test('caller declarations, legacy handles, copied handles and serialized owners cannot authorize cold transport I/O',async()=>{
  const unsafe={phase:'HELD',recoveryId:uuid,sourceHash:'b'.repeat(64),allBusinessWritesClosed:true};
  for(const owner of [null,{},unsafe,{...unsafe},JSON.parse(JSON.stringify(unsafe)),{state(){throw Error('caller state must never be trusted');},acquire(){throw Error('caller acquire must never run');}},Object.freeze({assertAuthorized(){throw Error('caller callback must never run');}})]){
    await assert.rejects(createColdFieldTransportMaterialsV1(raw(),owner),error=>error.code==='COLD_OWNED_SESSION_NOT_MINTED');
  }
});

test('legacy registration and arbitrary authorization callbacks are rejected by the new context schema',async()=>{
  for(const extra of [{registration:{fieldEnabled:true}},{assertAuthorized(){throw Error('not a cold owner');}},{authorize(){throw Error('not a cold owner');}},{session:{phase:'HELD'}},{signal:new AbortController().signal}]){
    await assert.rejects(createColdFieldTransportMaterialsV1({...raw(),...extra},{}),error=>error.code==='COLD_FIELD_TRANSPORT_CONFIG');
  }
});

test('invalid recovery context and unbounded material roots are rejected before store or network access',async()=>{
  for(const change of [{recoveryId:'not-a-recovery'},{configurationFile:'relative.json'},{roots:[]},{roots:Array(17).fill(resolve('work'))},{roots:['relative']},{tenantId:''}]){
    await assert.rejects(createColdFieldTransportMaterialsV1({...raw(),...change},{}),error=>error.code==='COLD_FIELD_TRANSPORT_CONFIG');
  }
});

test('serialized transport evidence never becomes a callable inspection or original owner',()=>{
  const evidence={format:'COLD_FIELD_TRANSPORT_MATERIALS_V1',originalHeldSessionBound:true,actualTransportObserved:true};
  for(const candidate of [null,{},evidence,{...evidence},JSON.parse(JSON.stringify(evidence)),{evidence(){throw Error('caller evidence must never run');}}]){
    assert.throws(()=>assertColdFieldTransportMaterialsV1(candidate,{},{}),error=>error.code==='COLD_FIELD_TRANSPORT_OWNER');
  }
});
