import {createReadStream} from 'node:fs';
import {lstat,realpath} from 'node:fs/promises';
import {createInterface} from 'node:readline';
import {isAbsolute,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {canonical} from '../server/imports.ts';
import {stateKey,validateStateNode,stateValueHash,parseStateValueText} from '../server/state-map-v1.ts';
import {readRuntimeColdReviewV3} from './runtime-cold-readonly-control-v5.mjs';
import {reviewSourceHashV1 as hash} from './workflow-review-source-facts-v1.mjs';
const need=(v,c)=>{if(!v)throw Object.assign(Error(c),{code:c});},hex=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v),same=(a,b)=>canonical(a)===canonical(b);

/** Reads the one key-ring marker from complete original source evidence.
 * Authenticates every evidence byte; the caller still owns full-tree/current-target verification. */
export async function readColdRegistrationSourceJobKeyV1(raw){
 let stream,lines,problem;
 try{
  need(raw&&Object.keys(raw).sort().join(',')==='tenantId,trust'&&typeof raw.tenantId==='string'&&/^[a-z][a-z0-9_-]{0,63}$/.test(raw.tenantId),'COLD_REGISTRATION_JOB_KEY_SOURCE_REQUEST');
  const state=await readRuntimeColdReviewV3(raw.trust),source=state.source,map=source.fullFacts.databases.find(d=>d.map?.tenantId===raw.tenantId)?.map;need(map&&hash(source)===raw.trust.sourceHash,'COLD_REGISTRATION_JOB_KEY_SOURCE_BINDING');
  const file=map.evidenceFile;need(typeof file==='string'&&isAbsolute(file)&&resolve(file)===file&&await realpath(file)===file&&hex(map.evidenceSha256),'COLD_REGISTRATION_JOB_KEY_SOURCE_PATH');const before=await lstat(file,{bigint:true});need(before.isFile()&&!before.isSymbolicLink()&&before.nlink===1n&&before.size<=2n*1024n**3n,'COLD_REGISTRATION_JOB_KEY_SOURCE_FILE');
  const key=stateKey(raw.tenantId,'domain_head','reconciliation_ui'),digest=createHash('sha256'),prefix=createHash('sha256');let bytes=0,header=null,complete=null,marker=null,count=0;
  stream=createReadStream(file);stream.on('data',b=>{bytes+=b.length;digest.update(b);});lines=createInterface({input:stream,crlfDelay:Infinity});
  for await(const line of lines){need(bytes<=2*1024**3&&Buffer.byteLength(line)<=64*1024**2&&!complete,'COLD_REGISTRATION_JOB_KEY_SOURCE_LIMIT');const v=JSON.parse(line);need(canonical(v)===line,'COLD_REGISTRATION_JOB_KEY_SOURCE_CANONICAL');if(v.type==='COMPLETE'){need(header&&same(v.facts,map.facts)&&prefix.digest('hex')===map.facts.evidencePrefixSha256,'COLD_REGISTRATION_JOB_KEY_SOURCE_TRAILER');complete=v;continue;}prefix.update(line+'\n');if(!header){need(v.type==='HEADER'&&v.format==='FIELD_MAP_FULL_FACTS_EVIDENCE_V1'&&v.tenantId===raw.tenantId&&v.profileSha256===map.facts.profileSha256&&same(v.head,map.facts.head),'COLD_REGISTRATION_JOB_KEY_SOURCE_HEADER');header=v;continue;}if(v.type==='NODE'&&v.node?.kind===0&&v.node.prefix===key){const node=validateStateNode(v.node);need(++count===1&&typeof v.valueText==='string'&&stateValueHash(v.valueText)===node.valueHash,'COLD_REGISTRATION_JOB_KEY_SOURCE_LEAF');marker=parseStateValueText(v.valueText);}}
  need(complete&&bytes===Number(before.size)&&digest.digest('hex')===map.evidenceSha256&&count===1&&marker?.format==='IDMS_RECONCILIATION_UI_V1'&&marker.tenantId===raw.tenantId&&['queueDeployment','queueCatalogHash','stateCatalogHash','jobKeyWitness'].every(k=>hex(marker[k]))&&marker.stateCatalogHash===map.profile.binding.catalogHash,'COLD_REGISTRATION_JOB_KEY_SOURCE_MARKER');
  const after=await lstat(file,{bigint:true});need(['dev','ino','nlink','size','mtimeNs','ctimeNs'].every(k=>after[k]===before[k])&&after.isFile()&&!after.isSymbolicLink(),'COLD_REGISTRATION_JOB_KEY_SOURCE_CHANGED');const current=await readRuntimeColdReviewV3(raw.trust);need(hash(current.source)===raw.trust.sourceHash&&hash(current.details.review)===hash(state.details.review),'COLD_REGISTRATION_JOB_KEY_SOURCE_CHANGED');
  return{format:'COLD_REGISTRATION_SOURCE_JOB_KEY_V1',tenantId:raw.tenantId,databaseOid:map.profile.binding.databaseOid,sourceFullFactsSha256:source.fullFacts.sha256,sourceMapFactsSha256:map.facts.factsSha256,sourceEvidenceSha256:map.evidenceSha256,sourceMarkerSha256:hash(marker),marker:structuredClone(marker),allSourceEvidenceBytesAuthenticated:true,selectedLeafValueHashVerified:true,entireSourceRootRebuiltHere:false,currentTargetMapVerified:false,currentAuthorizationVerified:false,formalFieldActivationGranted:false,fullGoalComplete:false};
 }catch(e){problem=e;throw Object.assign(Error('COLD_REGISTRATION_JOB_KEY_SOURCE_UNVERIFIABLE'),{code:'COLD_REGISTRATION_JOB_KEY_SOURCE_UNVERIFIABLE'});}finally{try{const closed=!stream||stream.closed?Promise.resolve():new Promise(ok=>stream.once('close',ok));lines?.close();stream?.destroy();await closed;}catch(e){if(problem)problem.sourceKeyReadCleanupUnproven=true;else throw Object.assign(Error('COLD_REGISTRATION_JOB_KEY_SOURCE_CLEANUP_UNPROVEN'),{code:'COLD_REGISTRATION_JOB_KEY_SOURCE_CLEANUP_UNPROVEN'});}}
}
