import pg from 'pg';
import {readFile,lstat,realpath,mkdir} from 'node:fs/promises';
import {resolve,join,dirname,basename,relative,isAbsolute} from 'node:path';
import {randomUUID} from 'node:crypto';
import {canonical} from '../server/imports.ts';
import {inspectStateMapCatalog} from '../server/state-map-catalog-v1.ts';
import {privateDirectory} from './backup-support.mjs';
import {coldFileHashV1} from './pg-cold-image-portable-tools-v1.mjs';
import {fieldMapFrozenProfileV2} from './field-map-frozen-profile-v2.mjs';
import {captureFieldMapFullFactsV1} from './field-map-full-facts-v1.mjs';
import {verifyFieldMapFullEvidenceV1} from './field-map-full-evidence-v1.mjs';
import {captureColdReviewSqlFactsV1,assertColdReviewSqlFactsV1} from './cold-review-sql-facts-v1.mjs';
import {coldReviewAccountV2,coldReviewNoOthersV2} from './runtime-cold-review-target-v3.mjs';
import {reviewSourceNeedV1 as need,reviewSourceHashV1 as hash} from './workflow-review-source-facts-v1.mjs';
const same=(a,b)=>canonical(a)===canonical(b),hex=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v),exact=(v,keys)=>v&&Object.getPrototypeOf(v)===Object.prototype&&Object.keys(v).sort().join(',')===[...keys].sort().join(',');
const outside=(p,d)=>{const r=relative(resolve(d),resolve(p));return r!==''&&(r==='..'||r.startsWith('../')||r.startsWith('..\\')||isAbsolute(r));};
export function coldSourceMapProfileV1(frame,gate,binding,targetDirectory){
 const structure=frame.structures.find(s=>s.database===gate.database),closed=frame.closedReceipt.databases.find(s=>s.database===gate.database);need(structure&&closed,'COLD_SOURCE_MAP_FRAME');
 return fieldMapFrozenProfileV2({format:'FIELD_MAP_FROZEN_PROFILE_V1',tenantId:binding.tenantId,targetDirectory,inventory:frame.inventory,structureSha256:structure.sha256,binding,fenceBinding:gate,closed:{operationId:closed.operationId,revision:String(closed.revision)}});
}
export function assertColdSourceMapFactsV1(actual,original){
 for(const v of [actual,original]){const {factsSha256,...body}=v??{};need(v?.format==='FIELD_MAP_FULL_FACTS_V1'&&hash(body)===factsSha256&&v.entireCurrentRootVerified===true&&v.allSqlReceiptsVerified===true&&v.fullDomainPayloadReconstructed===true&&v.currentOidcApprovalVerified===false&&v.formalFieldActivationGranted===false,'COLD_SOURCE_MAP_FACTS');}
 const semantic=v=>{const {profileSha256,evidencePrefixSha256,factsSha256,...body}=v;return body;};need(same(semantic(actual),semantic(original)),'COLD_SOURCE_MAP_CHANGED');return true;
}
export function validateColdSourceFullFactsV1(frame,set,controlDirectory){
 const {sha256,...body}=set??{};need(exact(set,['format','databases','sha256'])&&set.format==='COLD_SOURCE_FULL_FACTS_SET_V1'&&hex(sha256)&&hash(body)===sha256&&Array.isArray(set.databases)&&set.databases.length===frame.inventory.databases.length,'COLD_SOURCE_FULL_SET');
 const ids=new Set(),tenants=new Set(),sourceDirectory=resolve(frame.inventory.identity.directory),evidenceDirectory=join(resolve(controlDirectory),'source-full-maps');let mapCount=0;
 for(let i=0;i<set.databases.length;i++){const d=set.databases[i],original=frame.inventory.databases[i];need(exact(d,['database','databaseOid','sqlFacts','map'])&&d.database===original.datname&&d.databaseOid===original.oid&&!ids.has(d.databaseOid),'COLD_SOURCE_FULL_COVERAGE');ids.add(d.databaseOid);const sf=d.sqlFacts;assertColdReviewSqlFactsV1(sf,sf);need(same(sf.identity,{systemIdentifier:frame.inventory.identity.system_id,database:d.database,databaseOid:d.databaseOid,controlOid:frame.inventory.identity.control_oid}),'COLD_SOURCE_FULL_SQL_BINDING');
  if(d.map===null)continue;const m=d.map;need(exact(m,['format','tenantId','profile','facts','evidenceFile','evidenceSha256'])&&m.format==='COLD_SOURCE_FULL_MAP_V1'&&typeof m.tenantId==='string'&&/^[a-z][a-z0-9_-]{0,63}$/.test(m.tenantId)&&!tenants.has(m.tenantId)&&hex(m.evidenceSha256),'COLD_SOURCE_MAP_DESCRIPTOR');tenants.add(m.tenantId);mapCount++;
  const gate=frame.active.find(g=>g.databaseOid===d.databaseOid);need(gate,'COLD_SOURCE_MAP_UNREGISTERED');const profile=fieldMapFrozenProfileV2(m.profile),expected=coldSourceMapProfileV1(frame,gate,profile.binding,sourceDirectory);need(profile.binding.databaseOid===d.databaseOid&&profile.tenantId===m.tenantId&&same(profile,expected),'COLD_SOURCE_MAP_PROFILE');assertColdSourceMapFactsV1(m.facts,m.facts);need(m.facts.tenantId===m.tenantId&&m.facts.profileSha256===hash(profile),'COLD_SOURCE_MAP_FACTS_BINDING');
  need(typeof m.evidenceFile==='string'&&isAbsolute(m.evidenceFile)&&dirname(m.evidenceFile)===evidenceDirectory&&new RegExp('^source-map-'+m.tenantId+'-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\\.jsonl$').test(basename(m.evidenceFile))&&outside(m.evidenceFile,frame.inventory.identity.directory),'COLD_SOURCE_MAP_EVIDENCE_PATH');
 }need(mapCount>0&&mapCount<=32,'COLD_SOURCE_MAP_COVERAGE');return structuredClone(set);
}
export async function verifyColdSourceFullEvidenceV1(frame,set,controlDirectory,workDirectory){
 validateColdSourceFullFactsV1(frame,set,controlDirectory);const results=[],directory=join(resolve(controlDirectory),'source-full-maps'),dir=await lstat(directory);need(dir.isDirectory()&&!dir.isSymbolicLink()&&await realpath(directory)===directory,'COLD_SOURCE_MAP_EVIDENCE_DIRECTORY');
 for(const d of set.databases){const m=d.map;if(!m)continue;const stat=await lstat(m.evidenceFile);need(stat.isFile()&&!stat.isSymbolicLink()&&stat.nlink===1&&stat.size<=2*1024**3,'COLD_SOURCE_MAP_EVIDENCE_FILE');need((await coldFileHashV1(m.evidenceFile,2*1024**3)).sha256===m.evidenceSha256,'COLD_SOURCE_MAP_EVIDENCE_CHANGED');const v=await verifyFieldMapFullEvidenceV1({file:m.evidenceFile,expectedFacts:m.facts,workDirectory});need((await coldFileHashV1(m.evidenceFile,2*1024**3)).sha256===m.evidenceSha256,'COLD_SOURCE_MAP_EVIDENCE_CHANGED');results.push(v);}return results;
}
export async function captureColdSourceFullFactsV1(account,frame,controlDirectory){
 const a=coldReviewAccountV2(account),directory=join(resolve(controlDirectory),'source-full-maps');need(outside(directory,frame.inventory.identity.directory),'COLD_SOURCE_MAP_EVIDENCE_PATH');await mkdir(directory,{recursive:false,mode:0o700});await privateDirectory(directory);need(await realpath(directory)===directory,'COLD_SOURCE_MAP_EVIDENCE_DIRECTORY');
 const databases=[],retired=[];let c;async function end(){if(!c)return;const original=c;c=null;const socket=original.connection?.stream,terminal=!socket||socket.closed?Promise.resolve():new Promise(ok=>socket.once('close',ok));try{if(['T','E'].includes(original.getTransactionStatus?.()))await original.query('ROLLBACK');}finally{await original.end();await terminal;}}
 try{for(const d of frame.inventory.databases){c=new pg.Client({...a,database:d.datname,connectionTimeoutMillis:5000});c.on('error',()=>{});await c.connect();for(const old of retired){let present=true;for(let n=0;n<20&&present;n++){present=(await c.query('SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE pid=$1 AND extract(epoch FROM backend_start)::text=$2) AS value',[old.pid,old.started])).rows[0].value;if(present)await new Promise(ok=>setTimeout(ok,100));}need(!present,'COLD_SOURCE_PRIOR_SQL_NOT_TERMINAL');}retired.length=0;await coldReviewNoOthersV2(c);
   const backend=(await c.query("SELECT pg_backend_pid() AS pid,extract(epoch FROM backend_start)::text AS started FROM pg_stat_activity WHERE pid=pg_backend_pid()")).rows[0];await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
   const sqlFacts=await captureColdReviewSqlFactsV1(c,{systemIdentifier:frame.inventory.identity.system_id,database:d.datname,databaseOid:d.oid,controlOid:frame.inventory.identity.control_oid}),present=(await c.query("SELECT to_regnamespace('state_map_v1') IS NOT NULL AS value")).rows[0].value;let map=null;
   if(present){const gate=frame.active.find(g=>g.databaseOid===d.oid);need(gate,'COLD_SOURCE_MAP_UNREGISTERED');const meta=(await c.query('SELECT tenant,owner_oid::text,app_oid::text,reader_oid::text FROM state_map_v1._meta')).rows;need(meta.length===1&&meta[0].owner_oid===gate.ownerOid&&gate.actorOids.includes(meta[0].app_oid)&&gate.actorOids.includes(meta[0].reader_oid),'COLD_SOURCE_MAP_META');const binding={tenantId:meta[0].tenant,databaseOid:d.oid,roleOid:meta[0].app_oid,catalogHash:await inspectStateMapCatalog(c)},profile=coldSourceMapProfileV1(frame,gate,binding,resolve(frame.inventory.identity.directory)),heads=(await c.query("SELECT revision::text,encode(root_id,'hex') AS \"rootId\",encode(root_hash,'hex') AS \"rootHash\",item_count::text AS count,encode(receipt_hash,'hex') AS \"receiptHash\" FROM state_map_v1.head")).rows;need(heads.length===1,'COLD_SOURCE_MAP_HEAD');
    const evidenceFile=join(directory,'source-map-'+binding.tenantId+'-'+randomUUID()+'.jsonl'),captured=await captureFieldMapFullFactsV1(c,profile,heads[0],evidenceFile);map={format:'COLD_SOURCE_FULL_MAP_V1',tenantId:binding.tenantId,profile,facts:captured.facts,evidenceFile,evidenceSha256:(await coldFileHashV1(evidenceFile,2*1024**3)).sha256};
   }await c.query('ROLLBACK');await coldReviewNoOthersV2(c);databases.push({database:d.datname,databaseOid:d.oid,sqlFacts,map});await end();retired.push(backend);
  }}finally{await end();}
 const body={format:'COLD_SOURCE_FULL_FACTS_SET_V1',databases},result={...body,sha256:hash(body)};validateColdSourceFullFactsV1(frame,result,controlDirectory);await verifyColdSourceFullEvidenceV1(frame,result,controlDirectory,directory);return result;
}
/** Called only within the target's original catalog-check transaction. No business writes. */
export async function captureColdTargetMapFactsV1(c,frame,baseline,targetDirectory,workDirectory){
 const original=baseline.map;need(original,'COLD_SOURCE_MAP_COVERAGE');const profile=coldSourceMapProfileV1(frame,original.profile.fenceBinding,original.profile.binding,targetDirectory),file=join(workDirectory,'target-map-'+original.tenantId+'-'+randomUUID()+'.jsonl');
 const captured=await captureFieldMapFullFactsV1(c,profile,original.facts.head,file);assertColdSourceMapFactsV1(captured.facts,original.facts);const independent=await verifyFieldMapFullEvidenceV1({file,expectedFacts:captured.facts,workDirectory});return{tenantId:original.tenantId,facts:captured.facts,evidenceFile:file,evidenceSha256:(await coldFileHashV1(file,2*1024**3)).sha256,independent};
}
