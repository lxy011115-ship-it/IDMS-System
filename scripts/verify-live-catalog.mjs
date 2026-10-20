import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import pg from 'pg';
import {chromium} from 'playwright';
import {localConfig,adminToken,adminApi} from './keycloak-local.mjs';

// Only authentication audit events may be added to the live tenant. All business
// endpoints are GETs; template publication and work orders belong in isolated QA.
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
assert.deepEqual(await businessState(),baseline,'Business state differs from pre-upgrade baseline; do not replace the baseline');
const identity=await localConfig(),username='qa-live-catalog-'+randomUUID(),password='Qa9-'+randomBytes(24).toString('base64url');
let browser,userId;
const errors=[];
try{
  const token=await adminToken(identity);
  await adminApi(identity,token,'idms/users','POST',{username,enabled:true,firstName:'模板只读验证',lastName:'QA',email:username+'@idms.invalid',emailVerified:true,attributes:{tenant_id:['acme'],idms_sites:[' * '],idms_lines:[' * '],idms_devices:[' * ']},credentials:[{type:'password',value:password,temporary:false}]});
  userId=(await adminApi(identity,token,'idms/users?username='+username+'&exact=true'))[0].id;
  await adminApi(identity,token,`idms/users/${userId}/role-mappings/realm`,'POST',[await adminApi(identity,token,'idms/roles/auditor')]);
  browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
  const page=await browser.newPage({viewport:{width:1440,height:1000}});
  page.on('pageerror',error=>errors.push(error.message));
  await page.goto(base+'/?view=templates');
  await page.getByTestId('oidc-login').click();
  await page.locator('#username').fill(username);
  await page.locator('#password').fill(password);
  await page.locator('#kc-login').click();
  await page.getByTestId('verified-identity').waitFor();
  await page.waitForFunction(()=>!document.querySelector('.busy-line'));
  async function api(path){const response=await page.request.get(base+'/api/v1'+path);assert.equal(response.status(),200,path);return response.json();}
  const session=await api('/auth/session');
  assert.equal(session.user.tenantId,'acme');
  assert.ok(session.user.roles.includes('auditor'));
  assert.deepEqual(session.user.permissions,['read']);
  const templates=await api('/templates'),plugins=await api('/plugins'),roles=await api('/roles');
  assert.deepEqual(roles.runtimeRolePermissions['system-admin'],['read']);
  assert.deepEqual(roles.runtimeRolePermissions['tenant-admin'],['read','template:edit','template:submit','plugin:submit']);
  assert.ok(roles.runtimeRolePermissions['platform-certifier'].includes('plugin:certify'));
  assert.ok(!roles.runtimeRolePermissions['tenant-admin'].includes('plugin:certify'));
  for(const plugin of plugins.items){
    assert.equal(plugin.runtimeEnabled,false);
    assert.equal(plugin.artifactVerified,false);
    assert.equal(typeof plugin.verification.valid,'boolean');
    assert.equal(plugin.signed,plugin.verification.valid);
  }
  for(const template of templates.items){
    if(!template.validated)assert.equal(template.runtimeApplicable,false);
    if(template.runtimeApplicable)assert.equal(template.templateKey,'maintenance-form');
  }
  await page.getByRole('heading',{name:'插件清单安全状态'}).waitFor();
  assert.equal(await page.locator('[data-action=catalog-new]').count(),0);
  assert.equal(await page.locator('[data-action=catalog-edit]').count(),0);
  assert.equal(await page.locator('[data-action=catalog-approve]').count(),0);
  assert.equal(await page.locator('#catalog-import').isDisabled(),true);
  assert.ok((await page.locator('.approval-notice').innerText()).includes('旧工单不追改'));
  await mkdir('outputs/demo-preview',{recursive:true});
  await page.screenshot({path:'outputs/demo-preview/34-live-templates-desktop.png',fullPage:true});
  await page.setViewportSize({width:390,height:844});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  const headerFits=await page.evaluate(()=>{
    const header=document.querySelector('header').getBoundingClientRect();
    return [...document.querySelectorAll('header .verified-identity,header [data-action=logout]')].every(node=>{
      const box=node.getBoundingClientRect();
      return box.top>=header.top&&box.bottom<=header.bottom&&box.left>=header.left&&box.right<=header.right;
    });
  });
  assert.equal(headerFits,true,'Long verified identities and logout must stay inside the mobile header');
  await page.screenshot({path:'outputs/demo-preview/35-live-templates-mobile.png',fullPage:true});
  await page.locator('.mobile-nav [data-view=roles]').click();
  await page.getByRole('heading',{name:'当前实际执行的权限'}).waitFor();
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await page.screenshot({path:'outputs/demo-preview/36-live-template-roles-mobile.png',fullPage:true});
  assert.equal((await api('/audit')).chainValid,true);
  assert.equal((await api('/data-imports')).total,baseline.acme.batches);
  assert.equal((await api('/work-orders')).total,baseline.acme.workOrders);
  assert.deepEqual(errors,[]);
  await page.locator('[data-action=logout]').click();
  await page.getByTestId('oidc-login').waitFor();
  assert.deepEqual(await businessState(),baseline,'Read-only live verification must not alter business data');
  const evidence={verifiedAt:new Date().toISOString(),url:base+'/?view=templates',actualOidcWebsite:true,auditorReadOnlyUi:true,currentRuntimeRoleSeparation:true,unvalidatedTemplatesNotRuntimeApplicable:true,pluginArtifactAndExecutionBlocked:true,originalBusinessAndImportDigestsUnchanged:true,acmeBatches:baseline.acme.batches,acmeWorkOrders:baseline.acme.workOrders,auditChain:true,desktopAndMobileNoOverflow:true,pageErrors:errors,syntheticBusinessWritten:false,productionAcceptance:false};
  await writeFile('outputs/live-catalog-verification.json',JSON.stringify(evidence,null,2));
  console.log(JSON.stringify(evidence,null,2));
}finally{
  await browser?.close();
  if(userId){assert.ok(username.startsWith('qa-live-catalog-'));await adminApi(identity,await adminToken(identity),`idms/users/${userId}`,'DELETE');}
}
