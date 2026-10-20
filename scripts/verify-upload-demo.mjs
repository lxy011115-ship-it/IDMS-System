import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright';

const port=4022, base=`http://127.0.0.1:${port}`, namespace=`qa-${randomUUID()}`;
let processHandle;
async function start(){
  processHandle=spawn(process.execPath,['server/index.ts'],{cwd:process.cwd(),env:{...process.env,PORT:String(port),IDMS_DEMO_NAMESPACE:namespace},stdio:['ignore','pipe','pipe'],windowsHide:true});
  let log='';processHandle.stderr.on('data',b=>log+=b.toString());
  for(let i=0;i<100;i++){
    if(processHandle.exitCode!==null)throw Error(`Server exited: ${log}`);
    try{const r=await fetch(base+'/api/v1/health');if(r.ok)return;}catch{}
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  throw Error('Test server timeout '+log);
}
async function stop(){if(!processHandle||processHandle.exitCode!==null)return;const exited=new Promise(resolve=>processHandle.once('exit',resolve));processHandle.kill();await exited;}
function headers(actor='demo.uploader',extra={}){return {'X-Tenant-Id':'acme','X-Actor-Id':actor,'X-Actor-Type':'USER',...extra};}
async function api(path,{actor='demo.uploader',body,key=randomUUID(),extra={},expected=200}={}){
  const r=await fetch(base+'/api/v1'+path,{method:body?'POST':'GET',headers:headers(actor,{...(body?{'Content-Type':'application/json','Idempotency-Key':key,'X-Correlation-Id':randomUUID()}:{}),...extra}),body:body?JSON.stringify(body):undefined});
  const result=await r.json();assert.equal(r.status,expected,JSON.stringify(result));return result;
}
let browser;
try{
  await start();await mkdir('outputs/demo-preview',{recursive:true});
  browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
  const page=await browser.newPage({viewport:{width:1440,height:1000}});const pageErrors=[];page.on('pageerror',e=>pageErrors.push(e.message));
  await page.goto(base);await page.waitForSelector('#data-type');await page.screenshot({path:'outputs/demo-preview/01-upload-center.png',fullPage:true});
  async function uploadAndApprove(type,{xlsx=false,fallback=false}={}){
    await page.locator('.sidebar [data-action=nav][data-view=uploads]').click();
    await page.locator('#actor-select').selectOption('demo.uploader');await page.waitForFunction(()=>!document.querySelector('.busy-line'));
    await page.locator('#data-type').selectOption(type);
    await page.locator('#ai-mode').selectOption(fallback?'unavailable':'demo');
    if(xlsx){const response=page.waitForResponse(r=>r.url().endsWith('/api/v1/data-imports')&&r.request().method()==='POST');await page.locator('#file-upload').setInputFiles('outputs/demo-data/devices.xlsx');await response;}
    else {await page.locator('[data-testid=sample-upload]').click();}
    await page.waitForSelector('.import-drawer');await page.waitForFunction(()=>!document.querySelector('.busy-line'));
    assert.equal(await page.locator('.import-drawer .badge.VALIDATION_FAILED').count(),0);
    assert.equal(await page.locator('.import-drawer [data-testid=approve-batch]').count(),0);
    await page.locator('[data-action=switch-approver]').click();await page.waitForSelector('#approval-comment');await page.waitForFunction(()=>!document.querySelector('.busy-line'));
    await page.locator('#approval-comment').fill('原始数据与企业报表一致，批准入库。');
    if(fallback)await page.locator('#review-resolution').fill('人工核查了维修时间、措施和设备关联，证据充分。');
    await page.screenshot({path:`outputs/demo-preview/02-${type.toLowerCase()}-approval.png`,fullPage:true});
    await page.locator('[data-testid=approve-batch]').click();await page.waitForSelector('.import-drawer .badge.COMMITTED');await page.waitForFunction(()=>!document.querySelector('.busy-line'));
    await page.locator('.drawer-head [data-action=close]').click();
  }
  await uploadAndApprove('DEVICE',{xlsx:true});
  await uploadAndApprove('PRODUCTION');
  let report=await api('/upload-report');assert.equal(report.total,1000);assert.equal(report.production[0].oee,null);
  await uploadAndApprove('STATE_INTERVAL');await uploadAndApprove('MAINTENANCE',{fallback:true});await uploadAndApprove('QUALITY');
  report=await api('/upload-report');assert.ok(Math.abs(report.production[0].oee-68.055555)<0.001);assert.equal(report.downMinutes,60);assert.equal(report.mttr,50);assert.equal(report.qualitySamples,1);
  await page.locator('.sidebar [data-action=nav][data-view=analysis]').click();await page.screenshot({path:'outputs/demo-preview/03-analysis.png',fullPage:true});
  assert.ok((await page.locator('main').innerText()).includes('68.06%'));
  await page.locator('.sidebar [data-action=nav][data-view=uploads]').click();await page.locator('#actor-select').selectOption('demo.uploader');await page.waitForFunction(()=>!document.querySelector('.busy-line'));await page.locator('#data-type').selectOption('PRODUCTION');await page.locator('#ai-mode').selectOption('demo');await page.locator('[data-action=error-sample]').click();await page.waitForSelector('.import-drawer .badge.VALIDATION_FAILED');
  assert.ok((await page.locator('.import-drawer').innerText()).includes('良品数不能大于总产量'));
  await page.screenshot({path:'outputs/demo-preview/04-validation-error.png',fullPage:true});await page.locator('.drawer-head [data-action=close]').click();
  await page.locator('.sidebar [data-action=nav][data-view=audit]').click();await page.screenshot({path:'outputs/demo-preview/05-audit.png',fullPage:true});
  for(const view of ['overview','devices','approvals','roles','integrations','guide']){await page.locator(`.sidebar [data-action=nav][data-view=${view}]`).click();assert.ok((await page.locator('main').innerText()).length>100);}
  await page.locator('.sidebar [data-action=nav][data-view=uploads]').click();await page.setViewportSize({width:390,height:844});await page.locator('.mobile-nav [data-view=analysis]').click();assert.ok((await page.locator('main').innerText()).includes('68.06%'));await page.locator('.mobile-nav [data-view=uploads]').click();await page.screenshot({path:'outputs/demo-preview/06-mobile.png',fullPage:true});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false,'mobile overflow');
  assert.equal(await page.locator('.sidebar').isVisible(),false,'desktop sidebar must not cover mobile navigation');
  const record={source_record_id:'json-q-001',device_code:'D-001',batch_code:'BATCH-002',characteristic_code:'DIAMETER',measured_at:'2026-10-13T12:00:00+08:00',sample_no:2,measured_value:10.02,unit:'mm',lsl:9.95,usl:10.05};
  const body={dataType:'QUALITY',templateVersion:'1.0.0',sourceSystem:'erp-demo',records:[record]}, key=randomUUID();
  const batch=await api('/data-imports/records',{actor:'demo.connector',extra:{'X-Actor-Type':'INTERFACE'},body,key,expected:202});
  const retry=await api('/data-imports/records',{actor:'demo.connector',extra:{'X-Actor-Type':'INTERFACE'},body,key,expected:202});assert.equal(batch.batchId,retry.batchId);
  await api('/data-imports/records',{actor:'demo.connector',extra:{'X-Actor-Type':'INTERFACE'},body:{...body,records:[{...record,measured_value:99}]},key,expected:409});
  const approval={decision:'APPROVED',comment:'测试批准',expectedVersion:batch.version,snapshotDigest:batch.snapshotDigest};
  await api(`/data-imports/${batch.batchId}/approval`,{body:approval,expected:403});
  await api(`/data-imports/${batch.batchId}/approval`,{actor:'demo.approver',extra:{'X-Actor-Type':'AI'},body:approval,expected:403});
  await api(`/data-imports/${batch.batchId}`,{extra:{'X-Tenant-Id':'sandbox'},expected:404});
  await api(`/data-imports/${batch.batchId}/approval`,{actor:'demo.approver',body:approval,expected:202});
  const audit=await api('/audit');assert.equal(audit.chainValid,true);assert.equal(pageErrors.length,0,pageErrors.join('\n'));
  // A multipart retry normally gets a new boundary: compare semantic file input, not the envelope bytes.
  const multipartKey=randomUUID();let multipartBatch;
  for(let attempt=0;attempt<2;attempt++){
    const form=new FormData();form.set('file',new File([await readFile('outputs/demo-data/quality.csv')],'quality.csv'));form.set('dataType','QUALITY');form.set('templateVersion','1.0.0');form.set('sourceSystem','multipart-retry');
    const response=await fetch(base+'/api/v1/data-imports',{method:'POST',headers:headers('demo.uploader',{'Idempotency-Key':multipartKey,'X-Correlation-Id':randomUUID()}),body:form});assert.equal(response.status,202);
    const result=await response.json();if(multipartBatch)assert.equal(result.batchId,multipartBatch.batchId);else multipartBatch=result;
  }
  const original=await fetch(base+`/api/v1/data-imports/${multipartBatch.batchId}/original`,{headers:headers()});assert.equal(await original.text(),await readFile('outputs/demo-data/quality.csv','utf8'));
  const invalidBatch=(await api('/data-imports')).items.find(b=>b.status==='VALIDATION_FAILED');
  const errors=await fetch(base+`/api/v1/data-imports/${invalidBatch.batchId}/errors?format=csv`,{headers:headers()});assert.ok((await errors.text()).includes('INVALID_COUNT'));
  assert.equal((await fetch(base+'/api/v1/data-imports/records',{method:'POST',headers:headers('demo.uploader',{'Content-Type':'application/json','Idempotency-Key':randomUUID(),'X-Correlation-Id':randomUUID()}),body:JSON.stringify({...body,actor:'spoof'})})).status,400);
  const before=await api('/upload-report');await browser.close();browser=null;await stop();await start();
  const after=await api('/upload-report');assert.equal(after.committedRows,before.committedRows);assert.equal((await api('/audit')).chainValid,true);
  const predictiveAfterRestart=await api('/predictive/overview');assert.ok(predictiveAfterRestart.alerts.length>=1,'predictive state survives restart');
  // Verify second-tenant ingestion stays separate, without modifying the visible demo.
  const deviceBody={dataType:'DEVICE',templateVersion:'1.0.0',sourceSystem:'sandbox-file',records:[{source_record_id:'asset-sandbox',device_code:'D-999',device_name:'Sandbox',site_code:'FACTORY-01',line_code:'LINE-01'}]};
  const sandbox=await api('/data-imports/records',{body:deviceBody,extra:{'X-Tenant-Id':'sandbox'},expected:202});await api(`/data-imports/${sandbox.batchId}/approval`,{actor:'demo.approver',extra:{'X-Tenant-Id':'sandbox'},body:{decision:'APPROVED',comment:'沙箱核查',expectedVersion:sandbox.version,snapshotDigest:sandbox.snapshotDigest},expected:202});
  assert.equal((await api('/upload-report',{extra:{'X-Tenant-Id':'sandbox'}})).committedRows,1);assert.equal((await api('/upload-report')).committedRows,after.committedRows);
  console.log(JSON.stringify({browser:'Chrome desktop/mobile',csv:true,xlsx:true,json:true,approval:true,fallback:true,invalidRows:true,idempotency:true,tenantIsolation:true,persistence:true,audit:true,pageErrors:0,sampleOee:report.production[0].oee,namespace,screenshots:'outputs/demo-preview'},null,2));
}finally{if(browser)await browser.close();await stop();}
