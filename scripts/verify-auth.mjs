import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { localConfig, adminApi, adminToken } from './keycloak-local.mjs';
const config=await localConfig(), base='http://127.0.0.1:4030', namespace='oidc-qa-'+randomUUID();
const issuer=config.origin+'/realms/idms', users=[], contexts=[], prefix='qa-'+randomUUID().slice(0,8);
const clientId='idms-auth-'+prefix;
let child,browser,createdClientId,token=await adminToken(config);
const result={namespace,realKeycloakVersion:config.version};
async function createUser(label,roles,tenant='acme',temporary=false){
  const user={username:prefix+'-'+label,password:'Qa9-'+randomBytes(24).toString('base64url'),roles,tenant};
  await adminApi(config,token,'idms/users','POST',{username:user.username,firstName:label,lastName:'QA',email:user.username+'@idms.invalid',emailVerified:true,enabled:true,attributes:{tenant_id:[tenant],idms_sites:[' * '],idms_lines:[' * '],idms_devices:[' * ']},requiredActions:temporary?['UPDATE_PASSWORD']:[],credentials:[{type:'password',value:user.password,temporary}]});
  user.id=(await adminApi(config,token,`idms/users?username=${user.username}&exact=true`))[0].id;users.push(user);
  const mapped=[];for(const role of roles)mapped.push(await adminApi(config,token,'idms/roles/'+role));
  await adminApi(config,token,`idms/users/${user.id}/role-mappings/realm`,'POST',mapped);return user;
}
async function start(){
  child=spawn(process.execPath,['server/index.ts'],{env:{...process.env,PORT:'4030',IDMS_STORAGE:'local',IDMS_DEMO_NAMESPACE:namespace,IDMS_AUTH_MODE:'oidc',IDMS_PUBLIC_ORIGIN:base,IDMS_OIDC_ISSUER:issuer,IDMS_OIDC_AUDIENCE:'idms-api',IDMS_OIDC_CLIENT_ID:clientId},windowsHide:true,stdio:['ignore','pipe','pipe']});
  let log='';child.stderr.on('data',b=>log+=b);
  for(let i=0;i<100;i++){if(child.exitCode!==null)throw Error('Test API exited: '+log);try{const r=await fetch(base+'/api/v1/health');if(r.ok){assert.equal((await r.json()).authentication,'oidc');return;}}catch{}await new Promise(r=>setTimeout(r,100));}throw Error('OIDC test API not ready');
}
async function stop(){if(child&&child.exitCode===null){const done=new Promise(r=>child.once('exit',r));child.kill();await done;}}
async function login(user,view='uploads',changePassword=false){
  const context=await browser.newContext({viewport:{width:1440,height:1000}});contexts.push(context);
  const page=await context.newPage();page.on('pageerror',e=>{result.pageErrors??=[];result.pageErrors.push(e.message);});
  await page.goto(base+'/?view='+view);await page.getByTestId('oidc-login').click();
  await page.locator('#username').fill(user.username);await page.locator('#password').fill(user.password);await page.locator('#kc-login').click();
  if(changePassword){await page.locator('#password-new').waitFor();user.password='New9-'+randomBytes(24).toString('base64url');await page.locator('#password-new').fill(user.password);await page.locator('#password-confirm').fill(user.password);await page.locator('button[type=submit],input[type=submit]').click();}
  await page.getByTestId('verified-identity').waitFor();await page.waitForFunction(()=>!document.querySelector('.busy-line'));
  assert.equal(await page.locator('#actor-select').count(),0);return {page,context,user};
}
async function session(client){const r=await client.page.request.get(base+'/api/v1/auth/session');assert.equal(r.status(),200);return r.json();}
async function api(client,path,{body,expected=200,headers={},csrf=true,origin=true}={}){
  const auth=await session(client);
  const response=await client.page.request.fetch(base+'/api/v1'+path,{method:body?'POST':'GET',headers:{...(body?{'Content-Type':'application/json','Idempotency-Key':randomUUID(),'X-Correlation-Id':randomUUID(),...(csrf?{'X-CSRF-Token':auth.csrfToken}:{}),...(origin?{Origin:base}:{})}:{}),...headers},...(body?{data:body}:{})});
  const value=await response.json();assert.equal(response.status(),expected,JSON.stringify(value));return value;
}
async function issueToken(user){
  // A separate real browser authorization-code/PKCE exchange tests Bearer APIs without enabling password grants.
  const context=await browser.newContext(),page=await context.newPage(),verifier=randomBytes(32).toString('base64url');
  const auth=new URL(issuer+'/protocol/openid-connect/auth');auth.search=new URLSearchParams({client_id:clientId,response_type:'code',scope:'openid profile',redirect_uri:base+'/api/v1/auth/callback',state:randomUUID(),nonce:randomUUID(),code_challenge:createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256'}).toString();
  await page.goto(auth.href);await page.locator('#username').fill(user.username);await page.locator('#password').fill(user.password);await page.locator('#kc-login').click();
  await page.waitForURL(base+'/api/v1/auth/callback*');
  // The BFF correctly rejects this independent test state, without consuming the authorization code.
  const callback=new URL(page.url()),code=callback.searchParams.get('code');assert.ok(code,'PKCE authorization failed: '+String(callback.searchParams.get('error')));
  const response=await fetch(issuer+'/protocol/openid-connect/token',{method:'POST',body:new URLSearchParams({grant_type:'authorization_code',client_id:clientId,code,code_verifier:verifier,redirect_uri:base+'/api/v1/auth/callback'})});
  assert.equal(response.status,200);const issued=await response.json();await context.close();return issued.access_token;
}
try{
  const web=(await adminApi(config,token,'idms/clients?clientId=idms-web'))[0];
  const mappers=await adminApi(config,token,`idms/clients/${web.id}/protocol-mappers/models`);
  await adminApi(config,token,'idms/clients','POST',{clientId,enabled:true,publicClient:true,fullScopeAllowed:false,standardFlowEnabled:true,directAccessGrantsEnabled:false,implicitFlowEnabled:false,protocol:'openid-connect',redirectUris:[base+'/api/v1/auth/callback'],webOrigins:[],attributes:{'pkce.code.challenge.method':'S256','access.token.lifespan':'20'},protocolMappers:mappers.map(({id,...mapper})=>mapper)});
  createdClientId=(await adminApi(config,token,'idms/clients?clientId='+clientId))[0].id;
  const scopes=await adminApi(config,token,`idms/clients/${web.id}/scope-mappings/realm`);
  await adminApi(config,token,`idms/clients/${createdClientId}/scope-mappings/realm`,'POST',scopes);
  await start();await mkdir('outputs/demo-preview',{recursive:true});
  const uploader=await createUser('uploader',['data-uploader'],'acme',true),approver=await createUser('approver',['final-approver']),technician=await createUser('technician',['maintenance-engineer','final-approver']),auditor=await createUser('auditor',['auditor']),sandbox=await createUser('sandbox',['auditor'],'sandbox'),combined=await createUser('combined',['data-uploader','final-approver']);
  browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
  const anonymous=await browser.newPage();await anonymous.goto(base);await anonymous.getByTestId('oidc-login').waitFor();await anonymous.screenshot({path:'outputs/demo-preview/13-oidc-login.png',fullPage:true});
  const aliasContext=await browser.newContext(),aliasPage=await aliasContext.newPage();
  await aliasPage.goto('http://localhost:4030');await aliasPage.getByTestId('oidc-login').click();await aliasPage.locator('#username').waitFor();
  assert.ok((await aliasContext.cookies()).some(c=>c.name==='idms_login'&&c.domain==='127.0.0.1'));await aliasContext.close();result.localhostCanonicalLogin=true;
  let response=await fetch(base+'/api/v1/data-imports',{headers:{'X-Tenant-Id':'acme','X-Actor-Id':'demo.approver'}});assert.equal(response.status,401);
  response=await fetch(base+'/api/v1/auth/callback?code=forged&state=forged');assert.equal(response.status,401);result.noHeaderBypass=true;result.callbackForgeryRejected=true;
  const uploadClient=await login(uploader,'uploads',true);result.firstLoginPasswordChange=true;
  const cookies=await uploadClient.context.cookies();assert.ok(cookies.find(c=>c.name==='idms_session'&&c.httpOnly&&c.sameSite==='Lax'));assert.equal(await uploadClient.page.evaluate(()=>localStorage.length+sessionStorage.length),0);result.httpOnlyCookieNoBrowserTokenStorage=true;
  await uploadClient.page.getByTestId('sample-upload').click();await uploadClient.page.locator('.import-drawer .badge.HUMAN_REVIEW').waitFor();await uploadClient.page.waitForFunction(()=>!document.querySelector('.busy-line'));
  let batch=(await api(uploadClient,'/data-imports')).items[0];assert.equal(batch.uploader,uploader.id);
  const approval={decision:'APPROVED',comment:'核查来源与设备台账',expectedVersion:batch.version,snapshotDigest:batch.snapshotDigest};
  await api(uploadClient,`/data-imports/${batch.batchId}/approval`,{body:approval,headers:{'X-Actor-Id':'demo.approver'},expected:403});
  await api(uploadClient,'/data-imports',{headers:{'X-Tenant-Id':'sandbox'},expected:403});
  const approveClient=await login(approver,'approvals');
  await api(approveClient,`/data-imports/${batch.batchId}/approval`,{body:approval,csrf:false,expected:403});
  await api(approveClient,`/data-imports/${batch.batchId}/approval`,{body:approval,origin:false,expected:403});
  await api(approveClient,`/data-imports/${batch.batchId}/approval`,{body:approval,headers:{Origin:'http://evil.invalid'},expected:403});
  await approveClient.page.locator(`[data-action=batch][data-id="${batch.batchId}"]`).click();await approveClient.page.locator('#approval-comment').fill('独立核查来源，批准设备台账');await approveClient.page.locator('#review-resolution').fill('真实模型未配置，已人工核实原始设备台账和确定性校验结果');await approveClient.page.getByTestId('approve-batch').click();await approveClient.page.locator('.import-drawer .badge.COMMITTED').waitFor();await approveClient.page.waitForFunction(()=>!document.querySelector('.busy-line'));
  await api(approveClient,'/data-imports/records',{body:{dataType:'DEVICE',templateVersion:'1.0.0',sourceSystem:'qa',rows:[]},expected:403});result.csrfAndOriginEnforced=true;result.independentUploadApproval=true;
  await approveClient.page.goto(base+'/?view=predictive');await approveClient.page.waitForFunction(()=>!document.querySelector('.busy-line')&&document.querySelector('[data-action=predictive-approve]'));
  approveClient.page.once('dialog',d=>d.accept('人工核查维护建议，批准创建工单'));await approveClient.page.locator('[data-action=predictive-approve]').first().click();await approveClient.page.locator('.work-order .badge.UNASSIGNED').waitFor();await approveClient.page.waitForFunction(()=>!document.querySelector('.busy-line'));
  const techClient=await login(technician,'work-orders');await techClient.page.locator('[data-action=wo-claim]').click();await techClient.page.locator('[data-action=wo-start]').waitFor();await techClient.page.waitForFunction(()=>!document.querySelector('.busy-line'));await techClient.page.locator('[data-action=wo-start]').click();await techClient.page.locator('[name=failureCode]').waitFor();await techClient.page.waitForFunction(()=>!document.querySelector('.busy-line'));
  for(const [name,value] of Object.entries({failureCode:'BRG-WEAR',minutes:'45',cause:'现场确认轴承磨损',action:'更换轴承并润滑',verification:'复测振动与温度恢复正常',partsUsed:'轴承'}))await techClient.page.locator(`[name=${name}]`).fill(value);
  await techClient.page.locator('[data-action=wo-submit]').click();await techClient.page.locator('.work-order .badge.AWAITING_APPROVAL').waitFor();await techClient.page.waitForFunction(()=>!document.querySelector('.busy-line'));
  let order=(await api(techClient,'/work-orders')).items[0];assert.equal(order.assignee,technician.id);assert.equal(await techClient.page.locator('[data-action=wo-approval]').count(),0);
  await api(techClient,`/work-orders/${order.id}/approval`,{body:{expectedVersion:order.version,snapshotDigest:order.resolution.digest,decision:'APPROVED',comment:'自己试图关单'},expected:403});
  await approveClient.page.goto(base+'/?view=work-orders');await approveClient.page.locator('[name=comment]').fill('独立复核维修和复测证据，批准关单');await approveClient.page.locator('[data-action=wo-approval]').click();await approveClient.page.locator('.work-order .badge.CLOSED').waitFor();await approveClient.page.waitForFunction(()=>!document.querySelector('.busy-line'));await approveClient.page.screenshot({path:'outputs/demo-preview/14-oidc-maintenance-closed.png',fullPage:true});result.realSubjectWorkOrderClaimAndIndependentClose=true;
  const audit=await api(approveClient,'/audit');assert.equal(audit.chainValid,true);assert.ok(audit.items.some(e=>e.actorId===technician.id&&e.action==='WORK_ORDER_SUBMIT'));assert.ok(audit.items.some(e=>e.actorId===approver.id&&e.action==='WORK_ORDER_APPROVAL'));result.auditUsesRealSubjects=true;
  const sandboxClient=await login(sandbox,'work-orders');assert.equal((await api(sandboxClient,'/data-imports')).total,0);await api(sandboxClient,`/work-orders/${order.id}`,{expected:404});result.crossTenantIsolation=true;
  const auditorClient=await login(auditor);assert.equal(await auditorClient.page.locator('#file-upload').isDisabled(),true);await api(auditorClient,'/predictive/analyze',{body:{deviceCode:'D-001'},headers:{'X-Actor-Id':'demo.approver'},expected:403});await api(auditorClient,'/templates/tpl-discrete-v2/submit',{body:{},expected:403});await api(auditorClient,'/plugins/plugin-opcua/activate',{body:{},expected:403});result.readOnlyRoleEnforced=true;
  const bearer=await issueToken(combined);
  const bearerApi=async(path,body,expected=200,extra={})=>{const r=await fetch(base+'/api/v1'+path,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+bearer,...(body?{'Content-Type':'application/json','Idempotency-Key':randomUUID(),'X-Correlation-Id':randomUUID()}:{}),...extra},body:body?JSON.stringify(body):undefined});const v=await r.json();assert.equal(r.status,expected,JSON.stringify(v));return v;};
  const own=await bearerApi('/data-imports/records',{dataType:'DEVICE',templateVersion:'1.0.0',sourceSystem:'qa',records:[{source_record_id:'qa-own',device_code:'D-QA',device_name:'QA设备',site_code:'FACTORY-01',line_code:'LINE-01'}]},202);
  await bearerApi(`/data-imports/${own.batchId}/approval`,{decision:'APPROVED',comment:'自己试图批准',expectedVersion:own.version,snapshotDigest:own.snapshotDigest},403);result.realBearerPkceAndNoSelfApproval=true;
  await bearerApi('/data-imports',undefined,403,{'X-Tenant-Id':'sandbox'});
  response=await fetch(issuer+'/protocol/openid-connect/token',{method:'POST',body:new URLSearchParams({grant_type:'password',client_id:clientId,username:combined.username,password:combined.password})});assert.equal(response.status,400);result.passwordGrantDisabled=true;
  const profile=await adminApi(config,await adminToken(config),'idms/users/profile');assert.deepEqual(profile.attributes.find(a=>a.name==='tenant_id').permissions.edit,['admin']);result.tenantClaimAdminManaged=true;
  await auditorClient.page.setViewportSize({width:390,height:844});await auditorClient.page.screenshot({path:'outputs/demo-preview/15-oidc-mobile.png',fullPage:true});assert.equal(await auditorClient.page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);result.mobileOverflow=false;
  const beforeRefresh=await session(uploadClient);assert.ok(beforeRefresh.expiresAt-Date.now()<25000,'QA token lifespan must be short without changing the real website client');
  await new Promise(r=>setTimeout(r,Math.max(1000,beforeRefresh.expiresAt-Date.now()-14000)));
  const afterRefresh=await session(uploadClient);assert.ok(afterRefresh.expiresAt>beforeRefresh.expiresAt);assert.equal(afterRefresh.user.actorId,uploader.id);result.realSessionRefresh=true;
  const auditorBefore=await session(auditorClient);
  const auditRole=await adminApi(config,await adminToken(config),'idms/roles/auditor');
  await adminApi(config,await adminToken(config),`idms/users/${auditor.id}/role-mappings/realm`,'DELETE',[auditRole]);
  await new Promise(r=>setTimeout(r,Math.max(1000,auditorBefore.expiresAt-Date.now()-14000)));
  const revoked=await auditorClient.page.request.get(base+'/api/v1/data-imports');assert.equal(revoked.status(),403);assert.equal((await session(auditorClient)).authenticated,false);result.roleRevocationOnRefresh=true;
  const oldCookies=await approveClient.context.cookies();await approveClient.page.locator('[data-action=logout]').click();await approveClient.page.getByTestId('oidc-login').waitFor();assert.equal((await session(approveClient)).authenticated,false);
  const replay=await fetch(base+'/api/v1/data-imports',{headers:{Cookie:oldCookies.filter(c=>c.name==='idms_session').map(c=>c.name+'='+c.value).join('; ')}});assert.equal(replay.status,401);result.logoutInvalidatesSession=true;
  await stop();await start();assert.equal((await session(uploadClient)).authenticated,false);result.restartFailsClosed=true;result.sessionStorage='MEMORY_FILE_DEMO';
  assert.deepEqual(result.pageErrors||[],[]);result.pageErrors=0;
  await writeFile('outputs/auth-verification.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
}finally{
  if(browser)await browser.close();await stop();
  // Only the exact users created by this run are removed. Customer accounts and realm data remain intact.
  token=await adminToken(config);for(const user of users){assert.ok(user.username.startsWith(prefix+'-'));await adminApi(config,token,`idms/users/${user.id}`,'DELETE');}
  if(createdClientId){assert.ok(clientId.startsWith('idms-auth-qa-'));await adminApi(config,token,`idms/clients/${createdClientId}`,'DELETE');}
}
