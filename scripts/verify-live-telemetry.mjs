import assert from 'node:assert/strict';
import { randomBytes,randomUUID } from 'node:crypto';
import { readFile,writeFile,mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import pg from 'pg';
import { localConfig,adminToken,adminApi } from './keycloak-local.mjs';
const base='http://127.0.0.1:4010',config=await localConfig(),username='qa-live-edge-'+randomUUID(),password='Qa9-'+randomBytes(24).toString('base64url');
const privateConfig=JSON.parse(await readFile('.local/mqtt/telemetry-runtime.json','utf8'));const source=privateConfig.sources[0];assert.equal(source.tenantId,'sandbox');assert.equal(source.origin,'SIMULATOR');
let browser,userId;
try{
  const token=await adminToken(config);
  await adminApi(config,token,'idms/users','POST',{username,enabled:true,firstName:'采集验证',lastName:'QA',email:username+'@idms.invalid',emailVerified:true,attributes:{tenant_id:['sandbox'],idms_sites:[' * '],idms_lines:[' * '],idms_devices:[' * ']},credentials:[{type:'password',value:password,temporary:false}]});
  userId=(await adminApi(config,token,`idms/users?username=${username}&exact=true`))[0].id;
  await adminApi(config,token,`idms/users/${userId}/role-mappings/realm`,'POST',[await adminApi(config,token,'idms/roles/auditor')]);
  browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(base+'/?view=telemetry');await page.getByTestId('oidc-login').click();await page.locator('#username').fill(username);await page.locator('#password').fill(password);await page.locator('#kc-login').click();await page.getByTestId('verified-identity').waitFor();await page.locator('.telemetry-source').waitFor();await page.waitForFunction(()=>!document.querySelector('.busy-line'));
  const overview=await (await page.request.get(base+'/api/v1/telemetry/overview')).json();console.log(JSON.stringify({brokerConnected:overview.brokerConnected,subscribed:overview.subscribed,lastError:overview.lastError,edge:overview.sources?.[0]?.edge&&{opcConnected:overview.sources[0].edge.opcConnected,mqttConnected:overview.sources[0].edge.mqttConnected,lastError:overview.sources[0].edge.lastError,pending:overview.sources[0].edge.pending},freshness:overview.sources?.[0]?.freshness}));assert.equal(overview.brokerConnected,true);assert.equal(overview.subscribed,true);assert.equal(overview.sources.length,1);assert.equal(overview.sources[0].edge.opcConnected,true);assert.equal(overview.sources[0].edge.mqttConnected,true);assert.ok(overview.sources[0].total>=3);assert.equal(overview.sources[0].origin,'SIMULATOR');assert.equal(overview.sources[0].freshness,'FRESH');
  assert.equal(await page.locator('[data-action=telemetry-analyze]').count(),0,'Auditor cannot execute analysis');
  const status=await (await fetch(`http://127.0.0.1:${privateConfig.simulator.statusPort}/status`,{headers:{Authorization:'Bearer '+privateConfig.simulator.statusKey}})).json();assert.equal(status.writeRequests,0);
  await mkdir('outputs/demo-preview',{recursive:true});await page.screenshot({path:'outputs/demo-preview/19-live-telemetry-desktop.png',fullPage:true});
  await page.setViewportSize({width:390,height:844});await page.screenshot({path:'outputs/demo-preview/20-live-telemetry-mobile.png',fullPage:true});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);assert.deepEqual(errors,[]);
  await page.locator('[data-action=logout]').click();await page.getByTestId('oidc-login').waitFor();
  // Verify that only sandbox receives synthetic telemetry; acme does not even have telemetry tables.
  const db=JSON.parse(await readFile('.local/postgres-runtime.json','utf8'));const conn=new pg.Client({host:db.host,port:db.port,...db.tenants.acme});await conn.connect();try{assert.equal((await conn.query("SELECT to_regclass('public.telemetry_points') AS table_name")).rows[0].table_name,null);}finally{await conn.end();}
  const result={url:base+'/?view=telemetry',actualOidcWebsite:true,actualBrokerConnected:true,actualOpcReadOnly:true,sandboxOnly:true,acmeHasNoTelemetryTables:true,sourceFresh:true,desktopMobileBrowser:true,pageErrors:0,fieldDeviceValidated:false};await writeFile('outputs/live-telemetry-verification.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
}finally{await browser?.close();if(userId)await adminApi(config,await adminToken(config),`idms/users/${userId}`,'DELETE');}
