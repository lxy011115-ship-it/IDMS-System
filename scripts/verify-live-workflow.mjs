import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { chromium } from 'playwright';
import { localConfig, adminApi, adminToken } from './keycloak-local.mjs';

const base='http://127.0.0.1:4010',baselineFile='.local/workflow-upgrade-baseline.json';
const hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
async function businessState(){
  const c=JSON.parse(await readFile('.local/postgres-runtime.json','utf8')),state={};
  for(const [id,account] of Object.entries(c.tenants)){
    const sql=new pg.Client({host:c.host,port:c.port,...account});await sql.connect();
    try{const p=(await sql.query('SELECT payload FROM runtime_state')).rows[0].payload;state[id]={importsDigest:hash(p.imports),businessDigest:hash(p.business),batches:p.imports.batches.length,workOrders:p.business.workOrders.length};}finally{await sql.end();}
  }
  return state;
}
if(process.argv[2]==='capture'){
  const baseline=await businessState();await writeFile(baselineFile,JSON.stringify(baseline));console.log(JSON.stringify({captured:true,tenantCounts:Object.fromEntries(Object.entries(baseline).map(([id,s])=>[id,{batches:s.batches,workOrders:s.workOrders}]))}));
}else{
  const baseline=JSON.parse(await readFile(baselineFile,'utf8'));assert.deepEqual(await businessState(),baseline,'Upgrade must not rewrite existing business records');
  const c=await localConfig(),username='qa-live-wf-'+randomUUID(),password='Live9-'+randomBytes(24).toString('base64url');let userId,browser;
  try{
    const token=await adminToken(c);await adminApi(c,token,'idms/users','POST',{username,enabled:true,firstName:'流程运行验证',lastName:'QA',email:username+'@idms.invalid',emailVerified:true,attributes:{tenant_id:['acme'],idms_sites:[' * '],idms_lines:[' * '],idms_devices:[' * ']},credentials:[{type:'password',value:password,temporary:false}]});
    userId=(await adminApi(c,token,`idms/users?username=${username}&exact=true`))[0].id;await adminApi(c,token,`idms/users/${userId}/role-mappings/realm`,'POST',[await adminApi(c,token,'idms/roles/auditor')]);
    const health=await(await fetch(base+'/api/v1/health')).json();assert.equal(health.authentication,'oidc');assert.equal(health.storage,'postgres-tenant-databases');
    browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.goto(base+'/?view=work-orders');await page.getByTestId('oidc-login').click();await page.locator('#username').fill(username);await page.locator('#password').fill(password);await page.locator('#kc-login').click();await page.getByTestId('verified-identity').waitFor();await page.waitForFunction(()=>!document.querySelector('.busy-line'));
    const api=async path=>{const r=await page.request.get(base+'/api/v1'+path);assert.equal(r.status(),200);return r.json();};
    const status=await api('/workflow/status');assert.equal(status.connected,true);assert.equal(status.version,'7.2.0');
    const integrations=await api('/integrations');assert.equal(integrations.items.find(i=>i.id==='workflow').status,'CONNECTED');
    const orders=await api('/work-orders');assert.equal(orders.total,baseline.acme.workOrders);
    for(const o of orders.items.filter(o=>!o.workflow)){const detail=await api(`/work-orders/${o.id}/workflow`);assert.equal(detail.mode,'LEGACY_LOCAL');}
    const audit=await api('/audit');assert.equal(audit.chainValid,true);assert.equal((await api('/data-imports')).total,baseline.acme.batches);
    const telemetry=await api('/telemetry/overview');assert.equal(telemetry.enabled,true);assert.equal(telemetry.brokerConnected,true);assert.equal(telemetry.subscribed,true);
    await page.screenshot({path:'outputs/demo-preview/24-live-workflow.png',fullPage:true});await page.locator('.sidebar [data-view=integrations]').click();await page.screenshot({path:'outputs/demo-preview/25-live-integrations.png',fullPage:true});
    assert.deepEqual(errors,[]);await page.locator('[data-action=logout]').click();await page.getByTestId('oidc-login').waitFor();assert.deepEqual(await businessState(),baseline);
    const result={url:base+'/?view=work-orders',actualWebsite:true,realOidc:true,flowableConnected:true,flowableVersion:status.version,legacyOrdersUnchanged:true,originalBusinessAndImportDigestsUnchanged:true,acmeBatchCount:baseline.acme.batches,acmeWorkOrderCount:orders.total,telemetryStillConnected:true,auditChain:true,pageErrors:0,productionAcceptance:false};
    await writeFile('outputs/live-workflow-verification.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
  }finally{if(browser)await browser.close();if(userId){assert.ok(username.startsWith('qa-live-wf-'));await adminApi(c,await adminToken(c),`idms/users/${userId}`,'DELETE');}}
}
