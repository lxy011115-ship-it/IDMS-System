// Fresh owned PG cluster and synthetic history only; never opens enterprise PGDATA.
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createOwnedPlatformPgQaV1} from './fixtures/owned-platform-pg-v1-qa.mjs';
import {seedStore} from '../server/store.ts';
import {appendAudit,verifyAuditChain} from '../server/audit.ts';
import {emptyImports} from '../server/imports.ts';
import {tenantPayload,readEntities,writeEntities} from '../server/entity-repository.ts';
import {entitySchema} from '../server/entity-schema.ts';
import {businessSchema} from '../server/postgres-schema.ts';
import {projectionSchema} from '../server/data-projection.ts';
import {tenantWorkspace,workspacePayload} from '../server/tenant-workspace.ts';
import {canonicalDigest} from '../server/canonical-state.ts';
import {verifyPostImage} from '../server/write-postimage.ts';
import {memoryTask,resident,limits} from '../server/capacity.ts';

const bin=process.env.IDMS_QA_PG_BIN||join(process.env.LOCALAPPDATA||'','IDMS/runtime/pgsql/bin');
const cluster=await createOwnedPlatformPgQaV1(bin),report={format:1,passed:false,syntheticOnly:true,enterpriseDml:0,taskBytes:limits.taskBytes,cases:[],cluster:cluster.nonce};let c;
const path=join(cluster.work,'telemetry-memory-verification.json');
function event(holder,n){return appendAudit(holder,{tenantId:'sandbox',objectType:'TELEMETRY_EVENT',objectId:randomUUID(),action:n>=75171?'TELEMETRY_REJECTED':'TELEMETRY_STORED',actorType:'INTERFACE',actorId:'qa-synthetic-edge',correlationId:randomUUID(),metadata:{inputDigest:canonicalDigest({synthetic:n}),origin:'SIMULATOR',deviceCode:'SIM-CNC-01',mapVersion:'cnc-simulator-1',pointId:n>=75171?null:randomUUID(),...(n>=75171?{reason:'SEQUENCE_CONFLICT'}:{})}});}
async function seed(total){
 const store=seedStore(),{audits,idempotency,...business}=store;
 const payload=tenantPayload({version:2,business,audits,idempotency:[...idempotency],imports:emptyImports()},'sandbox');
 while(payload.audits.length<total)payload.audits.push(event({audits:payload.audits.length?[payload.audits.at(-1)]:[]},payload.audits.length));
 assert(verifyAuditChain(payload.audits,'sandbox'));
 await c.query('BEGIN');
 try{
  const empty={business:Object.fromEntries(Object.keys(payload.business).map(k=>[k,[]])),imports:{batches:[],records:[],requests:[]},audits:payload.audits,idempotency:[]};
  // Seed audit history in bounded batches; production append-only trigger stays on.
  for(let offset=0;offset<payload.audits.length;offset+=500)await c.query('INSERT INTO audit_ledger(event_id,tenant_id,hash,previous_hash,event) SELECT (e->>\'eventId\')::uuid,e->>\'tenantId\',e->>\'hash\',e->>\'previousHash\',e FROM jsonb_array_elements($1::jsonb) e',[JSON.stringify(payload.audits.slice(offset,offset+500))]);
  await writeEntities(c,empty,payload,'sandbox');await c.query('INSERT INTO business_state(tenant_id,revision,schema_version,payload_digest) VALUES($1,1,3,$2)',['sandbox',canonicalDigest(payload)]);await c.query('COMMIT');
 }catch(e){await c.query('ROLLBACK');throw e;}
}
async function transaction(total,rollback=false){
 const stages=[],base=resident.snapshot().total;
 await memoryTask(async()=>{
  await c.query('BEGIN');
  try{
   const before=await readEntities(c,'sandbox');assert.equal(before.payload.audits.length,total);stages.push({stage:'reader',bytes:resident.snapshot().total});
   const workspace=tenantWorkspace(before.payload);stages.push({stage:'workspace',bytes:resident.snapshot().total});
   event(workspace.store,total);const after=workspacePayload(workspace,'sandbox');stages.push({stage:'after',bytes:resident.snapshot().total});
   await writeEntities(c,before.payload,after,'sandbox');
   await verifyPostImage(c,'sandbox',after,before.revision,canonicalDigest(before.payload));stages.push({stage:'postImageComplete',bytes:resident.snapshot().total});
   await c.query('UPDATE business_state SET revision=revision+1,payload_digest=$1 WHERE tenant_id=$2',[canonicalDigest(after),'sandbox']);
   await c.query(rollback?'ROLLBACK':'COMMIT');
  }catch(e){await c.query('ROLLBACK');throw e;}
 },true);
 assert.equal(resident.snapshot().total,base);
 const audit=await c.query('SELECT count(*)::int AS n FROM audit_ledger');assert.equal(audit.rows[0].n,total+(rollback?0:1));
 report.cases.push({history:total,rollback,stages,accountingReturnedToBaseline:true,rss:process.memoryUsage().rss});
 console.log(JSON.stringify({history:total,rollback,status:'PASS',stages}));
}
try{
 assert.equal(limits.taskBytes,512*1024**2);c=await cluster.client();
 await c.query(businessSchema);await c.query(projectionSchema);await c.query(entitySchema);
 await seed(75171);await transaction(75171,true);await transaction(75171);
 // A fresh database in the same owned cluster avoids mutating prior audit rows.
 await c.end();c=await cluster.client();await c.query('CREATE DATABASE idms_recoveryqa_larger');await c.end();c=await cluster.client('idms_recoveryqa_larger');
 await c.query(businessSchema);await c.query(projectionSchema);await c.query(entitySchema);
 await seed(85171);await transaction(85171,true);await transaction(85171);
 const after=await memoryTask(()=>readEntities(c,'sandbox'),true);assert.equal(after.payload.audits.length,85172);assert.equal(canonicalDigest(after.payload),(await c.query('SELECT payload_digest FROM business_state')).rows[0].payload_digest);
 report.fullDigestAndAuditChainVerified=true;report.watermarks=resident.watermarks();report.finalAccountedBytes=resident.snapshot().total;report.passed=true;
}catch(error){report.failure={code:error.code||null,message:String(error.message),stack:String(error.stack)};process.exitCode=1;}
finally{await c?.end();await cluster.stop();report.ownedPostgresNormalStop=true;report.observedAt=new Date().toISOString();await writeFile(path,JSON.stringify(report,null,2)+'\n',{mode:0o600});console.log(JSON.stringify({passed:report.passed,evidence:resolve(path),failure:report.failure?{code:report.failure.code,message:report.failure.message}:undefined}));}
