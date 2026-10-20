import assert from 'node:assert/strict';
import {readFile,mkdir,writeFile,unlink} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {randomUUID,randomBytes} from 'node:crypto';
import net from 'node:net';
import pg from 'pg';
import ExcelJS from 'exceljs';
import {chromium} from 'playwright';
import {localConfig,adminToken,adminApi,writePrivate} from './keycloak-local.mjs';
import {canonical} from '../server/imports.ts';
import {migrateQaDatabases,cleanupQaRoles,qaAdminAccount} from './qa-database.mjs';

const suffix=randomUUID().replaceAll('-','').slice(0,10),namespace='mappingqa-'+suffix,directory=resolve('.local',namespace),base='http://127.0.0.1:4050',clientId='idms-mappingqa-'+suffix;
const database=JSON.parse(await readFile('.local/postgres-runtime.json','utf8')),identity=await localConfig(),config={host:database.host,port:database.port,tenants:{}};
const admin=new pg.Client({host:database.host,port:database.port,user:'idms_bootstrap',password:database.bootstrapPassword,database:'postgres'}),accounts=[],users=[],errors=[];
let core,browser,clientIdInternal,sql,log='';const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function stop(){if(!core||core.exitCode!==null||core.signalCode!==null)return;const ended=new Promise(r=>core.once('exit',r));core.kill();await ended;}
async function start(){
 log='';core=spawn(process.execPath,['server/index.ts'],{env:{...process.env,PORT:'4050',IDMS_DEMO_NAMESPACE:namespace,IDMS_STORAGE:'postgres',IDMS_POSTGRES_CONFIG:join(directory,'postgres.json'),IDMS_AUTH_MODE:'oidc',IDMS_PUBLIC_ORIGIN:base,IDMS_OIDC_ISSUER:identity.origin+'/realms/idms',IDMS_OIDC_CLIENT_ID:clientId,IDMS_OIDC_AUDIENCE:'idms-api',IDMS_TELEMETRY_CONFIG:'',IDMS_WORKFLOW_CLIENT_CONFIG:'',IDMS_AI_CLIENT_CONFIG:''},windowsHide:true,stdio:['ignore','pipe','pipe']});
 for(const stream of [core.stdout,core.stderr])stream.on('data',b=>log=(log+b).slice(-5000));
 for(let i=0;i<150;i++){if(core.exitCode!==null)throw Error(log);try{if((await fetch(base+'/api/v1/health')).ok)return;}catch{}await pause(100);}throw Error('Mapping QA readiness not confirmed; inspect existing process: '+log);
}
async function user(label,roles,tenant='acme'){
 const u={username:'mapqa-'+suffix+'-'+label,password:'Qa9-'+randomBytes(24).toString('base64url'),tenant};const token=await adminToken(identity);
 await adminApi(identity,token,'idms/users','POST',{username:u.username,enabled:true,firstName:label,lastName:'QA',email:u.username+'@idms.invalid',emailVerified:true,attributes:{tenant_id:[tenant],idms_sites:[' * '],idms_lines:[' * '],idms_devices:[' * ']},credentials:[{type:'password',value:u.password,temporary:false}]});
 u.id=(await adminApi(identity,token,'idms/users?username='+u.username+'&exact=true'))[0].id;users.push(u);const mapped=[];for(const role of roles)mapped.push(await adminApi(identity,token,'idms/roles/'+role));await adminApi(identity,token,`idms/users/${u.id}/role-mappings/realm`,'POST',mapped);return u;
}
async function login(u){await u.context?.close();u.context=await browser.newContext({viewport:{width:1440,height:1000}});u.page=await u.context.newPage();u.page.on('pageerror',e=>errors.push(e.message));await u.page.goto(base+'/?view=templates');await u.page.getByTestId('oidc-login').click();await u.page.locator('#username').fill(u.username);await u.page.locator('#password').fill(u.password);await u.page.locator('#kc-login').click();await u.page.getByTestId('verified-identity').waitFor();await idle(u);}
async function idle(u){await u.page.waitForFunction(()=>!document.querySelector('.busy-line'));assert.equal(await u.page.locator('[role=alert]').count(),0);}
async function headers(u,key=randomUUID()){const session=await (await u.page.request.get(base+'/api/v1/auth/session')).json();return {'Idempotency-Key':key,'X-Correlation-Id':randomUUID(),'X-CSRF-Token':session.csrfToken,Origin:base};}
async function api(u,path,body,status=200,key=randomUUID()){const r=await u.page.request.fetch(base+'/api/v1'+path,{method:body?'POST':'GET',headers:body?{...await headers(u,key),'Content-Type':'application/json'}:{},...(body?{data:body}:{})});const value=await r.json();assert.equal(r.status(),status,JSON.stringify(value));return value;}
const expected=t=>({expectedDigest:t.contentDigest,expectedRevision:t.revision}),ref=t=>({templateId:t.id,version:t.version,contentDigest:t.contentDigest});
async function upload(u,t,buffer,status=202,key=randomUUID(),extra={},name='企业台账.csv'){const r=await u.page.request.post(base+'/api/v1/data-imports',{headers:await headers(u,key),multipart:{file:{name,mimeType:name.endsWith('.xlsx')?'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':'text/csv',buffer:Buffer.from(buffer)},dataType:'DEVICE',templateVersion:'1.0.0',sourceSystem:'manual-excel',...(t?{mappingRef:JSON.stringify(ref(t))}:{}),...extra}});const value=await r.json();assert.equal(r.status(),status,JSON.stringify(value));return value;}
const approve=(u,b,status=202,key=randomUUID())=>api(u,`/data-imports/${b.batchId}/approval`,{decision:'APPROVED',comment:'独立核查原文件与冻结映射',reviewResolution:'人工逐行复核来源、编码和台账，不代表健康评估',expectedVersion:b.version,snapshotDigest:b.snapshotDigest},status,key);
const csv='原始记录编号, 设备编号 ,设备名称,工厂编码,产线编码,设备类型\r\np1,PUMP-01,"循环\n水泵",FACTORY-02,UTILITY-01,泵组\r\nc1,COMP-01,空压机,FACTORY-03,UTILITY-02,空压机';
try{
 assert.equal(await new Promise(r=>{const s=net.connect(4050,'127.0.0.1');s.once('connect',()=>{s.destroy();r(true);});s.once('error',()=>r(false));}),false,'QA port occupied; do not displace current owner');
 await mkdir(directory,{recursive:true});await mkdir('outputs/demo-preview',{recursive:true});await admin.connect();
 for(const tenant of ['acme','sandbox']){
  const name='idms_mapqa_'+tenant+'_'+suffix,a={database:name,user:name,password:randomBytes(32).toString('base64url'),roleCreated:false,databaseCreated:false};accounts.push(a);
  await admin.query(`CREATE ROLE "${name}" LOGIN PASSWORD '${a.password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`);a.roleCreated=true;
  await admin.query(`CREATE DATABASE "${name}" OWNER "${name}"`);a.databaseCreated=true;
  await admin.query(`REVOKE CONNECT ON DATABASE "${name}" FROM PUBLIC`);await admin.query(`GRANT CONNECT ON DATABASE "${name}" TO "${name}"`);config.tenants[tenant]={database:a.database,user:a.user,password:a.password};
 }
 await writePrivate(join(directory,'postgres.json'),JSON.stringify(await migrateQaDatabases(config,database)));
 const token=await adminToken(identity),web=(await adminApi(identity,token,'idms/clients?clientId=idms-web'))[0],mappers=await adminApi(identity,token,`idms/clients/${web.id}/protocol-mappers/models`);
 await adminApi(identity,token,'idms/clients','POST',{clientId,enabled:true,publicClient:true,fullScopeAllowed:false,standardFlowEnabled:true,directAccessGrantsEnabled:false,implicitFlowEnabled:false,protocol:'openid-connect',redirectUris:[base+'/api/v1/auth/callback'],attributes:{'pkce.code.challenge.method':'S256'},protocolMappers:mappers.map(({id,...m})=>m)});clientIdInternal=(await adminApi(identity,token,'idms/clients?clientId='+clientId))[0].id;await adminApi(identity,token,`idms/clients/${clientIdInternal}/scope-mappings/realm`,'POST',await adminApi(identity,token,`idms/clients/${web.id}/scope-mappings/realm`));
 const designer=await user('designer',['tenant-admin','data-uploader','final-approver']),reviewer=await user('reviewer',['final-approver']),foreign=await user('foreign',['tenant-admin','data-uploader'],'sandbox');
 await start();browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});for(const u of users)await login(u);
 sql=new pg.Client(qaAdminAccount(database,config.tenants.acme));await sql.connect();
 // Author and independently publish through the actual website.
 await designer.page.locator('[data-action=catalog-mapping-new]').click();await designer.page.locator('[data-action=catalog-save]').click();await idle(designer);
 let t=(await api(designer,'/templates')).items.find(t=>t.templateKey==='import-map-assets');assert.ok(t);assert.equal(t.runtimeApplicable,true);
 await designer.page.locator(`#template-${t.id} [data-action=catalog-submit]`).click();await idle(designer);t=(await api(designer,'/templates')).items.find(x=>x.id===t.id);
 await api(designer,`/templates/${t.id}/approval`,{...expected(t),decision:'APPROVED',comment:'拒绝作者自审'},403);
 await reviewer.page.reload();await idle(reviewer);await reviewer.page.locator(`#template-${t.id} [name=comment]`).fill('独立核查映射范围、字段和来源');await reviewer.page.locator(`#template-${t.id} [data-action=catalog-approve]`).click();await idle(reviewer);t=(await api(reviewer,'/templates')).items.find(x=>x.id===t.id);assert.equal(t.status,'PUBLISHED');
 await reviewer.page.locator('#catalog-purpose').selectOption('import-mapping');assert.equal(await reviewer.page.locator('.catalog-item:visible').count(),1);
 const pack=await api(reviewer,`/templates/${t.id}/export`),imported=await api(foreign,'/templates/import',pack);assert.equal(imported.status,'DRAFT');await upload(foreign,t,csv,404);await upload(foreign,imported,csv,409);await upload(designer,t,csv,409,randomUUID(),{sourceSystem:'other'});await upload(designer,t,csv,409,randomUUID(),{dataType:'MEASUREMENT'});
 // Real CSV file selection with Chinese/spaced headers and multiline data.
 await designer.page.locator('.sidebar [data-view=uploads]').click();await designer.page.locator('#import-mapping').selectOption(t.id);
 const received=designer.page.waitForResponse(r=>r.url().endsWith('/api/v1/data-imports')&&r.request().method()==='POST');await designer.page.locator('#file-upload').setInputFiles({name:'企业多设备.csv',mimeType:'text/csv',buffer:Buffer.from(csv)});const first=await (await received).json();assert.equal(first.status,'HUMAN_REVIEW');await idle(designer);
 assert.equal(first.sourceHeaders[1],' 设备编号 ');assert.equal(first.preview[0].device_code,'PUMP-01');assert.ok((await designer.page.locator('.import-drawer').innerText()).includes('冻结字段映射'));assert.equal((await api(reviewer,'/data-management/overview')).summary.devices,0);await approve(designer,first,403);await designer.page.evaluate(()=>scrollTo(0,0));await designer.page.screenshot({path:'outputs/demo-preview/41-mapping-batch-evidence.png',fullPage:false});
 const key=randomUUID(),pendingCsv=csv.replaceAll('p1','p3').replaceAll('PUMP-01','PUMP-03').split('\r\nc1')[0],pending=await upload(designer,t,pendingCsv,202,key);
 const next={templateKey:t.templateKey,version:'1.1.0',industry:t.industry,parent:t.templateKey+'@1.0.0',manifest:structuredClone(t.manifest)};next.manifest.importMapping.columns.find(c=>c.targetField==='device_name').sourceColumn='设备名';let newer=await api(designer,'/templates',next);newer=await api(designer,`/templates/${newer.id}/submit`,expected(newer));newer=await api(reviewer,`/templates/${newer.id}/approval`,{...expected(newer),decision:'APPROVED',comment:'独立发布新表头版本'});
 assert.equal((await upload(designer,t,pendingCsv,202,key)).batchId,pending.batchId);await upload(designer,t,pendingCsv,409);await upload(designer,newer,pendingCsv,409,key);
 // Force a real SQL failure; approval, audit, idempotency and projections must all roll back.
 const before=canonical((await sql.query('SELECT payload FROM runtime_state')).rows[0].payload),ledger=Number((await sql.query('SELECT count(*) FROM audit_ledger')).rows[0].count),approveKey=randomUUID();
 await sql.query("CREATE FUNCTION qa_deny_mapping() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'QA mapped projection failure'; END $$; CREATE TRIGGER qa_mapping_failure BEFORE INSERT ON managed_assets FOR EACH ROW EXECUTE FUNCTION qa_deny_mapping()");
 await approve(reviewer,first,500,approveKey);assert.equal(canonical((await sql.query('SELECT payload FROM runtime_state')).rows[0].payload),before);assert.equal(Number((await sql.query('SELECT count(*) FROM audit_ledger')).rows[0].count),ledger);assert.equal(Number((await sql.query('SELECT count(*) FROM managed_import_rows')).rows[0].count),0);
 await sql.query('DROP TRIGGER qa_mapping_failure ON managed_assets; DROP FUNCTION qa_deny_mapping()');await approve(reviewer,first,202,approveKey);await approve(reviewer,pending);
 const sourceRows=(await sql.query('SELECT source_row FROM managed_import_rows WHERE batch_id=$1 ORDER BY ordinal',[first.batchId])).rows.map(r=>r.source_row);assert.deepEqual(sourceRows,[2,4]);
 const original=await reviewer.page.request.get(base+`/api/v1/data-imports/${first.batchId}/original`);assert.equal((await original.body()).toString(),csv);
 // XLSX uses exactly the same binding and parser safety rules.
 const workbook=new ExcelJS.Workbook(),sheet=workbook.addWorksheet('data');sheet.addRow(['原始记录编号','设备编号','设备名','工厂编码','产线编码','设备类型']);sheet.addRow(['c4','COMP-04','<img src=x onerror=alert(1)>','FACTORY-03','UTILITY-02','空压机']);const xlsx=await workbook.xlsx.writeBuffer(),latest=await upload(designer,newer,xlsx,202,randomUUID(),{},'企业台账.xlsx');await approve(reviewer,latest);
 sheet.getRow(2).getCell(3).value={formula:'1+1',result:2};await upload(designer,newer,await workbook.xlsx.writeBuffer(),400,randomUUID(),{},'公式.xlsx');
 await upload(designer,null,csv,400);
 const unknownCsv=csv.replace('设备名称','设备名').replace('设备类型\r\n','设备类型,未映射列\r\n').replace('泵组\r\n','泵组,x\r\n')+',x';
 assert.match((await upload(designer,newer,unknownCsv,400)).error,/未配置映射/);await upload(designer,newer,'设备编号,设备名\np,P',400);
 await api(designer,'/data-imports/records',{dataType:'DEVICE',templateVersion:'1.0.0',sourceSystem:'manual-excel',records:[],mappingRef:ref(newer)},400);
 const invalid=await upload(designer,newer,pendingCsv.replace('设备名称','设备名').replace('PUMP-03','非法 空格'));assert.equal(invalid.status,'VALIDATION_FAILED');assert.ok(invalid.errors.some(e=>e.sourceField==='设备编号'));const exportedErrors=await designer.page.request.get(base+`/api/v1/data-imports/${invalid.batchId}/errors?format=csv`);assert.ok((await exportedErrors.text()).includes('sourceField'));
 await stop();await start();await login(reviewer);const frozen=await api(reviewer,'/data-imports/'+first.batchId);assert.equal(frozen.mappingBinding.version,'1.0.0');assert.equal(frozen.status,'COMMITTED');assert.equal((await api(reviewer,'/data-management/overview')).summary.devices,4);assert.equal((await api(reviewer,'/audit')).chainValid,true);
 await reviewer.page.goto(base+'/?view=uploads');await idle(reviewer);await reviewer.page.locator('[data-action=batch][data-id="'+latest.batchId+'"]').click();assert.equal(await reviewer.page.locator('.import-drawer img').count(),0);await reviewer.page.locator('.drawer-head [data-action=close]').click();
 await reviewer.page.locator('#import-mapping').selectOption(newer.id);await reviewer.page.evaluate(()=>scrollTo(0,0));await reviewer.page.screenshot({path:'outputs/demo-preview/42-mapping-upload-desktop.png',fullPage:true});for(const width of [390,320]){await reviewer.page.setViewportSize({width,height:844});await reviewer.page.evaluate(()=>scrollTo(0,0));assert.equal(await reviewer.page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);}await reviewer.page.screenshot({path:'outputs/demo-preview/43-mapping-upload-mobile.png',fullPage:true});
 // Corruption test is restricted to this owned synthetic QA database.
 await stop();const healthy=(await sql.query('SELECT payload FROM runtime_state')).rows[0].payload,corrupt=structuredClone(healthy);corrupt.imports.batches.find(b=>b.batchId===first.batchId).mappingBinding.version='9.0.0';await sql.query("UPDATE business_import_batches SET body=jsonb_set(body,'{mappingBinding,version}','\"9.0.0\"') WHERE batch_id=$1",[first.batchId]);await assert.rejects(start(),/企业冷读取完整来源校验失败/);await stop();const metadata={...healthy.imports.batches.find(b=>b.batchId===first.batchId)};delete metadata.rows;delete metadata.validRows;delete metadata.originalBase64;await sql.query('UPDATE business_import_batches SET body=$2 WHERE batch_id=$1',[first.batchId,metadata]);await start();await login(reviewer);assert.equal((await api(reviewer,'/audit')).chainValid,true);assert.deepEqual(errors,[]);
 await writeFile('outputs/import-mapping-verification.json',JSON.stringify({verifiedAt:new Date().toISOString(),namespace,syntheticDataOnly:true,actualOidcPostgres:true,independentTemplatePublicationAndBatchApproval:true,chineseCsvAndXlsx:true,originalHeadersAndPhysicalRows:true,originalFileDownload:true,retiredMappingPendingApprovalAndIdempotentReplay:true,newMappingVersionParallel:true,crossTenantTypeAndSourceBlocked:true,sqlFailureRollsBackApprovalAuditIdempotencyProjection:true,jsonMappingRejected:true,xlsxFormulaBlocked:true,unknownAndMissingColumnsBlocked:true,sourceFieldErrorsExport:true,restartPersistence:true,corruptBindingBlocksStartup:true,xssEscaped:true,mobile320And390NoOverflow:true,pageErrors:errors,productionAcceptance:false},null,2));console.log('Mapping verification passed: independent approval, CSV/XLSX, version freeze, SQL rollback, restart/corruption, isolation and browser checks');
}finally{
 await browser?.close();await stop();await sql?.end();
 const token=await adminToken(identity);for(const u of users){assert.ok(u.username.startsWith('mapqa-'+suffix+'-'));await adminApi(identity,token,'idms/users/'+u.id,'DELETE');}if(clientIdInternal)await adminApi(identity,token,'idms/clients/'+clientIdInternal,'DELETE');
 for(const a of accounts){assert.match(a.database,new RegExp('^idms_mapqa_(acme|sandbox)_'+suffix+'$'));if(a.databaseCreated)await admin.query(`DROP DATABASE "${a.database}" WITH (FORCE)`);if(a.roleCreated)await admin.query(`DROP ROLE "${a.user}"`);}await cleanupQaRoles(admin,config);await admin.end();await unlink(join(directory,'postgres.json')).catch(e=>{if(e.code!=='ENOENT')throw e;});
}
