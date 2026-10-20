import assert from 'node:assert/strict';
import {readFile,mkdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {randomBytes,createHash} from 'node:crypto';
import pg from 'pg';
import {createMaintenanceBusinessQaV4} from './fixtures/maintenance-map-business-v4-qa.mjs';
import {bootstrapMaintenanceMapV4Qa} from './fixtures/maintenance-map-bootstrap-v4.mjs';
import {activateMaintenanceMapV4} from './maintenance-map-activation-v4.mjs';
import {DomainMapV4,DomainMapSnapshot} from '../server/domain-map-v4.ts';
import {privateDirectory,privateNewFile} from './backup-support.mjs';
const names=['scripts/verify-maintenance-legacy-outbox-v4.mjs','scripts/fixtures/maintenance-map-business-v4-qa.mjs','scripts/fixtures/maintenance-map-bootstrap-v4.mjs','scripts/maintenance-map-activation-v4.mjs','server/maintenance-map-common-v4.ts','server/maintenance-map-index-v4.ts'],inputs=[];
for(const path of names){const bytes=await readFile(path);inputs.push({path,bytes,sha256:createHash('sha256').update(bytes).digest('hex')});}
const gateways=Object.fromEntries(['acme','sandbox'].map(tenantId=>[tenantId,{tenantId,baseUrl:'http://127.0.0.1:1',serviceToken:randomBytes(32).toString('base64url'),model:{name:'qwen3:4b',digest:'sha256:'+'0'.repeat(64)}}]));
const qa=await createMaintenanceBusinessQaV4(gateways),work=resolve('work/maintenance-map-v4-20261020',qa.nonce);let proof={kind:'LEGACY_ORPHAN_GUARD',passed:false};
try{
 await privateDirectory(work);for(const pin of inputs){const path=join(work,'input-source',pin.path);await mkdir(resolve(path,'..'),{recursive:true});await privateNewFile(path,pin.bytes);}console.log('QA_DIRECTORY '+work);
 const root=new pg.Client({...qa.adminAccount,database:qa.business.tenants.sandbox.database});await root.connect();try{const r=await root.query("UPDATE public.workflow_outbox SET status='HUMAN_REVIEW' WHERE status='SYNCED' RETURNING command_id,entity_id");assert.equal(r.rowCount,1);proof.orphanEntityId=r.rows[0].entity_id;}finally{await root.end();}
 const source={tenantId:'sandbox',edgeId:'maint-orphan-'+qa.nonce,deviceCode:'MAINT-ORPHAN',origin:'SIMULATOR',mapVersion:'maint-orphan-1',signingKey:randomBytes(32).toString('base64url'),acknowledgementKey:randomBytes(32).toString('base64url'),statusKey:randomBytes(32).toString('base64url'),statusUrl:'http://127.0.0.1:1/status',points:[{tagCode:'vibration_rms',nodeId:'ns=1;s=vibration_rms',unit:'mm/s'}]},clock={at:Date.now()-60000},RealDate=Date;let boot;globalThis.Date=class extends RealDate{constructor(...a){super(...(a.length?a:[clock.at]));}static now(){return clock.at;}};try{boot=await bootstrapMaintenanceMapV4Qa(qa,source,clock);}finally{globalThis.Date=RealDate;}
 assert.ok(boot.maintenanceFixtures.every(f=>f.id!==proof.orphanEntityId));const {target}=boot,map=new DomainMapV4(target.account,target.binding),before=await map.head();await assert.rejects(()=>activateMaintenanceMapV4(target.account,target.binding),/MAINTENANCE_LEGACY_OUTBOX_UNRESOLVED/);assert.deepEqual(await map.head(),before);const s=await map.snapshot();try{assert.equal((await s.state('domain_head','maintenance')).present,false);assert.equal((await s.get('v4_collection','business/workOrders')).count,'8');}finally{await s.close();}
 for(const pin of inputs)assert.equal(createHash('sha256').update(await readFile(pin.path)).digest('hex'),pin.sha256);proof={...proof,passed:true,sourcePins:inputs.map(({path,sha256})=>({path,sha256})),actualMigratedSqlOrphanHumanReviewRefusedBeforeAnyTargetWrite:true,allEightLocalOrdersWouldOtherwiseBeEligible:true,wholeTargetHeadUnchanged:true,maintenanceMarkerAbsent:true,currentAuthorizationFixtureIsTrustedCallbackNotOidc:true,originalRuntimeMigrated:false,productionAcceptance:false,completeCommercialGoal:false};console.log('PASS actual sealed legacy SQL orphan HUMAN_REVIEW blocks activation with unchanged target root');
}finally{await qa.close();proof.cleanup=JSON.parse(await readFile(join(qa.work,'cleanup.json'),'utf8'));await privateNewFile(join(work,'verification.json'),JSON.stringify(proof,null,2));console.log('VERIFICATION '+join(work,'verification.json'));}
