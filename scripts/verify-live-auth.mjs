import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { chromium } from 'playwright';
import { localConfig, adminApi, adminToken } from './keycloak-local.mjs';
const base='http://127.0.0.1:4010', baselineFile='.local/auth-upgrade-baseline.json';
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
async function databaseState(){
  const config=JSON.parse(await readFile('.local/postgres-runtime.json','utf8')),result={};
  for(const [tenant,account] of Object.entries(config.tenants)){
    const connection=new pg.Client({host:config.host,port:config.port,...account});await connection.connect();
    try{const payload=(await connection.query('SELECT payload FROM runtime_state WHERE singleton=true')).rows[0].payload;result[tenant]={importsDigest:hash(payload.imports),businessDigest:hash(payload.business),batches:payload.imports.batches.length,workOrders:payload.business.workOrders.length};}finally{await connection.end();}
  }
  return result;
}
if(process.argv[2]==='capture'){
  const baseline=await databaseState();await writeFile(baselineFile,JSON.stringify(baseline));console.log(JSON.stringify({captured:true,tenantCounts:Object.fromEntries(Object.entries(baseline).map(([tenant,s])=>[tenant,{batches:s.batches,workOrders:s.workOrders}]))}));
}else{
  const baseline=JSON.parse(await readFile(baselineFile,'utf8'));assert.deepEqual(await databaseState(),baseline,'Business data changed during authentication upgrade');
  const config=await localConfig(),token=await adminToken(config),username='qa-live-audit-'+randomUUID(),password='Live9-'+randomBytes(24).toString('base64url');
  let userId,browser;
  try{
    const health=await (await fetch(base+'/api/v1/health')).json();assert.equal(health.authentication,'oidc');assert.equal(health.storage,'postgres-tenant-databases');
    assert.equal((await fetch(base+'/api/v1/data-imports',{headers:{'X-Tenant-Id':'acme','X-Actor-Id':'demo.approver'}})).status,401);
    await adminApi(config,token,'idms/users','POST',{username,enabled:true,firstName:'运行验证',lastName:'QA',email:username+'@idms.invalid',emailVerified:true,attributes:{tenant_id:['acme'],idms_sites:[' * '],idms_lines:[' * '],idms_devices:[' * ']},credentials:[{type:'password',value:password,temporary:false}]});
    userId=(await adminApi(config,token,`idms/users?username=${username}&exact=true`))[0].id;
    await adminApi(config,token,`idms/users/${userId}/role-mappings/realm`,'POST',[await adminApi(config,token,'idms/roles/auditor')]);
    browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.goto(base+'/?view=predictive');await page.getByTestId('oidc-login').click();await page.locator('#username').fill(username);await page.locator('#password').fill(password);await page.locator('#kc-login').click();await page.getByTestId('verified-identity').waitFor();await page.waitForFunction(()=>!document.querySelector('.busy-line'));
    const imports=await (await page.request.get(base+'/api/v1/data-imports')).json();assert.equal(imports.total,baseline.acme.batches);
    const audit=await (await page.request.get(base+'/api/v1/audit')).json();assert.equal(audit.chainValid,true);assert.ok(audit.items.some(e=>e.action==='AUTH_LOGIN'&&e.actorId===userId));
    assert.equal(await page.locator('#actor-select').count(),0);assert.deepEqual(errors,[]);
    await page.locator('[data-action=logout]').click();await page.getByTestId('oidc-login').waitFor();await page.screenshot({path:'outputs/demo-preview/16-live-login.png',fullPage:true});
    assert.deepEqual(await databaseState(),baseline,'Login/logout must not rewrite imports, work orders or business records');
    const result={url:base+'/?view=predictive',actualWebsiteOidc:true,actualWebsitePostgres:true,originalBusinessDataUnchanged:true,acmeBatchCount:baseline.acme.batches,realLoginLogoutAudit:true,auditChain:true,pageErrors:0};await writeFile('outputs/live-auth-verification.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
  }finally{if(browser)await browser.close();if(userId){assert.ok(username.startsWith('qa-live-audit-'));await adminApi(config,await adminToken(config),`idms/users/${userId}`,'DELETE');}}
}
