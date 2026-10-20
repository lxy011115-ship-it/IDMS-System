import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import pg from 'pg';
import {chromium} from 'playwright';
import {writePrivate,localConfig,adminApi,adminToken} from './keycloak-local.mjs';
const base='http://127.0.0.1:4010',baselineFile='.local/ai-upgrade-baseline.json';
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
async function businessState(){const c=JSON.parse(await readFile('.local/postgres-runtime.json','utf8')),state={};for(const [id,account] of Object.entries(c.tenants)){const sql=new pg.Client({host:c.host,port:c.port,...account});await sql.connect();try{const payload=(await sql.query('SELECT payload FROM runtime_state')).rows[0].payload;state[id]={importsDigest:hash(payload.imports),businessDigest:hash(payload.business),batches:payload.imports.batches.length,workOrders:payload.business.workOrders.length};}finally{await sql.end();}}return state;}
if(process.argv[2]==='capture'){const state=await businessState();await writePrivate(baselineFile,JSON.stringify(state));console.log(JSON.stringify({captured:true,counts:Object.fromEntries(Object.entries(state).map(([id,s])=>[id,{batches:s.batches,workOrders:s.workOrders}]))}));}
else{
  const baseline=JSON.parse(await readFile(baselineFile,'utf8'));assert.deepEqual(await businessState(),baseline);
  const identity=await localConfig(),username='qa-live-ai-'+randomUUID(),password='Qa9-'+randomBytes(24).toString('base64url');let userId,browser;
  try{
    const token=await adminToken(identity);await adminApi(identity,token,'idms/users','POST',{username,enabled:true,firstName:'网关验证',lastName:'QA',email:username+'@idms.invalid',emailVerified:true,attributes:{tenant_id:['acme'],idms_sites:[' * '],idms_lines:[' * '],idms_devices:[' * ']},credentials:[{type:'password',value:password,temporary:false}]});userId=(await adminApi(identity,token,`idms/users?username=${username}&exact=true`))[0].id;await adminApi(identity,token,`idms/users/${userId}/role-mappings/realm`,'POST',[await adminApi(identity,token,'idms/roles/auditor')]);
    browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.goto(base+'/?view=uploads');await page.getByTestId('oidc-login').click();await page.locator('#username').fill(username);await page.locator('#password').fill(password);await page.locator('#kc-login').click();await page.getByTestId('verified-identity').waitFor();await page.waitForFunction(()=>!document.querySelector('.busy-line'));
    async function api(path){const r=await page.request.get(base+'/api/v1'+path);assert.equal(r.status(),200);return r.json();}
    const status=await api('/ai/status');assert.equal(status.enabled,true);assert.equal(status.connected,true);assert.equal(status.mode,'SHADOW');assert.equal(status.finalApproval,false);assert.equal(status.model.name,'qwen3:4b');assert.equal((await api('/integrations')).items.find(i=>i.id==='ai').status,'CONNECTED');
    const batches=await api('/data-imports');assert.equal(batches.total,baseline.acme.batches);for(const b of batches.items)assert.equal(b.aiReview.gateway,undefined,'Existing batches must not gain fabricated AI history');
    assert.ok((await page.locator('.manual-demo-bar').innerText()).includes('本地模型影子审核'));assert.equal(await page.locator('#ai-mode').isDisabled(),true);await page.screenshot({path:'outputs/demo-preview/28-live-ai-uploads.png',fullPage:true});
    await page.locator('.sidebar [data-view=integrations]').click();await page.screenshot({path:'outputs/demo-preview/29-live-ai-integrations.png',fullPage:true});const workflow=await api('/workflow/status');assert.equal(workflow.connected,true);assert.equal((await api('/audit')).chainValid,true);
    await page.setViewportSize({width:390,height:844});await page.screenshot({path:'outputs/demo-preview/30-live-ai-mobile.png',fullPage:true});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);assert.deepEqual(errors,[]);
    await page.locator('[data-action=logout]').click();await page.getByTestId('oidc-login').waitFor();assert.deepEqual(await businessState(),baseline);
    const result={url:base+'/?view=uploads',actualOidcWebsite:true,actualGatewayAndPinnedModelReady:true,model:status.model,mode:status.mode,noFabricatedOldAiHistory:true,existingBusinessAndImportDigestsUnchanged:true,acmeBatches:baseline.acme.batches,acmeWorkOrders:baseline.acme.workOrders,flowableStillConnected:true,auditChain:true,desktopMobilePageErrors:0,readinessIsNotInferenceOrModelAccuracy:true,productionAcceptance:false};await writeFile('outputs/live-ai-verification.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
  }finally{if(browser)await browser.close();if(userId)await adminApi(identity,await adminToken(identity),`idms/users/${userId}`,'DELETE');}
}
