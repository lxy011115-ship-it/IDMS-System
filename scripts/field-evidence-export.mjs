import pg from 'pg';
import {open,lstat,realpath} from 'node:fs/promises';
import {resolve,dirname,isAbsolute} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {canonical} from '../server/imports.ts';
import {readEntities} from '../server/entity-repository.ts';
import {verifyDataProjection} from '../server/data-projection.ts';
import {validateRuntimeConfig,verifyDatabaseSecurity} from '../server/postgres-security.ts';
import {verifyFieldModule} from '../server/field-schema-check.ts';
import {loadFieldPlatformConfig,clearFieldPlatformConfig} from '../server/field-config.ts';
import {verifyFieldRecoveryHandle,assertFieldRecoveryDatabase} from '../server/field-recovery-read.ts';
import {fieldSha256} from '../integrations/field-profile.ts';
import {signFieldEvidencePack,verifyFieldEvidencePack,fieldEvidenceTrust,fieldEvidenceMaxBytes,fieldEvidenceFailure as fail} from '../server/field-evidence.ts';
import {CurrentRecoveryActor} from './field-recovery-current-actor.mjs';
import {readFieldEvidenceFile,parseFieldEvidenceJson,fieldEvidenceFlags} from './field-evidence-file.mjs';
import {memoryTask} from '../server/capacity.ts';
import {closeSourceConnection} from './field-source-freeze.mjs';

const exec=promisify(execFile),keys=['--runtime-config','--platform-config','--external-config','--access-token-file','--trust-config','--public-materials','--observations','--output','--tenant','--edge-id','--expected-root-sha256'];
let configuration,identity,client;
try{await memoryTask(async()=>{
 const args=fieldEvidenceFlags(process.argv.slice(2),keys);if(keys.filter(k=>k!=='--expected-root-sha256').some(k=>!args[k])||!isAbsolute(args['--output'])||args['--expected-root-sha256']&&!/^[a-f0-9]{64}$/.test(args['--expected-root-sha256']))fail('FIELD_EVIDENCE_ARGUMENTS_INVALID');
 const pins=new Map(),read=async(key,max=2097152)=>{const bytes=await readFieldEvidenceFile(args[key],max);pins.set(key,{max,hash:fieldSha256(bytes)});return bytes;},json=async(key,max)=>parseFieldEvidenceJson(await read(key,max)),assertConfiguration=async()=>{for(const [key,pin]of pins){const bytes=await readFieldEvidenceFile(args[key],pin.max);try{if(fieldSha256(bytes)!==pin.hash)fail('FIELD_EVIDENCE_CONFIGURATION_CHANGED');}finally{bytes.fill(0);}}};
 const runtime=validateRuntimeConfig(await json('--runtime-config')),external=await json('--external-config'),tenant=args['--tenant'],edge=args['--edge-id'],account=runtime.tenants[tenant],trust=fieldEvidenceTrust(await json('--trust-config')),token=(await read('--access-token-file',32768)).toString('utf8').trim();
 if(!account||trust.tenantId!==tenant||trust.edgeId!==edge||external.tenantId!==tenant)fail('FIELD_EVIDENCE_SCOPE_MISMATCH');identity=new CurrentRecoveryActor(external);const actor=await identity.verify(token,{purpose:'READ'}),authenticatedAt=new Date().toISOString();
 // Only a current real reader with complete scope reaches private signing
 // material or any output operation. READ never creates a review approval.
 await read('--platform-config');configuration=await loadFieldPlatformConfig(args['--platform-config']);const t=configuration.tenants.get(tenant),channel=t?.channels.get(edge);if(!t?.recovery||!channel?.eventKey||t.snapshot.format!=='idms-field-registry-v2')fail('FIELD_EVIDENCE_ACTIVE_CHANNEL_REQUIRED');assertFieldRecoveryDatabase(t.recovery,{host:runtime.host,port:runtime.port,database:account.database,user:account.user});await verifyFieldRecoveryHandle(t.recovery);
 const publicMaterials=await json('--public-materials',5*1024**2),observations=await json('--observations',8*1024**2);
 client=new pg.Client({host:runtime.host,port:runtime.port,...account,application_name:'idms-field-evidence-export',connectionTimeoutMillis:5000,query_timeout:30000,options:'-c statement_timeout=25000 -c idle_in_transaction_session_timeout=60000'});client.on('error',()=>{});await client.connect();await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');await verifyDatabaseSecurity(client,account,tenant);const module=await verifyFieldModule(client,account,tenant),loaded=await readEntities(client,tenant);await verifyDataProjection(client,loaded.payload.imports,tenant);
 const rootRecord=(await client.query('SELECT to_jsonb(t)::text AS value FROM public.business_state t WHERE tenant_id=$1',[tenant])).rows[0]?.value;if(!rootRecord||args['--expected-root-sha256']&&fieldSha256(rootRecord)!==args['--expected-root-sha256'])fail('FIELD_EVIDENCE_EXPECTED_ROOT_CHANGED');
 const sequence=(await client.query('SELECT sequence_no::text AS value FROM public.audit_ledger ORDER BY sequence_no')).rows.map(r=>r.value),points=(await client.query('SELECT to_jsonb(t) AS value FROM idms_field.points t WHERE tenant_id=$1 AND edge_id=$2 ORDER BY id LIMIT 2001',[tenant,edge])).rows.map(r=>r.value),receipts=(await client.query('SELECT to_jsonb(t) AS value FROM idms_field.receipts t WHERE tenant_id=$1 AND edge_id=$2 ORDER BY event_id,digest LIMIT 2001',[tenant,edge])).rows.map(r=>r.value);
 if(points.length>2000||receipts.length>2000||sequence.length>25000)fail('FIELD_EVIDENCE_LIMIT');
 const body={format:'idms-field-evidence-body-v1',tenantId:tenant,edgeId:edge,capturedAt:new Date().toISOString(),signingKeyId:configuration.leaseKeyId,reader:{actorId:actor.actorId,roles:actor.roles,scope:actor.scope,authenticatedAt,currentIdentitySha256:actor.sha256},registration:t.snapshot,rootRecord,payload:loaded.payload,auditSequence:sequence,module,points,receipts,observations,publicMaterials},pack=signFieldEvidencePack(body,configuration.signingKey),report=verifyFieldEvidencePack(pack,trust,{eventKeys:new Map([[fieldSha256(channel.eventKey),channel.eventKey]])}),bytes=Buffer.from(canonical(pack));
 if(bytes.length>fieldEvidenceMaxBytes)fail('FIELD_EVIDENCE_LIMIT');await assertConfiguration();await verifyFieldRecoveryHandle(t.recovery);const current=await identity.current({purpose:'READ'});if(current.sha256!==actor.sha256)fail('FIELD_EVIDENCE_READER_CHANGED');await client.query('COMMIT');await verifyFieldRecoveryHandle(t.recovery);await assertConfiguration();
 const output=resolve(args['--output']);for(let p=dirname(output);;p=dirname(p)){const stat=await lstat(p),actual=await realpath(p);if(!stat.isDirectory()||stat.isSymbolicLink()||(process.platform==='win32'?actual.toLowerCase()!==p.toLowerCase():actual!==p))fail('FIELD_EVIDENCE_PATH_INVALID');if(dirname(p)===p)break;}
 let file;try{file=await open(output,'wx',0o600);if(process.platform==='win32')await exec('icacls.exe',[output,'/inheritance:r','/grant:r',process.env.USERDOMAIN+'\\'+process.env.USERNAME+':(F)'],{windowsHide:true,maxBuffer:8192});await file.writeFile(bytes);await file.sync();}catch(error){if(error.code==='EEXIST')fail('FIELD_EVIDENCE_OUTPUT_EXISTS');throw error;}finally{await file?.close();}
 console.log(JSON.stringify({format:'idms-field-evidence-export-result-v1',tenantId:tenant,edgeId:edge,bytes:bytes.length,packSha256:fieldSha256(bytes),rootSha256:report.rootSha256,points:report.points,receipts:report.receipts,acknowledgements:report.acknowledgements,checks:report.checks,actualCurrentOidcFullScopeReaderVerified:true,readOnlySnapshotNoBusinessMutation:true,privateConfiguredSecretsExcluded:true,productionAcceptance:false},null,2));
},true);}catch(error){console.error(JSON.stringify({code:typeof error.code==='string'&&/^FIELD_(?:EVIDENCE|RECOVERY)_[A-Z0-9_]+$/.test(error.code)?error.code:'FIELD_EVIDENCE_EXPORT_FAILED',existingOutputNotOverwritten:true,productionAcceptance:false}));process.exitCode=1;}finally{if(client?.getTransactionStatus?.()!=='I')await client?.query('ROLLBACK').catch(()=>{});await closeSourceConnection(client);await identity?.close();if(configuration)clearFieldPlatformConfig(configuration);}
