import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {dataQualityPolicySchema,type PolicyRule} from './quality-policy-schema.ts';
import {qualityPolicyHistory} from './quality-policy-history.ts';
import {publicationIndex} from './template-history.ts';
import {evaluateQualityPolicy,qualityEvaluationPackage,verifyQualityEvaluationPackage} from './quality-policy-evaluation.ts';
import {createTemplate,editTemplate,submitTemplate,approveTemplate,exportTemplate,importTemplate,templateContentDigest} from './catalog.ts';
import {calendarTemplateVisible} from './operation-calendar.ts';
import {commandAccess} from './command-access.ts';
import {canonical,digest} from './imports.ts';
import {telemetryQualityFixture} from '../scripts/fixtures/telemetry-quality-model.mjs';
import type {FrozenCoverageInput} from './frozen-coverage-v1.ts';
const iso=(at:number)=>new Date(at).toISOString(),ctx=(actorId:string,roles:string[],site='FACTORY-01')=>({tenantId:'acme',actorId,actorType:'USER',authMode:'oidc' as const,roles,correlationId:randomUUID(),scope:{provided:true,sites:[site],lines:['*'],devices:['*']}}),designer=ctx('author',['tenant-admin','final-approver']),reviewer=ctx('reviewer',['final-approver']),expected=(t:any)=>({expectedDigest:t.contentDigest,expectedRevision:t.revision});
const rule=(metric:PolicyRule['metric']='NON_GOOD_PERCENT',extra:Partial<PolicyRule>={}):PolicyRule=>({id:metric.toLowerCase(),tagCode:null,source:'BOTH',metric,operator:'GT',threshold:0,severity:'WARNING',reason:'企业明确核对质量条件',...extra});
const policy=(at:string,rules:PolicyRule[]|null=[rule()],extra={})=>({deviceCode:'QUALITY-A',changeIntent:'INITIAL',changeReason:'核对企业质量依据',entries:[{id:'initial',effectiveFrom:at,reason:'明确起始',rules}],...extra});
const manifest=(p:any)=>({schemaVersion:1,minPlatformVersion:'0.1.0',purpose:'data-quality-policy',modules:['quality'],policy:{finalApproval:'INDEPENDENT_HUMAN',deviceAccess:'READ_ONLY'},dataQualityPolicy:p});
function clock<T>(at:number,fn:()=>T){const Real=Date;globalThis.Date=class extends Real{constructor(v?:any){super(v===undefined?at:v);}static now(){return at;}} as DateConstructor;try{return fn();}finally{globalThis.Date=Real;}}
function fixture(){const f=telemetryQualityFixture({count:20}),at=f.now+1000,make=(version='1.0.0',p=policy(iso(f.now-600000)),key='quality-policy-a')=>createTemplate(f.store,{templateKey:key,version,industry:'质量规则',manifest:manifest(p)},designer,f.imports),publish=(t:any,time=at)=>clock(time,()=>{submitTemplate(f.store,t.id,expected(t),designer,f.imports);return approveTemplate(f.store,t.id,{...expected(t),decision:'APPROVED',comment:'独立核对'},reviewer,f.imports);}),read=(time:number)=>{const index=publicationIndex(f.store.audits,'acme');return qualityPolicyHistory(f.store.templates,'acme','QUALITY-A',time,id=>index.get(id));};return {...f,at,make,publish,read};}
function inputFixture(){const golden=JSON.parse(readFileSync(new URL('../scripts/fixtures/frozen-coverage-v1-golden.json',import.meta.url),'utf8')),input=structuredClone(golden.input) as FrozenCoverageInput;input.query.tagCode='vibration_rms';input.imports=input.imports.filter(r=>r.record.dataType==='DEVICE'||r.record.value.tag_code==='vibration_rms');const context={policy:dataQualityPolicySchema(policy(input.query.from)),source:{templateId:'quality-template',templateKey:'quality-policy-a',version:'1.0.0',contentDigest:'a'.repeat(64),recordedAt:input.query.knownAt,governanceEventId:'quality-approved',changeIntent:'INITIAL' as const,changeReason:'核对企业质量依据'}};return {input,context};}

test('quality policy schema is strict and requires explicit timeline, selectors, finite typed thresholds and reasons',()=>{
 const p=policy('2026-10-16T00:00:00Z');assert.equal(dataQualityPolicySchema(p).entries[0].effectiveFrom,'2026-10-16T00:00:00.000Z');
 const bad=[{...p,script:'x'},{...p,entries:[]},{...p,entries:[p.entries[0],p.entries[0]]},{...p,entries:[{...p.entries[0],rules:[]}]},{...p,entries:[{...p.entries[0],effectiveFrom:'2026-10-16T00:00:00'}]}];for(const x of bad)assert.throws(()=>dataQualityPolicySchema(x));
 for(const extra of [{threshold:NaN},{threshold:Infinity},{threshold:-1},{threshold:101},{operator:'EQ'},{source:'CURRENT'},{tagCode:undefined},{reason:''},{metric:'script'},{enabled:false}])assert.throws(()=>dataQualityPolicySchema(policy(p.entries[0].effectiveFrom,[{...rule(),...extra} as any])));
 assert.throws(()=>dataQualityPolicySchema(policy(p.entries[0].effectiveFrom,[rule('DUPLICATE_TIME_COUNT',{threshold:1.5})])));assert.equal(dataQualityPolicySchema(policy(p.entries[0].effectiveFrom,null)).entries[0].rules,null);
});
test('policy template enforces current approved-device scope, one family and immutable identity including cached-command access',()=>{
 const f=fixture(),t=f.make(),hidden=ctx('hidden',['final-approver'],'FACTORY-02');assert.equal(calendarTemplateVisible(t,f.store,f.imports,reviewer),true);assert.equal(calendarTemplateVisible(t,f.store,f.imports,hidden),false);
 assert.throws(()=>commandAccess('/api/v1/templates/'+t.id+'/approval','POST',expected(t),hidden,f.imports,f.store),(e:any)=>e.status===404);
 assert.throws(()=>f.make('1.1.0',policy(iso(f.now)),'second-family'),/同设备同用途/);assert.throws(()=>f.make('1.1.0',{...policy(iso(f.now)),deviceCode:'MISSING'}),/未批准/);
 assert.throws(()=>editTemplate(f.store,t.id,{...expected(t),manifest:manifest({...policy(iso(f.now)),deviceCode:'QUALITY-B'})},designer,f.imports),/改绑/);
 assert.throws(()=>createTemplate(f.store,{templateKey:'quality-policy-a',version:'1.1.0',industry:'x',parent:'x@1.0.0',manifest:manifest(policy(iso(f.now)))},designer,f.imports));
});
test('independent quality publication, exact exported package and higher-version retirement preserve old knownAt selection',()=>{
 const f=fixture(),t=f.make();submitTemplate(f.store,t.id,expected(t),designer,f.imports);assert.throws(()=>approveTemplate(f.store,t.id,{...expected(t),decision:'APPROVED',comment:'本人审核'},designer,f.imports),/不得终审/);
 clock(f.at,()=>approveTemplate(f.store,t.id,{...expected(t),decision:'APPROVED',comment:'独立核对'},reviewer,f.imports));assert.equal(f.read(f.at-1),null);const before=f.read(f.at)!;
 const next=f.make('1.1.0',policy(iso(f.now-600000),[rule('NON_GOOD_PERCENT',{threshold:10})],{changeIntent:'RETROSPECTIVE_CORRECTION'}));f.publish(next,f.at+1000);assert.equal(t.status,'RETIRED');assert.deepEqual(f.read(f.at),before);assert.equal(f.read(f.at+1000)?.source.version,'1.1.0');const pack=exportTemplate(f.store,t.id,reviewer,f.imports);assert.equal(pack.contentDigest,t.contentDigest);
 const other=fixture();const imported=importTemplate(other.store,pack,designer,other.imports);assert.equal(imported.status,'DRAFT');assert.equal(imported.publishedBy,undefined);
});
test('future quality policy edits preserve exact effective entries and persisted approval boundary failure is atomic',()=>{
 const f=fixture(),p=policy(iso(f.now-600000)),edge={id:'edge',effectiveFrom:iso(f.at+1001),reason:'未来条目',rules:[rule()]};p.entries.push(edge);const old=f.make('1.0.0',p);f.publish(old,f.at);const changed=structuredClone(p);changed.changeIntent='PROSPECTIVE';changed.entries[1].reason='改变边界';const next=f.make('1.1.0',changed);submitTemplate(f.store,next.id,expected(next),designer,f.imports);const before=canonical(f.store),Real=Date;let tick=f.at+1000;
 globalThis.Date=class extends Real{constructor(v?:any){super(v===undefined?tick++:v);}static now(){return tick;}} as DateConstructor;
 try{assert.throws(()=>approveTemplate(f.store,next.id,{...expected(next),decision:'APPROVED',comment:'跨越边界'},reviewer,f.imports),/未来调整不能/);}finally{globalThis.Date=Real;}assert.equal(canonical(f.store),before);
});
test('quality history rejects changed manifest, duplicated approval, incorrect retirement and backward version clocks',()=>{
 const f=fixture(),t=f.make();f.publish(t);const index=publicationIndex(f.store.audits,'acme'),get=(id:string)=>index.get(id);assert.ok(qualityPolicyHistory(f.store.templates,'acme','QUALITY-A',f.at,get));
 const copied=structuredClone(f.store.templates),target=copied.find(x=>x.id===t.id)!;(target.manifest.dataQualityPolicy as any).entries[0].rules[0].threshold=10;target.contentDigest=templateContentDigest(target);assert.throws(()=>qualityPolicyHistory(copied,'acme','QUALITY-A',f.at,get));
 index.get(t.id)!.approvalCount=2;assert.throws(()=>qualityPolicyHistory(f.store.templates,'acme','QUALITY-A',f.at+1,get));index.get(t.id)!.approvalCount=1;assert.throws(()=>qualityPolicyHistory(f.store.templates,'acme','QUALITY-A',f.at,id=>({...get(id)!,approvalCount:2})));
 const next=f.make('1.1.0',policy(iso(f.now),[rule()],{changeIntent:'RETROSPECTIVE_CORRECTION'}));submitTemplate(f.store,next.id,expected(next),designer,f.imports);assert.throws(()=>clock(f.at-1,()=>approveTemplate(f.store,next.id,{...expected(next),decision:'APPROVED',comment:'时间倒退'},reviewer,f.imports)),/时间倒退/);
});
test('quality evaluation applies all comparator boundaries and does not mutate old frozen coverage inputs',()=>{
 const {input,context}=inputFixture(),before=canonical(input);for(const [operator,expected]of [['GT','PASS'],['GTE','TRIGGERED'],['LT','PASS'],['LTE','TRIGGERED']] as const){context.policy.entries[0].rules=[rule('NON_GOOD_PERCENT',{operator,threshold:0})];const result=evaluateQualityPolicy(input,context);assert.equal(result.items[0].rules[0].value,0);assert.equal(result.items[0].status,expected);}assert.equal(canonical(input),before);
});
test('duplicate timestamps and non-GOOD percentages use full record denominator and source examples are bounded',()=>{
 const {input,context}=inputFixture(),base=input.imports.find(r=>r.record.dataType==='MEASUREMENT')!;input.imports=input.imports.filter(r=>r.record.dataType!=='MEASUREMENT');for(let n=0;n<10;n++){const r=structuredClone(base);r.record.value.source_record_id='duplicate-'+n;r.record.value.quality=n<6?'BAD':'GOOD';input.imports.push(r);}
 context.policy.entries[0].rules=[rule('NON_GOOD_PERCENT',{threshold:59}),rule('DUPLICATE_TIME_COUNT',{threshold:8})];const result=evaluateQualityPolicy(input,context);assert.equal(result.items[0].recordCount,10);assert.equal(result.items[0].rules[0].value,60);assert.equal(result.items[0].rules[1].value,9);assert.equal(result.summary.triggeredRules,2);assert.equal(result.items[0].rules[0].examples.length,5);
});
test('unit mismatch is never automatically converted and range comparison with mixed units remains unknown',()=>{
 const {input,context}=inputFixture(),row=input.imports.find(r=>r.record.dataType==='MEASUREMENT')!;row.record.value.unit='other';context.policy.entries[0].rules=[rule('UNIT_MISMATCH_COUNT'),rule('OUT_OF_RANGE_COUNT')];const result=evaluateQualityPolicy(input,context);assert.equal(result.items[0].rules[0].status,'TRIGGERED');assert.equal(result.items[0].rules[1].status,'UNKNOWN');assert.ok(result.items[0].rules[1].conditions.includes('UNIT_MISMATCH_PREVENTS_RANGE'));
});
test('missing policy, suspended rules, no matching selector, missing definition and no records never pass',()=>{
 const {input,context}=inputFixture();assert.equal(evaluateQualityPolicy(input,null).status,'UNKNOWN');context.policy.entries[0].rules=null;assert.equal(evaluateQualityPolicy(input,context).status,'UNKNOWN');context.policy.entries[0].rules=[rule('NON_GOOD_PERCENT',{tagCode:'absent'})];assert.equal(evaluateQualityPolicy(input,context).unmatchedRules.length,1);assert.equal(evaluateQualityPolicy(input,context).status,'UNKNOWN');
 context.policy.entries[0].rules=[rule()];const missing=structuredClone(input);missing.imports=missing.imports.filter(r=>r.record.dataType!=='POINT_DEFINITION');assert.equal(evaluateQualityPolicy(missing,context).status,'UNKNOWN');const empty=structuredClone(input);empty.imports=empty.imports.filter(r=>r.record.dataType!=='MEASUREMENT');assert.equal(evaluateQualityPolicy(empty,context).status,'UNKNOWN');
});
test('policy boundaries split calendar coverage with half-open records and independent denominators',()=>{
 const {input,context}=inputFixture(),middle=iso((calendarTime(input.query.from)+calendarTime(input.query.to))/2);context.policy.entries.push({id:'later',effectiveFrom:middle,reason:'新规则生效',rules:[rule('RECEIVED_COVERAGE_PERCENT',{operator:'LT',threshold:80})]});const result=evaluateQualityPolicy(input,context);assert.equal(result.summary.segments,2);assert.equal(result.items.reduce((n,i)=>n+i.recordCount,0),2);assert.equal(result.items[1].policyEntry?.id,'later');
});
test('evaluation export independently recomputes and rejects changed body even when public hashes are recomputed',()=>{
 const {input,context}=inputFixture(),pack=qualityEvaluationPackage(input,context);assert.equal(verifyQualityEvaluationPackage(pack).externalAuthenticity,'NOT_PROVEN');const bad=structuredClone(pack);bad.result.status='PASS';bad.result.summary.triggeredRules=999;bad.resultDigest=digest(canonical(bad.result));assert.throws(()=>verifyQualityEvaluationPackage(bad));input.imports.length=0;assert.notEqual(pack.input.imports.length,0);
});
function calendarTime(at:string){return Date.parse(at);}
test('unmapped telemetry and unverified receipt bindings cannot produce an overall passing policy',()=>{
 const {input,context}=inputFixture();input.source='TELEMETRY';input.query.tagCode=null;input.imports=input.imports.filter(r=>r.record.dataType!=='MEASUREMENT');input.registry={revision:'1',observedAt:input.query.from,configurationHash:'b'.repeat(64),eventHash:'c'.repeat(64),sources:[{tenantId:'acme',edgeId:'edge',deviceCode:input.deviceCode,mapVersion:'map1',origin:'SIMULATOR',points:[{tagCode:'vibration_rms',nodeId:'v',unit:'mm/s'}]}]};
 const point={pointId:'point1',edgeId:'edge',deviceCode:input.deviceCode,tagCode:'vibration_rms',eventTime:iso(calendarTime(input.query.from)+1000),receivedAt:input.query.knownAt,inputDigest:'d'.repeat(64),origin:'SIMULATOR' as const,mapVersion:'map1',nodeId:'v',sequenceNo:'1',value:2,unit:'mm/s',quality:'GOOD' as const,receiptValid:true};input.telemetry=[point];assert.equal(evaluateQualityPolicy(input,context).status,'PASS');input.telemetry.push({...point,pointId:'unmapped',tagCode:'not_registered',nodeId:'u'});const unknown=evaluateQualityPolicy(input,context);assert.equal(unknown.unmappedReceivedRecords,1);assert.equal(unknown.status,'UNKNOWN');assert.ok(unknown.conditions.includes('UNMAPPED_SOURCE_RECORDS'));input.telemetry=[{...point,receiptValid:false}];assert.equal(evaluateQualityPolicy(input,context).status,'UNKNOWN');
});
test('declared stop coverage is not applicable and zero denominator never becomes a passing percentage',()=>{
 const {input,context}=inputFixture();input.calendarContext.calendars[0].calendar.periods.forEach(p=>p.state='STOP');context.policy.entries[0].rules=[rule('GOOD_VALID_COVERAGE_PERCENT',{operator:'LT',threshold:80})];const result=evaluateQualityPolicy(input,context);assert.equal(result.status,'NOT_APPLICABLE');assert.equal(result.items[0].rules[0].value,null);assert.equal(result.summary.triggeredRules,0);
});
test('fixed actual PostgreSQL upload and telemetry evaluation vectors retain complete version1 results and digests',()=>{
 const vectors=JSON.parse(readFileSync(new URL('../scripts/fixtures/governed-quality-v1-golden.json',import.meta.url),'utf8'));assert.equal(vectors.length,2);assert.deepEqual(vectors.map((v:any)=>v.input.source).sort(),['TELEMETRY','UPLOADS']);for(const pack of vectors){assert.equal(verifyQualityEvaluationPackage(pack).consistent,true);assert.equal(canonical(qualityEvaluationPackage(pack.input,pack.policy)),canonical(pack));}
});
test('rule and combined-segment limits reject a whole evaluation without truncating a success',()=>{
 const {input,context}=inputFixture(),start=calendarTime(input.query.from),end=calendarTime(input.query.to),base=input.imports.find(r=>r.record.dataType==='POINT_DEFINITION')!;input.query.tagCode=null;
 for(let n=0;n<17;n++){const d=structuredClone(base);d.record.value.source_record_id='limit-point-'+n;d.record.value.tag_code='p'+n;input.imports.push(d);}
 context.policy.entries=Array.from({length:64},(_,n)=>({id:'e'+n,effectiveFrom:iso(start+Math.floor((end-start)*n/64)),reason:'明确规则边界',rules:Array.from({length:32},(_,r)=>rule('NON_GOOD_PERCENT',{id:'r'+r}))}));assert.throws(()=>evaluateQualityPolicy(input,context),(e:any)=>e.status===422&&/4096/.test(e.message));
 const calendar=input.calendarContext.segments[0];input.calendarContext.segments=Array.from({length:129},(_,n)=>({...calendar,index:n,from:iso(start+Math.floor((end-start)*n/129)),to:iso(start+Math.floor((end-start)*(n+1)/129))}));context.policy.entries.forEach(e=>e.rules=[rule()]);assert.throws(()=>evaluateQualityPolicy(input,context),(e:any)=>e.status===422&&/129/.test(e.message));
});

