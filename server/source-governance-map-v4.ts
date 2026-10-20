import {canonicalDigest,canonicalEqual} from './canonical-state.ts';
import {validateTenantPayload,type TenantPayload} from './entity-repository.ts';
import {sourceGovernanceDecision,publicGovernedSource,sourceGovernanceVersion,type PublicGovernedSource,type SourceGovernanceDecision} from './source-governance.ts';
import {sourcePolicySchema} from './source-policy-schema.ts';
import {encodeLegacyText,decodeLegacyText,legacyJsonText,type LegacyEntry,type LegacyLookup} from './legacy-map-v4.ts';
import {stateValueText} from './state-map-v1.ts';
import type {Store} from './store.ts';
const format='IDMS_SOURCE_GOVERNANCE_MAP_V4_1',minimumTime=-8640000000000000,maximumTime=8640000000000000;
function need(value:unknown):asserts value{if(!value)throw Error('SOURCE_GOVERNANCE_MAP_INTEGRITY');}
const isHash=(h:unknown):h is string=>typeof h==='string'&&/^[a-f0-9]{64}$/.test(h);
export const governanceSourceId=(source:PublicGovernedSource)=>canonicalDigest(publicGovernedSource(source));
type Node={format:typeof format;sourceId:string;kind:'BRANCH';split:number;left:string;right:string}|{format:typeof format;sourceId:string;kind:'LEAF';from:number;until:number|null;fallback:string;tags:[string,string][]};
export interface GovernanceMapHead {format:typeof format;tenantId:string;ruleVersion:typeof sourceGovernanceVersion;sourceId:string;source:PublicGovernedSource;compiledPayloadDigest:string;root:string;intervals:number}
export interface GovernanceCompilation {entries:LegacyEntry[];heads:GovernanceMapHead[];boundaryChecks:number;decisionDocuments:number}
/** Maintenance/activation compiler. Never called by the per-event receive path. */
export function compileGovernanceMap(payload:TenantPayload,tenantId:string,sources:readonly PublicGovernedSource[]):GovernanceCompilation{
 validateTenantPayload(payload,tenantId);const store={...payload.business,audits:payload.audits,idempotency:new Map(payload.idempotency)} as Store,all=new Map<string,PublicGovernedSource>(),entries=new Map<string,LegacyEntry>(),heads:GovernanceMapHead[]=[];let boundaryChecks=0;const decisions=new Set<string>();
 const addSource=(s:PublicGovernedSource)=>{const source=publicGovernedSource(s);need(source.tenantId===tenantId);all.set(governanceSourceId(source),source);};
 for(const s of sources)addSource(s);
 for(const a of payload.audits){const frozen=a.metadata?.sourceGovernance as {configuredSource?:PublicGovernedSource}|undefined;if(frozen?.configuredSource)addSource(frozen.configuredSource);}
 const add=(e:LegacyEntry)=>{const k=e.namespace+'\0'+e.key,prior=entries.get(k);need(!prior||prior.valueText===e.valueText);entries.set(k,e);};
 const decisionDocument=(sourceId:string,decision:SourceGovernanceDecision)=>{const body={format,sourceId,decision:JSON.parse(JSON.stringify(decision))},id=canonicalDigest(body);for(const e of encodeLegacyText('blob','v4gov_decision:'+id,legacyJsonText(body)))add(e);decisions.add(id);return id;};
 const saveNode=(node:Node)=>{const id=canonicalDigest(node);add({namespace:'blob',key:'v4gov_node:'+id,valueText:stateValueText(node)});return id;};
 for(const [sourceId,source]of all){
  const policyTemplates=payload.business.templates.filter(t=>t.manifest.purpose==='telemetry-source-policy'&&(t.manifest.telemetrySourcePolicy as {edgeId?:unknown})?.edgeId===source.edgeId&&['PUBLISHED','RETIRED'].includes(t.status)),ids=new Set(policyTemplates.map(t=>t.id)),batchIds=new Set(payload.imports.batches.filter(b=>['DEVICE','POINT_DEFINITION'].includes(b.dataType)).map(b=>b.batchId)),times=new Set<number>([minimumTime]);
  for(const t of policyTemplates)for(const e of sourcePolicySchema(t.manifest.telemetrySourcePolicy).entries)times.add(Date.parse(e.effectiveFrom));
  for(const a of payload.audits)if(a.objectType==='TEMPLATE'&&ids.has(a.objectId)&&a.action==='TEMPLATE_APPROVED'||a.objectType==='DATA_IMPORT'&&batchIds.has(a.objectId)&&a.action==='IMPORT_COMMITTED')times.add(Date.parse(a.businessTime));
  need(times.size<=100000&&[...times].every(t=>Number.isSafeInteger(t)&&t>=minimumTime&&t<=maximumTime));
  const boundaries=[...times].sort((a,b)=>a-b),intervals:{from:number;fallback:string;tags:[string,string][]}[]=[];
  for(const from of boundaries){
   const fallback=decisionDocument(sourceId,sourceGovernanceDecision(store,payload.imports,source,from,null)),tags=source.points.map(p=>[p.tagCode,decisionDocument(sourceId,sourceGovernanceDecision(store,payload.imports,source,from,p.tagCode))] as [string,string]);boundaryChecks+=tags.length+1;
   const prior=intervals.at(-1);if(!prior||prior.fallback!==fallback||!canonicalEqual(prior.tags,tags))intervals.push({from,fallback,tags});
  }
  const build=(lo:number,hi:number):string=>{if(hi-lo===1){const row=intervals[lo];return saveNode({format,sourceId,kind:'LEAF',...row,until:intervals[hi]?.from??null});}const mid=(lo+hi)>>1;return saveNode({format,sourceId,kind:'BRANCH',split:intervals[mid].from,left:build(lo,mid),right:build(mid,hi)});};
  const head:GovernanceMapHead={format,tenantId,ruleVersion:sourceGovernanceVersion,sourceId,source,compiledPayloadDigest:canonicalDigest(payload),root:build(0,intervals.length),intervals:intervals.length};heads.push(head);add({namespace:'gov_head',key:sourceId,valueText:stateValueText(head)});
 }return {entries:[...entries.values()],heads,boundaryChecks,decisionDocuments:decisions.size};
}
/** Every get must be a verified membership lookup at ONE caller-trusted root. */
export async function readGovernanceMap(source:PublicGovernedSource,at:number,tag:string|null,get:LegacyLookup){
 const sourceId=governanceSourceId(source),head=await get('gov_head',sourceId) as GovernanceMapHead;
 need(head&&head.format===format&&head.ruleVersion===sourceGovernanceVersion&&head.tenantId===source.tenantId&&head.sourceId===sourceId&&canonicalEqual(head.source,publicGovernedSource(source))&&isHash(head.compiledPayloadDigest)&&isHash(head.root)&&Number.isSafeInteger(head.intervals)&&head.intervals>0&&Number.isSafeInteger(at)&&at>=minimumTime&&at<=maximumTime);
 let id=head.root,steps=0,lower=minimumTime,upper:number|null=null;
 for(;;){need(++steps<=64);const node=await get('blob','v4gov_node:'+id) as Node;need(node&&node.format===format&&node.sourceId===sourceId&&canonicalDigest(node)===id);
  if(node.kind==='BRANCH'){
   need(Object.keys(node).length===6&&Number.isSafeInteger(node.split)&&node.split>lower&&(upper===null||node.split<upper)&&isHash(node.left)&&isHash(node.right));if(at<node.split){id=node.left;upper=node.split;}else{id=node.right;lower=node.split;}continue;
  }
  need(node.kind==='LEAF'&&Object.keys(node).length===7&&node.from===lower&&node.until===upper&&at>=node.from&&(node.until===null||at<node.until)&&isHash(node.fallback)&&Array.isArray(node.tags)&&node.tags.length<=128);
  need(node.tags.every(t=>Array.isArray(t)&&t.length===2&&typeof t[0]==='string'&&isHash(t[1]))&&new Set(node.tags.map(t=>t[0])).size===node.tags.length);const decisionId=node.tags.find(t=>t[0]===tag)?.[1]||node.fallback;
  const body=JSON.parse(await decodeLegacyText('blob','v4gov_decision:'+decisionId,get));need(body?.format===format&&body.sourceId===sourceId&&Object.keys(body).length===3&&canonicalDigest(body)===decisionId);
  const decision=body.decision as SourceGovernanceDecision;need(decision&&typeof decision.enforced==='boolean'&&typeof decision.allowed==='boolean'&&(!decision.binding||governanceSourceId(decision.binding.configuredSource)===sourceId));return {decision,nodeReads:steps,head};
 }
}
