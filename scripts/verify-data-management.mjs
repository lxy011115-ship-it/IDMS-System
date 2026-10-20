import {runtimeViewSchema} from '../server/entity-schema.ts';
import assert from 'node:assert/strict';
import {readFile,mkdir,writeFile,unlink} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {randomUUID,randomBytes} from 'node:crypto';
import pg from 'pg';
import {chromium} from 'playwright';
import {localConfig,adminToken,adminApi,writePrivate} from './keycloak-local.mjs';
import {dataOverview,dataMeasurements} from '../server/data-management.ts';
import {canonical} from '../server/imports.ts';
import {migrateQaDatabases,cleanupQaRoles,qaAdminAccount} from './qa-database.mjs';

const suffix=randomUUID().replaceAll('-','').slice(0,10),namespace='dataqa-'+suffix,directory=resolve('.local',namespace),base='http://127.0.0.1:4048',clientId='idms-dataqa-'+suffix;
const database=JSON.parse(await readFile('.local/postgres-runtime.json','utf8')),identity=await localConfig(),config={host:database.host,port:database.port,tenants:{}};
const admin=new pg.Client({host:database.host,port:database.port,user:'idms_bootstrap',password:database.bootstrapPassword,database:'postgres'});
const accounts=[],users=[],errors=[];let core,browser,clientIdInternal,sql,log='';
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function stop(){if(!core||core.exitCode!==null||core.signalCode!==null)return;const end=new Promise(r=>core.once('exit',r));core.kill();await end;}
async function start(){
  log='';core=spawn(process.execPath,['server/index.ts'],{env:{...process.env,PORT:'4048',IDMS_DEMO_NAMESPACE:namespace,IDMS_STORAGE:'postgres',IDMS_POSTGRES_CONFIG:join(directory,'postgres.json'),IDMS_AUTH_MODE:'oidc',IDMS_PUBLIC_ORIGIN:base,IDMS_OIDC_ISSUER:identity.origin+'/realms/idms',IDMS_OIDC_CLIENT_ID:clientId,IDMS_OIDC_AUDIENCE:'idms-api',IDMS_TELEMETRY_CONFIG:'',IDMS_WORKFLOW_CLIENT_CONFIG:'',IDMS_AI_CLIENT_CONFIG:''},windowsHide:true,stdio:['ignore','pipe','pipe']});
  for(const stream of [core.stdout,core.stderr])stream.on('data',b=>log=(log+b).slice(-4000));
  for(let i=0;i<100;i++){if(core.exitCode!==null)throw Error(log);try{if((await fetch(base+'/api/v1/health')).ok)return;}catch{}await pause(100);}throw Error('QA core readiness not confirmed');
}
async function user(label,roles,tenant='acme'){
  const value={username:'dataqa-'+suffix+'-'+label,password:'Qa9-'+randomBytes(24).toString('base64url'),tenant};const token=await adminToken(identity);
  await adminApi(identity,token,'idms/users','POST',{username:value.username,enabled:true,firstName:label,lastName:'QA',email:value.username+'@idms.invalid',emailVerified:true,attributes:{tenant_id:[tenant],idms_sites:[' * '],idms_lines:[' * '],idms_devices:[' * ']},credentials:[{type:'password',value:value.password,temporary:false}]});
  value.id=(await adminApi(identity,token,'idms/users?username='+value.username+'&exact=true'))[0].id;users.push(value);
  const mapped=[];for(const role of roles)mapped.push(await adminApi(identity,token,'idms/roles/'+role));await adminApi(identity,token,`idms/users/${value.id}/role-mappings/realm`,'POST',mapped);return value;
}
async function login(u){await u.context?.close();u.context=await browser.newContext({viewport:{width:1440,height:1000}});u.page=await u.context.newPage();u.page.on('pageerror',e=>errors.push(e.message));await u.page.goto(base+'/?view=data-center');await u.page.getByTestId('oidc-login').click();await u.page.locator('#username').fill(u.username);await u.page.locator('#password').fill(u.password);await u.page.locator('#kc-login').click();await u.page.getByTestId('verified-identity').waitFor();await u.page.getByRole('heading',{name:'设备档案',exact:true}).waitFor();await u.page.waitForFunction(()=>!document.querySelector('.busy-line'));}
async function api(u,path,body,expected=200,key=randomUUID()){
  const session=await (await u.page.request.get(base+'/api/v1/auth/session')).json(),response=await u.page.request.fetch(base+'/api/v1'+path,{method:body?'POST':'GET',headers:body?{'Content-Type':'application/json','Idempotency-Key':key,'X-Correlation-Id':randomUUID(),'X-CSRF-Token':session.csrfToken,Origin:base}:{},...(body?{data:body}:{})});
  const value=await response.json();assert.equal(response.status(),expected,JSON.stringify(value));return value;
}
const approve=(u,batch,expected=202)=>api(u,'/data-imports/'+batch.batchId+'/approval',{decision:'APPROVED',comment:'独立核查设备及测点字典',reviewResolution:'逐行人工复核来源、单位和物理范围；不作为设备健康判断',expectedVersion:batch.version,snapshotDigest:batch.snapshotDigest},expected);
const records=(type,rows)=>({dataType:type,records:rows,templateVersion:'1.0.0',sourceSystem:'multi-device-qa'});
try{
  await mkdir(directory,{recursive:true});await admin.connect();
  for(const tenant of ['acme','sandbox']){
    const name='idms_dataqa_'+tenant+'_'+suffix,account={database:name,user:name,password:randomBytes(32).toString('base64url')};accounts.push(account);
    await admin.query(`CREATE ROLE "${name}" LOGIN PASSWORD '${account.password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`);await admin.query(`CREATE DATABASE "${name}" OWNER "${name}"`);await admin.query(`REVOKE CONNECT ON DATABASE "${name}" FROM PUBLIC`);await admin.query(`GRANT CONNECT ON DATABASE "${name}" TO "${name}"`);config.tenants[tenant]=account;
  }
  await writePrivate(join(directory,'postgres.json'),JSON.stringify(await migrateQaDatabases(config,database)));
  const token=await adminToken(identity),web=(await adminApi(identity,token,'idms/clients?clientId=idms-web'))[0],mappers=await adminApi(identity,token,`idms/clients/${web.id}/protocol-mappers/models`);
  await adminApi(identity,token,'idms/clients','POST',{clientId,enabled:true,publicClient:true,fullScopeAllowed:false,standardFlowEnabled:true,directAccessGrantsEnabled:false,implicitFlowEnabled:false,protocol:'openid-connect',redirectUris:[base+'/api/v1/auth/callback'],attributes:{'pkce.code.challenge.method':'S256'},protocolMappers:mappers.map(({id,...m})=>m)});clientIdInternal=(await adminApi(identity,token,'idms/clients?clientId='+clientId))[0].id;await adminApi(identity,token,`idms/clients/${clientIdInternal}/scope-mappings/realm`,'POST',await adminApi(identity,token,`idms/clients/${web.id}/scope-mappings/realm`));
  const uploader=await user('uploader',['data-uploader','final-approver']),reviewer=await user('reviewer',['final-approver']),auditor=await user('auditor',['auditor']),foreign=await user('foreign',['auditor'],'sandbox');
  await start();browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});for(const u of users)await login(u);
  assert.equal((await api(auditor,'/data-management/overview')).summary.devices,0,'Seed display assets must not become customer import facts');
  const assets=[{source_record_id:'pump-1',device_code:'PUMP-01',device_name:'循环水泵',site_code:'FACTORY-02',line_code:'UTILITY-01',equipment_type:'泵组',brand:'示例品牌',model:'P-100',serial_number:'QA-P-1',criticality:'HIGH'},{source_record_id:'comp-1',device_code:'COMP-01',device_name:'空压机',site_code:'FACTORY-03',line_code:'UTILITY-02',equipment_type:'空压机',brand:'示例品牌',model:'C-200',serial_number:'QA-C-1',criticality:'MEDIUM'}];
  // Upload a real CSV through the active browser form, including the new optional columns.
  await uploader.page.locator('.sidebar [data-view=uploads]').click();await uploader.page.locator('#data-type').selectOption('DEVICE');const fields=Object.keys(assets[0]),csv=fields.join(',')+'\n'+assets.map(r=>fields.map(f=>r[f]).join(',')).join('\n');
  const received=uploader.page.waitForResponse(r=>r.url().endsWith('/api/v1/data-imports')&&r.request().method()==='POST');await uploader.page.locator('#file-upload').setInputFiles({name:'multi-device.csv',mimeType:'text/csv',buffer:Buffer.from(csv)});const asset=await (await received).json();assert.equal(asset.status,'HUMAN_REVIEW');await approve(uploader,asset,403);await approve(reviewer,asset);
  const points=[{source_record_id:'pump-pressure',device_code:'PUMP-01',tag_code:'pressure',tag_name:'<img src=x onerror=alert(1)> 出口压力',unit:'MPa',min_value:0,max_value:10,expected_interval_seconds:3600},{source_record_id:'comp-pressure',device_code:'COMP-01',tag_code:'pressure',tag_name:'排气压力',unit:'bar',min_value:0,max_value:16}];
  const pending=await api(uploader,'/data-imports/records',records('POINT_DEFINITION',points),202);assert.equal(pending.status,'HUMAN_REVIEW');
  const reading={source_record_id:'pump-reading',device_code:'PUMP-01',tag_code:'pressure',measured_at:'2026-10-14T08:00:00+08:00',value:1.2,unit:'MPa',quality:'GOOD'};
  assert.equal((await api(uploader,'/data-imports/records',records('MEASUREMENT',[reading]),202)).status,'VALIDATION_FAILED');
  sql=new pg.Client(qaAdminAccount(database,config.tenants.acme));await sql.connect();
  await sql.query("CREATE FUNCTION qa_deny_import() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event->>'action'='IMPORT_COMMITTED' THEN RAISE EXCEPTION 'QA commit failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER qa_import_failure BEFORE INSERT ON audit_ledger FOR EACH ROW EXECUTE FUNCTION qa_deny_import()");
  await approve(reviewer,pending,500);assert.equal((await api(auditor,'/data-management/overview')).summary.definedPoints,0);assert.equal((await api(auditor,'/data-imports/'+pending.batchId)).status,'HUMAN_REVIEW');await sql.query('DROP TRIGGER qa_import_failure ON audit_ledger; DROP FUNCTION qa_deny_import()');await approve(reviewer,pending);
  const key=randomUUID(),input=records('MEASUREMENT',[reading,{...reading,source_record_id:'pump-bad',measured_at:'2026-10-14T09:00:00+08:00',value:2,quality:'BAD'},{...reading,source_record_id:'comp-reading',device_code:'COMP-01',unit:'bar'}]),batch=await api(uploader,'/data-imports/records',input,202,key);assert.equal((await api(uploader,'/data-imports/records',input,202,key)).batchId,batch.batchId);await approve(reviewer,batch);
  const overview=await api(auditor,'/data-management/overview');assert.equal(overview.summary.devices,2);assert.equal(overview.summary.definedPoints,2);assert.equal(overview.summary.measurements,3);assert.equal(overview.summary.nonGoodMeasurements,1);
  const imported=(await sql.query('SELECT payload FROM runtime_state')).rows[0].payload.imports,readContext={tenantId:'acme',actorId:auditor.id,actorType:'USER',authMode:'oidc',roles:['auditor']};
  for(const filter of [{},{q:'泵'},{equipmentType:'泵组',siteCode:'FACTORY-02'},{page:'2',pageSize:'1'},{q:"%' OR 1=1 --"}]){const params=new URLSearchParams(filter);assert.deepEqual(await api(auditor,'/data-management/overview?'+params),dataOverview(imported,readContext,params));}
  for(const filter of [{},{deviceCode:'PUMP-01',quality:'BAD'},{tagCode:'pressure',page:'2',pageSize:'1'},{page:'20',pageSize:'1'},{from:'2026-10-14T08:30:00+08:00',to:'2026-10-14T10:00:00+08:00'}]){const params=new URLSearchParams(filter);assert.deepEqual(await api(auditor,'/data-management/measurements?'+params),dataMeasurements(imported,readContext,params));}
  assert.equal(Number((await sql.query('SELECT count(*) FROM managed_import_rows')).rows[0].count),7);
  assert.equal(Number((await sql.query('SELECT count(*) FROM managed_assets')).rows[0].count),2);
  assert.equal(Number((await sql.query('SELECT count(*) FROM managed_point_definitions')).rows[0].count),2);
  assert.equal(Number((await sql.query('SELECT count(*) FROM managed_measurements')).rows[0].count),3);
  await assert.rejects(sql.query("UPDATE managed_assets SET brand='changed'"),/append-only/);
  await assert.rejects(sql.query('DELETE FROM managed_measurements'),/append-only/);
  assert.equal((await api(foreign,'/data-management/overview')).summary.devices,0);assert.equal((await api(foreign,'/data-management/measurements')).total,0);await api(foreign,'/data-imports/'+batch.batchId,undefined,404);await api(auditor,'/data-management/measurements?pageSize=101',undefined,400);
  await auditor.page.reload();await auditor.page.getByRole('heading',{name:'设备档案',exact:true}).waitFor();await auditor.page.waitForFunction(()=>!document.querySelector('.busy-line'));
  const form=auditor.page.locator('#data-measurement-filter');await form.locator('[name=deviceCode]').fill('PUMP-01');await form.locator('[name=quality]').selectOption('BAD');await form.locator('[data-action=data-measurement-filter]').click();await auditor.page.waitForFunction(()=>!document.querySelector('.busy-line'));assert.ok((await auditor.page.locator('main').innerText()).includes('第 1 页 · 共 1 条'));assert.equal(await auditor.page.locator('main img').count(),0);
  const detail=await api(auditor,'/data-management/measurements?deviceCode=PUMP-01&quality=BAD');assert.equal(detail.items[0].source.batchId,batch.batchId);assert.equal(detail.items[0].source.sourceRow,3);assert.equal(detail.items[0].definition.definitionBatchId,pending.batchId);
  await auditor.page.screenshot({path:'outputs/demo-preview/37-multi-device-data-desktop.png',fullPage:true});await auditor.page.locator(`[data-action=data-source][data-id="${batch.batchId}"]`).first().click();await auditor.page.locator('.import-drawer').waitFor();assert.ok((await auditor.page.locator('.import-drawer').innerText()).includes(batch.snapshotDigest));await auditor.page.locator('.drawer-head [data-action=close]').click();
  for(const width of [390,320]){await auditor.page.setViewportSize({width,height:844});assert.equal(await auditor.page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);}
  await auditor.page.screenshot({path:'outputs/demo-preview/38-multi-device-data-mobile.png',fullPage:true});assert.deepEqual(errors,[]);
  await stop();await start();await login(auditor);assert.equal((await api(auditor,'/data-management/overview')).summary.measurements,3);assert.equal((await api(auditor,'/audit')).chainValid,true);
  await login(uploader);await login(reviewer);
  const extra=await api(uploader,'/data-imports/records',records('MEASUREMENT',[{...reading,source_record_id:'projection-fault',measured_at:'2026-10-14T10:00:00+08:00'}]),202);
  const beforeFault=canonical((await sql.query('SELECT payload FROM runtime_state')).rows[0].payload);
  const beforeLedger=Number((await sql.query('SELECT count(*) FROM audit_ledger')).rows[0].count);
  await sql.query("CREATE FUNCTION qa_deny_projection() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'QA projection failure'; END $$; CREATE TRIGGER qa_projection_failure BEFORE INSERT ON managed_measurements FOR EACH ROW EXECUTE FUNCTION qa_deny_projection()");
  await approve(reviewer,extra,500);assert.equal(canonical((await sql.query('SELECT payload FROM runtime_state')).rows[0].payload),beforeFault);assert.equal(Number((await sql.query('SELECT count(*) FROM audit_ledger')).rows[0].count),beforeLedger);assert.equal(Number((await sql.query('SELECT count(*) FROM managed_import_rows')).rows[0].count),7);assert.equal((await api(auditor,'/data-management/overview')).summary.measurements,3);
  await sql.query('DROP TRIGGER qa_projection_failure ON managed_measurements; DROP FUNCTION qa_deny_projection()');await approve(reviewer,extra);assert.equal((await api(auditor,'/data-management/overview')).summary.measurements,4);
  await stop();
  const beforeMigration=(await sql.query('SELECT payload FROM runtime_state')).rows[0].payload;
  assert.match((await sql.query('SELECT current_database() AS name')).rows[0].name,new RegExp('^idms_dataqa_acme_'+suffix+'$'));
  await sql.query('DROP VIEW runtime_state; DROP TABLE managed_record_revisions,managed_measurements,managed_point_definitions,managed_assets,managed_import_rows,managed_projection_state');
  await assert.rejects(start(),/Unexpected tables|migration/i);await stop();
  const {initializeDataProjection}=await import('../server/data-projection.ts');
  await sql.query('BEGIN');try{await sql.query(`SET LOCAL ROLE "${config.businessRoles.acme.owner}"`);await initializeDataProjection(sql,beforeMigration.imports,'acme');await sql.query(runtimeViewSchema);await sql.query(`GRANT SELECT ON runtime_state TO "${config.tenants.acme.user}","${config.businessRoles.acme.backup.user}"`);for(const table of ['managed_record_revisions','managed_measurements','managed_point_definitions','managed_assets','managed_import_rows','managed_projection_state'])await sql.query(`GRANT SELECT${table==='managed_projection_state'?',UPDATE':',INSERT'} ON ${table} TO "${config.tenants.acme.user}"; GRANT SELECT ON ${table} TO "${config.businessRoles.acme.backup.user}"`);await sql.query('COMMIT');}catch(e){await sql.query('ROLLBACK');throw e;}
  await start();await login(auditor);const afterMigration=(await sql.query('SELECT payload FROM runtime_state')).rows[0].payload;assert.deepEqual(afterMigration.imports,beforeMigration.imports);assert.deepEqual(afterMigration.business,beforeMigration.business);assert.equal((await api(auditor,'/data-management/overview')).summary.measurements,4);
  await stop();await sql.query("ALTER TABLE managed_assets DISABLE TRIGGER USER; UPDATE managed_assets SET brand='corrupt' WHERE device_code='PUMP-01'; ALTER TABLE managed_assets ENABLE TRIGGER USER");
  await assert.rejects(start(),/typed fields disagree/);const rejected=(await sql.query('SELECT payload FROM runtime_state')).rows[0].payload;assert.deepEqual(rejected.imports,beforeMigration.imports);assert.deepEqual(rejected.business,beforeMigration.business);
  await sql.query("ALTER TABLE managed_assets DISABLE TRIGGER USER; UPDATE managed_assets a SET brand=NULLIF(r.body->>'brand','') FROM managed_import_rows r WHERE r.tenant_id=a.tenant_id AND r.ordinal=a.source_ordinal; ALTER TABLE managed_assets ENABLE TRIGGER USER");await start();await login(auditor);assert.equal((await api(auditor,'/audit')).chainValid,true);
  const evidence={verifiedAt:new Date().toISOString(),namespace,syntheticDataOnly:true,actualPostgresOidcCsvUpload:true,multiDeviceTypesAndSites:true,perDevicePointUnitAndRange:true,independentApprovalAndPendingDefinitionBlocked:true,sqlCommitFailureRolledBack:true,idempotentUpload:true,crossTenantReadIsolation:true,qualityFiltersAndOriginalBatchRowLineage:true,restartPersistenceAndAudit:true,typedSqlDomainTables:true,sqlFilteringPaginationMatchesFileContract:true,parameterizedSqlInjectionProbe:true,projectionFailureRollsBackApprovalAuditIdempotencyAndSourceRows:true,appendOnlyProjection:true,legacySnapshotMigrationPreservesImportsAndBusiness:true,corruptTypedProjectionBlocksStartup:true,xssTextEscaped:true,mobile320And390NoOverflow:true,pageErrors:errors,productionAcceptance:false};await writeFile('outputs/data-management-verification.json',JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence,null,2));
}finally{
  await browser?.close();await stop();await sql?.end();
  const token=await adminToken(identity);for(const u of users){assert.ok(u.username.startsWith('dataqa-'+suffix+'-'));await adminApi(identity,token,'idms/users/'+u.id,'DELETE');}if(clientIdInternal)await adminApi(identity,token,'idms/clients/'+clientIdInternal,'DELETE');
  for(const a of accounts){assert.match(a.database,new RegExp('^idms_dataqa_(acme|sandbox)_'+suffix+'$'));await admin.query(`DROP DATABASE IF EXISTS "${a.database}" WITH (FORCE)`);await admin.query(`DROP ROLE IF EXISTS "${a.user}"`);}await cleanupQaRoles(admin,config);await admin.end();await unlink(join(directory,'postgres.json')).catch(()=>{});
}
