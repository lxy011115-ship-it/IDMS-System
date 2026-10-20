import {test} from 'node:test';
import assert from 'node:assert/strict';
import {telemetryQualityFixture} from '../scripts/fixtures/telemetry-quality-model.mjs';
import {compileGovernanceMap,readGovernanceMap} from './source-governance-map-v4.ts';
import {tenantPayload} from './entity-repository.ts';
import {sourceGovernanceDecision} from './source-governance.ts';
import {sourceGovernanceFacts,sourceDefinitionRef} from './source-policy-references.ts';
import {createTemplate,submitTemplate,approveTemplate} from './catalog.ts';
import type {SourcePolicy} from './source-policy-schema.ts';
const iso=(t:number)=>new Date(t).toISOString();
function clock<T>(at:number,task:()=>T){const Real=Date;globalThis.Date=class extends Real{constructor(v?:any){super(v===undefined?at:v);}static now(){return at;}} as DateConstructor;try{return task();}finally{globalThis.Date=Real;}}
const context=(actorId:string,roles:string[])=>({tenantId:'acme',actorId,actorType:'USER',authMode:'oidc' as const,roles,correlationId:'v4-gov-test'}),author=context('author',['tenant-admin']),reviewer=context('reviewer',['final-approver']),expected=(t:any)=>({expectedRevision:t.revision,expectedDigest:t.contentDigest});
function fixture(){const f=telemetryQualityFixture({count:0}),source=f.sources[0],at=f.now+1000,facts=sourceGovernanceFacts(f.imports,f.store.audits,'acme',at),points=source.points.map((p:any)=>({...p,definitionRef:sourceDefinitionRef(facts.current.find(h=>h.record.dataType==='POINT_DEFINITION'&&h.record.value.tag_code===p.tagCode&&h.record.value.device_code===source.deviceCode)!)})),policy:SourcePolicy={deviceCode:source.deviceCode,edgeId:source.edgeId,definitionVersion:'telemetry-source-governance-1.0.0',changeIntent:'INITIAL',changeReason:'v4边界完整核对',entries:[{id:'initial',effectiveFrom:iso(at+1000),reason:'未来生效',mapping:{origin:'SIMULATOR',mapVersion:source.mapVersion,points}},{id:'pause',effectiveFrom:iso(at+3000),reason:'明确暂停',mapping:null}]};
 const publish=(p=policy,version='1.0.0',time=at)=>clock(time,()=>{const t=createTemplate(f.store,{templateKey:'v4-source-test',version,industry:'设备',manifest:{schemaVersion:1,minPlatformVersion:'0.1.0',purpose:'telemetry-source-policy',modules:['equipment'],policy:{finalApproval:'INDEPENDENT_HUMAN',deviceAccess:'READ_ONLY'},telemetrySourcePolicy:p}},author,f.imports);submitTemplate(f.store,t.id,expected(t),author,f.imports);approveTemplate(f.store,t.id,{...expected(t),decision:'APPROVED',comment:'独立批准来源'},reviewer,f.imports);return t;});return {...f,source,at,policy,publish};}
test('compiled intervals match legacy at publication/effective/pause boundaries and for unknown tags/configurations',async()=>{
 const f=fixture();f.publish();const p=tenantPayload(f.snapshot,'acme'),changed={...f.source,mapVersion:'different'},c=compileGovernanceMap(p,'acme',[f.source,changed]),values=new Map(c.entries.map(e=>[e.namespace+'\0'+e.key,JSON.parse(e.valueText)])),get=async(ns:string,key:string)=>values.get(ns+'\0'+key);
 const times=new Set([-8640000000000000,0,f.now,f.at-1,f.at,f.at+1,f.at+999,f.at+1000,f.at+1001,f.at+2999,f.at+3000,f.at+3001,8640000000000000]);for(const source of [f.source,changed])for(const at of times)for(const tag of [null,'unknown',...source.points.map((p:any)=>p.tagCode)]){
  const result=await readGovernanceMap(source,at,tag,get);assert.deepEqual(result.decision,sourceGovernanceDecision(f.store,f.imports,source,at,tag));assert.ok(result.nodeReads<=4);
 }assert.ok(c.boundaryChecks>0);assert.equal(c.heads.length,2);
});
test('definition correction and later source version preserve historical decisions and current denial/recovery',async()=>{
 const f=fixture();f.publish({...f.policy,entries:[{...f.policy.entries[0],effectiveFrom:iso(f.now-10000)}]});const before=sourceGovernanceDecision(f.store,f.imports,f.source,f.at,'vibration_rms'),row=f.imports.records.find((r:any)=>r.dataType==='POINT_DEFINITION'&&r.value.tag_code==='vibration_rms');clock(f.at+1000,()=>f.approve('POINT_DEFINITION',[{...row.value,expected_interval_seconds:5}],{supersedesBatchId:row.batchId,correctionReason:'修订间隔'}));
 const p=structuredClone(f.policy);p.changeIntent='RETROSPECTIVE_CORRECTION';p.entries=[{...p.entries[0],effectiveFrom:iso(f.now-10000)}];const now=sourceGovernanceFacts(f.imports,f.store.audits,'acme',f.at+2000).current.find(h=>h.record.dataType==='POINT_DEFINITION'&&h.record.value.tag_code==='vibration_rms')!;p.entries[0].mapping!.points[0].definitionRef=sourceDefinitionRef(now);f.publish(p,'1.1.0',f.at+2000);
 const c=compileGovernanceMap(tenantPayload(f.snapshot,'acme'),'acme',[f.source]),m=new Map(c.entries.map(e=>[e.namespace+'\0'+e.key,JSON.parse(e.valueText)])),get=async(ns:string,key:string)=>m.get(ns+'\0'+key);
 for(const at of [f.at,f.at+999,f.at+1000,f.at+1001,f.at+1999,f.at+2000,f.at+2001])assert.deepEqual((await readGovernanceMap(f.source,at,'vibration_rms',get)).decision,sourceGovernanceDecision(f.store,f.imports,f.source,at,'vibration_rms'));assert.deepEqual((await readGovernanceMap(f.source,f.at,'vibration_rms',get)).decision,before);
 assert.equal((await readGovernanceMap(f.source,f.at+1000,'vibration_rms',get)).decision.allowed,false);assert.equal((await readGovernanceMap(f.source,f.at+2000,'vibration_rms',get)).decision.allowed,true);
});
test('unapproved simulator and FIELD semantics match, missing/changed indexed nodes fail closed',async()=>{
 const f=fixture(),field={...f.source,origin:'FIELD' as const},c=compileGovernanceMap(tenantPayload(f.snapshot,'acme'),'acme',[f.source,field]),m=new Map(c.entries.map(e=>[e.namespace+'\0'+e.key,JSON.parse(e.valueText)])),get=async(ns:string,key:string)=>m.get(ns+'\0'+key);
 for(const s of [f.source,field])assert.deepEqual((await readGovernanceMap(s,f.at,'vibration_rms',get)).decision,sourceGovernanceDecision(f.store,f.imports,s,f.at,'vibration_rms'));
 const h=c.heads[0],key='blob\0v4gov_node:'+h.root;(m.get(key) as any).from=0;await assert.rejects(readGovernanceMap(f.source,f.at,'vibration_rms',get));m.delete(key);await assert.rejects(readGovernanceMap(f.source,f.at,'vibration_rms',get));
});
