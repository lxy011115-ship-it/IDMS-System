// Extends the owned complete-business archive fixture; never accepts live names.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {businessRuntime,backupRuntime,migrationRuntime} from '../database-migrations.mjs';
import {commandSparesCurrent} from '../../server/spares-db.ts';
import {verifySqlRead,verifiedReadStamp} from '../../server/read-integrity.ts';
import {readSparesHistoryCurrent} from '../../server/spares-history-db.ts';
import {readEntities} from '../../server/entity-repository.ts';
import {tenantWorkspace,workspacePayload} from '../../server/tenant-workspace.ts';
import {savePostgres} from '../../server/postgres-repository.ts';
import {appendAudit} from '../../server/audit.ts';
import {createBatch,approveBatch} from '../../server/imports.ts';

async function cli(script,args,secrets,{reject}={}){
 const child=spawn(process.execPath,[script,...args],{windowsHide:true,stdio:['ignore','pipe','pipe']});
 let stdout='',stderr='';child.stdout.on('data',b=>stdout=(stdout+b).slice(-128*1024));child.stderr.on('data',b=>stderr=(stderr+b).slice(-128*1024));
 const code=await new Promise((ok,fail)=>{child.once('error',fail);child.once('exit',ok);});
 for(const secret of secrets.filter(Boolean)){stdout=stdout.replaceAll(secret,'[redacted]');stderr=stderr.replaceAll(secret,'[redacted]');}
 if(reject){assert.notEqual(code,0,'negative migration CLI must refuse');assert.match(stderr,reject);return {rejected:true};}
 assert.equal(code,0,'owned CLI failed: '+stderr.slice(-2500));return JSON.parse(stdout);
}

async function verifyCurrentAuthorization({pool,ctx,run,query,order,plan,input,key,original}){
 // Full normalized command workspace, post-image proof and append-only audit.
 // Assignment here represents an external task handoff in QA, not an IDP change.
 const mutate=async fn=>{const c=await pool.connect();try{await c.query('BEGIN');await c.query("SELECT revision FROM public.business_state WHERE tenant_id='acme' FOR UPDATE");const loaded=await readEntities(c,'acme'),workspace=tenantWorkspace(loaded.payload);fn(workspace);await savePostgres(workspacePayload(workspace,'acme'),{tenantId:'acme',client:c,...loaded});await c.query('COMMIT');}catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}finally{c.release();}};
 const tech={...ctx,actorId:'demo.technician',roles:['maintenance-engineer']},techInput={id:plan.id,expectedVersion:plan.version,quantity:'9',needDate:'2026-12-02',reason:'负责人回执核对'},techKey='archive-assignee-original';
 const saved=await run('material-plan.edit',techInput,tech,techKey);assert.equal(saved.version,plan.version+1);
 await mutate(({store})=>{const current=store.workOrders.find(o=>o.id===order.id),before=structuredClone(current);current.assignee='qa-next-technician';current.version++;current.updatedAt=new Date().toISOString();appendAudit(store,{tenantId:'acme',objectType:'WORK_ORDER',objectId:order.id,action:'QA_EXTERNAL_TASK_HANDOFF',actorType:'USER',actorId:'qa-dispatcher',correlationId:ctx.correlationId,before,after:structuredClone(current)});});
 await assert.rejects(run('material-plan.edit',techInput,tech,techKey),e=>[403,404].includes(e.status));
 assert.equal((await query('material-plans','workOrderId='+order.id, pool)).items[0].operations.edit,true);
 const next={...tech,actorId:'qa-next-technician'};
 const read=(actor)=>readSparesQueryForActor(pool,actor,'material-plans',{workOrderId:order.id});
 assert.equal((await read(tech)).items[0].operations.edit,false);assert.equal((await read(next)).items[0].operations.edit,true);
 await assert.rejects(run('material-plan.create',{...input,quantity:'99'},ctx,key),e=>e.status===409);
 const oldScope={...ctx,scope:{sites:['FACTORY-01'],lines:['LINE-01'],devices:['D-002'],provided:true}};
 assert.equal((await read(oldScope)).items.length,1);
 const uploader={...ctx,actorId:'qa-device-corrector',roles:['data-uploader']},approver={...ctx,actorId:'qa-device-reviewer',roles:['final-approver']};
 await mutate(({store,imports})=>{const parent=imports.batches.find(b=>b.dataType==='DEVICE'&&b.status==='COMMITTED'),row=parent.rows.find(r=>r.device_code==='D-002'),rows=[{...row,line_code:'LINE-02'}],batch=createBatch(imports,store,{dataType:'DEVICE',rows,sourceSystem:parent.sourceSystem,templateVersion:'1.0.0',original:Buffer.from(JSON.stringify(rows)),filename:'qa-approved-device-correction.json',mime:'application/json',sourceKind:'API_JSON',supersedesBatchId:parent.batchId,correctionReason:'隔离验证当前批准设备范围修订'},uploader);approveBatch(imports,store,batch.batchId,{decision:'APPROVED',comment:'独立核对隔离设备修订原文',reviewResolution:'核对源批次、原始行与新的产线归属',expectedVersion:batch.version,snapshotDigest:batch.snapshotDigest},approver);});
 await assert.rejects(read(oldScope),e=>e.status===404);await assert.rejects(run('material-plan.create',input,oldScope,key),e=>[403,404].includes(e.status));
 const currentScope={...oldScope,scope:{...oldScope.scope,lines:['LINE-02']}};assert.equal((await read(currentScope)).items.length,1);
 assert.deepEqual(await run('material-plan.create',input,ctx,key),original);
 return saved;
}

import {readSparesQuery} from '../../server/spares-query-db.ts';
const readSparesQueryForActor=(pool,ctx,endpoint,params)=>readSparesQuery(pool,ctx,endpoint,new URLSearchParams(params),c=>verifySqlRead(pool,c,ctx.tenantId));

export async function verifyInsightsArchiveSource(f){
 const {config,owner,pool,ctx,run,query,part,warehouse,link,order,privateFile,privateRoot,keyFile,files,checks,metrics}=f;
 const account=config.tenants.acme;assert.match(account.database,/^idms_archiveqa_acme_[a-f0-9]{12}$/);
 const secrets=[config.bootstrapPassword,...Object.values(config.tenants).map(a=>a.password),...Object.values(config.businessRoles).flatMap(a=>[a.migrator.password,a.backup.password])];
 const backupConfig=await privateFile('insights-backup.json',JSON.stringify(backupRuntime(config))),migrationConfig=await privateFile('insights-migration.json',JSON.stringify(migrationRuntime(config))),runtimeConfig=await privateFile('insights-business.json',JSON.stringify(businessRuntime(config)));
 const backup=async()=>{const b=await cli('scripts/backup-tenant.mjs',['--tenant','acme','--key-file',keyFile,'--config',backupConfig,'--output-dir',join(privateRoot,'archives')],secrets);files.push(b.file);return b;};
 const migrate=(archive,options={})=>cli('scripts/setup-spares-insights.mjs',['--tenant','acme','--backup',archive,'--key-file',keyFile,'--config',options.migration||migrationConfig,'--business-config',options.runtime||runtimeConfig],secrets,options);
 const input={partId:part.id,warehouseId:warehouse.id,workOrderId:order.id,quantity:'8',needDate:'2026-12-01',reason:'完整归档工单计划，不预留实际库存'};
 await assert.rejects(run('material-plan.create',input,ctx,'archive-plan-before-migration'),e=>e.status===503);
 const before=await backup();assert.equal(before.manifestFormat,2);
 const bad=Buffer.from(await readFile(before.file));bad[bad.length-1]^=1;const badFile=await privateFile('insights-tampered.idmsbackup',bad);
 const disconnectedMigration=await privateFile('insights-disconnected-migration.json',JSON.stringify({...migrationRuntime(config),port:1})),disconnectedRuntime=await privateFile('insights-disconnected-runtime.json',JSON.stringify({...businessRuntime(config),port:1}));
 await migrate(badFile,{migration:disconnectedMigration,runtime:disconnectedRuntime,reject:/authentication/i});
 await run('part.create',{siteCode:'FACTORY-01',code:'INSIGHTS-BACKUP-DRIFT',name:'隔离备份后变动',unit:'只'});
 await migrate(before.file,{reject:/changed since authenticated backup/});
 assert.deepEqual((await owner.query("SELECT name,version FROM idms_spares.migrations WHERE name IN ('capacity','insights') ORDER BY name")).rows,[{name:'capacity',version:1}]);
 const fresh=await backup(),installed=await migrate(fresh.file),again=await migrate(fresh.file);
 assert.equal(installed.capacity,2);assert.equal(installed.insights,1);assert.equal(installed.postedFactsUnchanged,true);assert.equal(installed.alreadyInstalled,false);assert.deepEqual(installed.spares,fresh.spares);assert.equal(again.alreadyInstalled,true);
 checks.push('actual backup and migration CLIs authenticate format2 before connection, refuse tampered/stale archives, then install idempotently under dedicated migration identity without changing posted anchors');
 // Both calls use the real normalized/public proof and actual application role.
 const attempts=await Promise.allSettled(['archive-plan-a','archive-plan-b'].map(key=>run('material-plan.create',input,ctx,key)));
 assert.equal(attempts.filter(r=>r.status==='fulfilled').length,1);const rejected=attempts.find(r=>r.status==='rejected');assert.equal(rejected.reason.status,409);
 const winner=attempts.findIndex(r=>r.status==='fulfilled'),key=['archive-plan-a','archive-plan-b'][winner],original=attempts[winner].value;
 let plan=await run('material-plan.edit',{id:original.id,expectedVersion:original.version,quantity:'9',needDate:'2026-12-02',reason:'核对归档总量9只'});
 await assert.rejects(run('material-plan.edit',{id:plan.id,expectedVersion:original.version,quantity:'99',needDate:'2026-12-02',reason:'旧版本必须拒绝'}),e=>e.status===409);
 plan=await run('material-plan.close',{id:plan.id,expectedVersion:plan.version,reason:'核对期间关闭计划'});
 assert.equal((await query('stock-insight','partId='+part.id+'&warehouseId='+warehouse.id)).calculation.remainingDemandMilli,0);
 plan=await run('material-plan.reopen',{id:plan.id,expectedVersion:plan.version,reason:'核对结束恢复计划'});
 plan=await verifyCurrentAuthorization({pool,ctx,run,query,order,plan,input,key,original});
 checks.push('full normalized workspace handoff revokes original assignee receipt; independently approved original-file device correction revokes old scope, preserves current scope and rejects changed input under original key');
 const plans=await query('material-plans','workOrderId='+order.id),stock=await query('stock-insight','partId='+part.id+'&warehouseId='+warehouse.id),replacement=await query('replacement-insight','linkId='+link.id);
 assert.equal(plans.items.length,1);assert.equal(plans.items[0].quantities.netIssuedMilli,5000);assert.equal(plans.items[0].quantities.remainingMilli,4000);
 assert.equal(stock.calculation.onHandMilli,4000);assert.equal(stock.calculation.remainingDemandMilli,4000);assert.equal(stock.calculation.reserved,false);
 assert.equal(replacement.evidence.qualifyingDateCount,1);assert.equal(replacement.evidence.medianDays,null);
 const history=await readSparesHistoryCurrent(pool,ctx,new URLSearchParams({entityId:plan.id}),c=>verifySqlRead(pool,c,'acme'));assert.equal(history.items.length,5);
 const rights=(await owner.query("SELECT has_schema_privilege($1,'idms_spares','CREATE') AS ddl,has_table_privilege($1,'idms_spares.events','UPDATE,DELETE,TRUNCATE') AS history_write,has_table_privilege($2,'idms_spares.material_plan_records','SELECT') AS backup_read",[account.user,config.businessRoles.acme.backup.user])).rows[0];assert.deepEqual(rights,{ddl:false,history_write:false,backup_read:true});
 metrics.insights={actualCli:true,normalizedOriginalsAndOrder:true,migratedCapacity:2,oldAndV2History:true,normalizedTaskHandoffAndApprovedCorrection:true,concurrentCreates:2,createdPlans:1,postedInventoryMilli:4000,netIssuedMilli:5000,remainingMilli:4000,planHistory:5,rights};
 checks.push('above 10000 entities/20000 events, concurrent unique plans, stale-version refusal, close/reopen, net return and installation all preserve normalized workorder demand and posted stock');
 return {input,key,original,plan,plans,stock,replacement,history,orderId:order.id,partId:part.id,warehouseId:warehouse.id,linkId:link.id};
}

export async function verifyInsightsArchiveRestore({restored,ctx,query,proof,checks,metrics}){
 const {input,key,original,plan,orderId,partId,warehouseId,linkId}=proof;
 const plans=await query('material-plans','workOrderId='+orderId,restored),stock=await query('stock-insight','partId='+partId+'&warehouseId='+warehouseId,restored),replacement=await query('replacement-insight','linkId='+linkId,restored);
 assert.deepEqual(plans,proof.plans);assert.deepEqual(stock,proof.stock);assert.deepEqual(replacement,proof.replacement);
 const history=await readSparesHistoryCurrent(restored,ctx,new URLSearchParams({entityId:plan.id}),c=>verifySqlRead(restored,c,'acme'));assert.deepEqual(history,proof.history);
 const replay=await commandSparesCurrent(restored,ctx,'material-plan.create',input,key,c=>verifiedReadStamp(restored,c,'acme',undefined,true));assert.deepEqual(replay,original);
 const receipt=(await restored.query('SELECT count(*)::text AS n FROM idms_spares.receipts WHERE request_key=$1',[ctx.actorId+':'+key])).rows[0];assert.equal(receipt.n,'1');
 const markers=(await restored.query("SELECT name,version FROM idms_spares.migrations WHERE name IN ('capacity','insights') ORDER BY name")).rows;assert.deepEqual(markers,[{name:'capacity',version:2},{name:'insights',version:1}]);
 assert.equal((await restored.query('SELECT body FROM public.business_work_orders WHERE tenant_id=$1 AND id=$2',[ctx.tenantId,orderId])).rows[0].body.state,'IN_PROGRESS');
 metrics.insights.restoredPlanAndHistoryExact=true;metrics.insights.restoredOriginalRequestOnce=true;metrics.insights.restoredCapability=markers;
 checks.push('encrypted complete pg_dump/restore preserves new plan partition, capability/indexes, normalized order, exact three insights/history responses and one original create receipt replay');
}
