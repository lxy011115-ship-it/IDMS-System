import assert from 'node:assert/strict';
import {fieldEventFixture} from './field-event-model.mjs';
import {tenantSeed} from '../database-migrations.mjs';
import {encodeGovernanceCandidateV6} from '../../server/governance-plan-v6.ts';
import {publicGovernedSource} from '../../server/source-governance.ts';
import {canonicalDigest} from '../../server/canonical-state.ts';
import {telemetryDomainFormat} from '../../server/telemetry-map-v4.ts';
import {stateValueHash,stateValueText} from '../../server/state-map-v1.ts';
import {fieldMapStorageV1} from '../../server/field-map-receive-v1.ts';
import {fieldMapIntakeFormatV1} from '../../server/field-map-intake-bootstrap-v1.ts';
// In-memory planner oracle with declared protocol witnesses; no native OT or SQL claim.
export function fieldMapIntakeModelV1(){
 const f=fieldEventFixture(),{audits,idempotency,...business}=f.store,payload=tenantSeed({version:2,business,audits,imports:f.imports,idempotency:[...idempotency]},'acme'),map=new Map(),binding={tenantId:'acme',databaseOid:'1',roleOid:'2',catalogHash:'a'.repeat(64)},storage=fieldMapStorageV1(binding);let revision=0n;
 const install=p=>{const c={format:telemetryDomainFormat,tenantId:'acme',status:'ACTIVE',epoch:String(revision+1n),legacySealKey:'0'.repeat(64),governanceAnchorDigest:canonicalDigest(p)};for(const e of encodeGovernanceCandidateV6(p,0,c,[publicGovernedSource(f.sources[0])]))map.set(e.namespace+'\0'+e.key,JSON.parse(e.valueText));};install(payload);
 const head=()=>({revision:String(revision),rootId:'f'.repeat(64),rootHash:canonicalDigest([...map].sort(([a],[b])=>a.localeCompare(b))),receiptHash:'e'.repeat(64),count:String(map.size)});
 map.set('domain_head\0field_intake',{format:fieldMapIntakeFormatV1,tenantId:'acme',initializedFrom:(({revision,rootId,rootHash,receiptHash})=>({revision,rootId,rootHash,receiptHash}))(head())});
 const snapshot=()=>{const image=structuredClone(map),cache=new Map(),stats={keys:0,valueBytes:0};return {tenantId:'acme',head:head(),stats,state:async(ns,key)=>{const id=ns+'\0'+key;if(!cache.has(id)){const value=image.get(id),result=image.has(id)?{present:true,value,valueHash:stateValueHash(stateValueText(value))}:{present:false,value:null,valueHash:null};cache.set(id,result);stats.keys++;stats.valueBytes+=value===undefined?0:Buffer.byteLength(stateValueText(value));assert(stats.keys<=256&&stats.valueBytes<=16*1024**2,'UNIT_SNAPSHOT_BUDGET');}return structuredClone(cache.get(id));},get:async function(ns,key){const v=await this.state(ns,key);assert(v.present,'UNIT_REQUIRED_MEMBER_MISSING');return v.value;},operation:async function(ns,key,value){return {namespace:ns,key,expected:(await this.state(ns,key)).valueHash,valueText:stateValueText(value)};}};};
 const apply=ops=>{for(const op of ops){const old=map.get(op.namespace+'\0'+op.key);assert.equal(old===undefined?null:stateValueHash(stateValueText(old)),op.expected,'UNIT_CAS_CONFLICT');}for(const op of ops)map.set(op.namespace+'\0'+op.key,JSON.parse(op.valueText));if(ops.length)revision++;};
 const auditImage=()=>[...map].filter(([k])=>k.startsWith('audit_order\0')).sort(([a],[b])=>a.localeCompare(b)).map(([,o])=>map.get('audit\0'+o.eventId));
 const pause=()=>{Object.assign(f.store,structuredClone(payload.business),{audits:auditImage(),idempotency:new Map(payload.idempotency)});const p=structuredClone(f.policy);p.changeIntent='RETROSPECTIVE_CORRECTION';p.entries[0].admission=null;f.publish('field-channel-policy','fieldChannelPolicy',p,'issuer-qa-field','1.0.2');const {audits,idempotency,...business}=f.store;const next=tenantSeed({version:2,business,audits,imports:f.imports,idempotency:[...idempotency]},'acme');install(next);return next;};
 return {...f,registry:f.snapshot,payload,map,binding,storage,head,snapshot,apply,auditImage,pause};
}
