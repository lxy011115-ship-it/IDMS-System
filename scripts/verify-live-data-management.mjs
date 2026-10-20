import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import pg from 'pg';
import {chromium} from 'playwright';
import {localConfig,adminToken,adminApi} from './keycloak-local.mjs';

// Business access is strictly GET-only. The temporary identity is removed below.
const base='http://127.0.0.1:4010';
const baseline=JSON.parse(await readFile('.local/ai-upgrade-baseline.json','utf8'));
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
async function businessState(){
  const config=JSON.parse(await readFile('.local/postgres-runtime.json','utf8')),state={};
  for(const [id,account] of Object.entries(config.tenants)){
    const connection=new pg.Client({host:config.host,port:config.port,...account});
    await connection.connect();
    try{
      const payload=(await connection.query('SELECT payload FROM runtime_state')).rows[0].payload;
      state[id]={importsDigest:hash(payload.imports),businessDigest:hash(payload.business),batches:payload.imports.batches.length,workOrders:payload.business.workOrders.length};
    }finally{await connection.end();}
  }
  return state;
}
assert.deepEqual(await businessState(),baseline,'Original business data changed; do not overwrite the baseline');
const identity=await localConfig(),username='qa-live-data-'+randomUUID(),password='Qa9-'+randomBytes(24).toString('base64url');
let browser,userId;const errors=[];
try{
  const token=await adminToken(identity);
  await adminApi(identity,token,'idms/users','POST',{username,enabled:true,firstName:'设备数据只读验证',lastName:'QA',email:username+'@idms.invalid',emailVerified:true,attributes:{tenant_id:['acme'],idms_sites:[' * '],idms_lines:[' * '],idms_devices:[' * ']},credentials:[{type:'password',value:password,temporary:false}]});
  userId=(await adminApi(identity,token,'idms/users?username='+username+'&exact=true'))[0].id;
  await adminApi(identity,token,`idms/users/${userId}/role-mappings/realm`,'POST',[await adminApi(identity,token,'idms/roles/auditor')]);
  browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
  const page=await browser.newPage({viewport:{width:1440,height:1000}});
  async function headerFits(){assert.equal(await page.evaluate(()=>{const header=document.querySelector('header').getBoundingClientRect();return [...document.querySelectorAll('header .verified-identity,header [data-action=logout],header .verified-identity b,header .verified-identity small')].every(n=>{const b=n.getBoundingClientRect();return b.top>=header.top&&b.bottom<=header.bottom&&b.left>=header.left&&b.right<=header.right;});}),true,'Verified identity text and logout must fit the header');}
  page.on('pageerror',error=>errors.push(error.message));
  await page.goto(base+'/?view=data-center');await page.getByTestId('oidc-login').click();
  await page.locator('#username').fill(username);await page.locator('#password').fill(password);await page.locator('#kc-login').click();
  await page.getByTestId('verified-identity').waitFor();await page.getByRole('heading',{name:'设备档案',exact:true}).waitFor();
  await page.waitForFunction(()=>!document.querySelector('.busy-line'));
  async function api(path){const response=await page.request.get(base+'/api/v1'+path);assert.equal(response.status(),200,path);return response.json();}
  assert.equal(await page.locator('[role=alert]').count(),0,'The live page must not hide a failed API request');
  assert.equal((await api('/health')).dataManagementQueries,'typed-sql-read-model');
  assert.equal((await api('/health')).sessionStorage,'POSTGRES_ENCRYPTED');assert.equal((await api('/health')).dataReadIsolation,'verified-mvcc-repeatable-read-v1');
  assert.equal((await api('/health')).dataImportMappings,'published-file-mapping-v1');assert.equal((await api('/health')).equipmentProfiles,'frozen-inherited-equipment-profile-v1');assert.equal((await api('/health')).businessPersistence,'normalized-entities-v3');assert.equal((await api('/health')).crossInstanceTransactions,true);
  assert.deepEqual((await api('/auth/session')).user.permissions,['read']);
  const assets=await api('/data-management/overview'),measurements=await api('/data-management/measurements');
  const imports=await api('/data-imports?pageSize=100');
  assert.equal(imports.total,baseline.acme.batches);
  assert.equal(assets.summary.devices,imports.items.filter(b=>b.dataType==='DEVICE'&&b.status==='COMMITTED').reduce((n,b)=>n+b.counts.committed,0));
  assert.equal(measurements.total,assets.summary.measurements);
  assert.equal(await page.locator('[data-action=data-point-upload]').count(),0);
  await mkdir('outputs/demo-preview',{recursive:true});
  await headerFits();
  await page.evaluate(()=>scrollTo(0,0));await page.screenshot({path:'outputs/demo-preview/39-live-data-center-desktop.png',fullPage:true});
  for(const width of [390,320]){
    await page.setViewportSize({width,height:844});await page.evaluate(()=>scrollTo(0,0));
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    await headerFits();
  }
  await page.screenshot({path:'outputs/demo-preview/40-live-data-center-mobile.png',fullPage:true});
  await page.locator('.mobile-nav [data-view=uploads]').click();
  await page.waitForFunction(()=>!document.querySelector('.busy-line'));assert.equal(await page.locator('#import-mapping').count(),1);
  assert.ok((await page.locator('main').innerText()).includes('7类标准模板'));
  const downloadEvent=page.waitForEvent('download');await page.locator('[data-action=device-extended-sample]').click();
  const download=await downloadEvent;assert.equal(await download.failure(),null);assert.equal(download.suggestedFilename(),'devices-extended.csv');
  const extended=await page.request.get(base+'/api/v1/data-import-templates/DEVICE?sample=1&profile=extended');assert.equal(extended.status(),200);assert.ok((await extended.text()).includes('equipment_type'));
  const points=await page.request.get(base+'/api/v1/data-import-templates/POINT_DEFINITION');assert.equal(points.status(),200);assert.ok((await points.text()).includes('expected_interval_seconds'));
  await page.locator('.mobile-nav [data-view=guide]').click();await page.getByRole('heading',{name:'多设备数据管理使用顺序'}).waitFor();
  assert.equal(await page.locator('[role=alert]').count(),0);assert.deepEqual(errors,[]);
  assert.equal((await api('/audit')).chainValid,true);assert.equal((await api('/work-orders')).total,baseline.acme.workOrders);
  await page.goto(base+'/?view=data-quality');await page.getByRole('heading',{name:'测点数据质量',exact:true}).waitFor();await page.waitForFunction(()=>!document.querySelector('.busy-line'));
  const quality=await api('/data-management/quality');assert.equal(quality.source,'APPROVED_EFFECTIVE_UPLOADS');assert.equal(quality.summary.devices,assets.summary.devices);assert.equal(await page.locator('[role=alert]').count(),0);await page.setViewportSize({width:1440,height:1000});await page.evaluate(()=>scrollTo(0,0));await page.screenshot({path:'outputs/demo-preview/45-live-quality-desktop.png',fullPage:false});for(const width of [390,320]){await page.setViewportSize({width,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await headerFits();}await page.screenshot({path:'outputs/demo-preview/46-live-quality-mobile.png',fullPage:false});
  await page.goto(base+'/?view=equipment-profiles');await page.getByRole('heading',{name:'导入设备类型包',exact:true}).waitFor();await page.waitForFunction(()=>!document.querySelector('.busy-line'));assert.equal((await api('/equipment-profiles')).total,0);assert.equal(await page.locator('[data-action=profile-new]').count(),0);assert.equal(await page.locator('#profile-asset-form').count(),0);assert.equal(await page.locator('[role=alert]').count(),0);await page.setViewportSize({width:1440,height:1000});await page.evaluate(()=>scrollTo(0,0));await page.screenshot({path:'outputs/demo-preview/49-live-equipment-profiles-desktop.png',fullPage:false});for(const width of [390,320]){await page.setViewportSize({width,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await headerFits();}await page.screenshot({path:'outputs/demo-preview/50-live-equipment-profiles-mobile.png',fullPage:false});
  const connections=await api('/integrations');for(const id of ['database','identity','workflow','ot','ai'])assert.ok(['CONNECTED','CONFIGURED'].includes(connections.items.find(i=>i.id===id).status),id+' not connected/configured');
  await page.locator('[data-action=logout]').click();await page.getByTestId('oidc-login').waitFor();
  assert.deepEqual(await businessState(),baseline,'Read-only verification changed business data');
  const database=JSON.parse(await readFile('.local/postgres-runtime.json','utf8')),connection=new pg.Client({host:database.host,port:database.port,...database.tenants.acme});await connection.connect();
  try{
    const payload=(await connection.query('SELECT payload FROM runtime_state')).rows[0].payload;
    assert.equal(Number((await connection.query('SELECT count(*) FROM managed_import_rows')).rows[0].count),payload.imports.records.length);
    assert.equal(Number((await connection.query('SELECT count(*) FROM managed_assets')).rows[0].count),assets.summary.devices);
    assert.equal(Number((await connection.query('SELECT count(*) FROM managed_measurements')).rows[0].count),assets.summary.measurements);
  }finally{await connection.end();}
  const evidence={verifiedAt:new Date().toISOString(),url:base+'/?view=data-center',actualOidcWebsite:true,sharedEncryptedOidcSessionStorage:true,verifiedMvccReadIsolation:true,normalizedEntityPersistenceV3:true,equipmentProfilesReadOnlyCurrentRuntime:true,originalTenantHasNoSyntheticTypes:true,qualityWorkbenchAndWindowRules:true,coreWorkflowTelemetryAndAiConnected:true,readOnlyDataCenter:true,typedSqlReadModelAndSourceRowCounts:true,publishedFileMappingRuntimeAndSelector:true,approvedAssetsOnly:true,extendedTemplateBrowserDownload:true,sevenUploadTypes:true,originalBusinessAndImportDigestsUnchanged:true,acmeBatches:baseline.acme.batches,acmeWorkOrders:baseline.acme.workOrders,auditChain:true,mobile320And390NoOverflow:true,pageErrors:errors,syntheticBusinessWritten:false,productionAcceptance:false};
  await writeFile('outputs/live-data-management-verification.json',JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence,null,2));
}finally{
  await browser?.close();
  if(userId){assert.ok(username.startsWith('qa-live-data-'));await adminApi(identity,await adminToken(identity),`idms/users/${userId}`,'DELETE');}
}
