import assert from 'node:assert/strict';
import {readFile,readdir,lstat} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {canonical} from '../server/imports.ts';
import {stateNodeId} from '../server/state-map-v1.ts';
import {verifyFieldMapFullEvidenceV1} from '../scripts/field-map-full-evidence-v1.mjs';
import {launchFieldMapFullEvidenceWorkerV3,awaitFieldMapFullEvidenceWorkerV3} from '../scripts/field-map-full-evidence-worker-owner-v3.mjs';
import {privateDirectory,privateNewFile} from '../scripts/backup-support.mjs';
const hash=b=>createHash('sha256').update(typeof b==='string'?b:canonical(b)).digest('hex'),zero='0'.repeat(64);
export const corruptionsV1=[
 {name:'noncanonical header',code:'FIELD_FULL_EVIDENCE_CANONICAL',edit:s=>{s.lines[0]=' '+s.lines[0];s.preserveText=true;}},
 {name:'wrong header tenant',code:'FIELD_FULL_EVIDENCE_HEADER',edit:s=>{s.rows[0].tenantId='wrong';}},
 {name:'value text changed',code:'FIELD_FULL_EVIDENCE_VALUE_CHANGED',edit:s=>{s.rows.find(r=>r.type==='NODE'&&r.node.kind===0).valueText+=' ';}},
 {name:'valid node id with wrong branch hash',code:'FIELD_FULL_EVIDENCE_BRANCH',edit:s=>{const n=s.rows.find(r=>r.type==='NODE'&&r.node.kind===1).node;n.hash=zero;n.id=stateNodeId(n);}},
 {name:'missing leaf node',code:'FIELD_FULL_EVIDENCE_BRANCH',edit:s=>{s.rows.splice(s.rows.findIndex(r=>r.type==='NODE'&&r.node.kind===0),1);}},
 {name:'duplicate leaf node',code:'UNIQUE constraint failed: leaf_values.key_hash',edit:s=>{const i=s.rows.findIndex(r=>r.type==='NODE'&&r.node.kind===0);s.rows.splice(i,0,structuredClone(s.rows[i]));}},
 {name:'wrong receipt hash',code:'FIELD_FULL_EVIDENCE_RECEIPT_CHAIN',edit:s=>{s.rows.find(r=>r.type==='RECEIPT').value.receiptHash=zero;}},
 {name:'wrong root despite rebound facts',code:'FIELD_FULL_EVIDENCE_ROOT',edit:s=>{s.facts.head.rootHash=zero;s.rows[0].head.rootHash=zero;}},
 {name:'wrong relation despite intact node root',code:'FIELD_FULL_EVIDENCE_FACTS_CHANGED',edit:s=>{s.rows.find(r=>r.type==='RELATION').fact.rows++;}},
 {name:'wrong complete domain digest',code:'FIELD_FULL_EVIDENCE_DOMAIN_CHANGED',edit:s=>{s.facts.payloadSha256=zero;}},
 {name:'wrong complete audit digest',code:'FIELD_FULL_EVIDENCE_DOMAIN_CHANGED',edit:s=>{s.facts.auditSha256=zero;}},
 {name:'wrong EOF prefix digest',code:'FIELD_FULL_EVIDENCE_TRAILER',edit:s=>{s.facts.evidencePrefixSha256=zero;s.preservePrefix=true;}},
 {name:'missing COMPLETE record',code:'FIELD_FULL_EVIDENCE_COVERAGE',edit:s=>{s.missingComplete=true;}},
 {name:'record after COMPLETE',code:'FIELD_FULL_EVIDENCE_LIMIT',edit:s=>{s.extraRecord=true;}}
];
async function noCaches(dir){for(const name of await readdir(dir)){const file=join(dir,name),s=await lstat(file);if(s.isDirectory())await noCaches(file);else assert(!/^field-full-verify-.*\.sqlite(?:-journal|-wal|-shm)?$/.test(name),'VERIFIER_CACHE_NOT_RETIRED');}}
export async function runFastEvidenceCorruptionCaseV1({map,workDirectory,caseIndex}){
 const definition=corruptionsV1[caseIndex],directory=join(workDirectory,'bad-'+caseIndex);await privateDirectory(directory);const text=await readFile(map.evidenceFile,'utf8'),lines=text.trimEnd().split('\n'),rows=lines.map(line=>JSON.parse(line)),state={lines,rows,facts:structuredClone(map.facts)};definition.edit(state);
 let prefix=(state.preserveText?state.lines.slice(0,-1):state.rows.slice(0,-1).map(r=>canonical(r))).join('\n')+'\n';if(!state.preservePrefix)state.facts.evidencePrefixSha256=hash(prefix);const{factsSha256,...body}=state.facts;state.facts.factsSha256=hash(body);let altered=prefix;if(!state.missingComplete)altered+=canonical({type:'COMPLETE',facts:state.facts})+'\n';if(state.extraRecord)altered+=canonical({type:'RELATION',fact:state.facts.relations[0]})+'\n';
 const file=join(directory,'corrupt.jsonl');await privateNewFile(file,altered);const originalDir=join(directory,'slow'),workerDir=join(directory,'worker');await privateDirectory(originalDir);
 let slowError;try{await verifyFieldMapFullEvidenceV1({file,expectedFacts:state.facts,workDirectory:originalDir});}catch(e){slowError=e;}assert(slowError,'ORIGINAL_SLOW_MUST_REJECT');assert.equal(slowError.message,definition.code);const handle=await launchFieldMapFullEvidenceWorkerV3({file,expectedFacts:state.facts,workDirectory:workerDir});await assert.rejects(awaitFieldMapFullEvidenceWorkerV3(handle),/FIELD_EVIDENCE_WORKER_REJECTED/);
 const names=(await readdir(workerDir)).filter(n=>/^original-evidence-worker-[a-f0-9]{64}\.terminal\.private\.json$/.test(n));assert.equal(names.length,1);const raw=JSON.parse(await readFile(join(workerDir,names[0]),'utf8')),terminal=raw.terminal;assert(terminal.code===1&&terminal.signal===null&&terminal.stdoutClosed&&terminal.stderrClosed&&terminal.originalChildHandleHeld&&!terminal.spawnFailed&&!terminal.truncated);assert.equal(raw.stdout,'');const expectedOutput=/^[A-Z][A-Z0-9_]{1,100}$/.test(definition.code)?definition.code:'FIELD_MAP_ORIGINAL_EVIDENCE_WORKER_REJECTED';assert.equal(raw.stderr.trim(),expectedOutput);await noCaches(directory);assert.equal(hash(await readFile(file,'utf8')),hash(altered));
 return{name:definition.name,originalSlowError:slowError.message,candidateWorkerError:raw.stderr.trim(),terminal,completeCorruptedFileSha256:hash(altered),allPrivateVerifierCachesRetired:true,rawTerminalFile:join(workerDir,names[0])};
}
