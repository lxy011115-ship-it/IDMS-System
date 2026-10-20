import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
const base='http://127.0.0.1:4023', namespace='maintenance-qa-'+randomUUID();
let child,browser;
async function start(){
  child=spawn(process.execPath,['server/index.ts'],{env:{...process.env,PORT:'4023',IDMS_STORAGE:'local',IDMS_DEMO_NAMESPACE:namespace},stdio:['ignore','pipe','pipe'],windowsHide:true});
  let log=''; child.stderr.on('data',b=>log+=b);
  for(let i=0;i<100;i++){if(child.exitCode!==null)throw Error(log);try{if((await fetch(base+'/api/v1/health')).ok)return;}catch{}await new Promise(r=>setTimeout(r,100));}throw Error('start timeout '+log);
}
async function stop(){if(!child||child.exitCode!==null)return;const done=new Promise(r=>child.once('exit',r));child.kill();await done;}
const headers=actor=>({'X-Tenant-Id':'acme','X-Actor-Id':actor,'X-Actor-Type':'USER'});
async function api(path,{actor='demo.approver',body,expected=200,key=randomUUID(),tenant='acme'}={}){
  const response=await fetch(base+'/api/v1'+path,{method:body?'POST':'GET',headers:{...headers(actor),'X-Tenant-Id':tenant,...(body?{'Content-Type':'application/json','Idempotency-Key':key,'X-Correlation-Id':randomUUID()}: {})},body:body?JSON.stringify(body):undefined});
  const result=await response.json();assert.equal(response.status,expected,JSON.stringify(result));return result;
}
try{
  await start();await mkdir('outputs/demo-preview',{recursive:true});
  browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe',headless:true});
  const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(base);await page.waitForSelector('#data-type');
  await page.locator('#actor-select').selectOption('demo.approver');await page.waitForFunction(()=>!document.querySelector('.busy-line'));
  await page.locator('.sidebar [data-view=predictive]').click();await page.screenshot({path:'outputs/demo-preview/07-predictive.png',fullPage:true});
  page.once('dialog',d=>d.accept('核查了现场振动趋势，批准生成工单'));
  await page.locator('[data-action=predictive-approve]').click();await page.waitForSelector('.work-order');await page.waitForFunction(()=>!document.querySelector('.busy-line'));
  assert.equal((await api('/work-orders')).total,1);
  await page.locator('#actor-select').selectOption('demo.technician');await page.waitForFunction(()=>!document.querySelector('.busy-line'));
  await page.locator('[data-action=wo-start]').click();await page.waitForSelector('[name=failureCode]');await page.waitForFunction(()=>!document.querySelector('.busy-line'));
  for(const [name,value] of Object.entries({failureCode:'BRG-WEAR',minutes:'90',cause:'前轴承滚道磨损',action:'更换轴承并重新润滑',verification:'负载复测振动3.1mm/s，温度正常',partsUsed:'6205轴承,润滑脂'}))await page.locator(`[name=${name}]`).fill(value);
  await page.locator('[data-action=wo-submit]').click();await page.waitForSelector('.work-order .badge.AWAITING_APPROVAL');await page.waitForFunction(()=>!document.querySelector('.busy-line'));
  assert.equal(await page.locator('[data-action=wo-approval]').count(),0);
  let order=(await api('/work-orders')).items[0];
  await api(`/work-orders/${order.id}/approval`,{actor:'demo.technician',body:{expectedVersion:order.version,decision:'APPROVED',comment:'自行批准'},expected:403});
  await api(`/work-orders/${order.id}`,{tenant:'sandbox',expected:404});
  await page.locator('#actor-select').selectOption('demo.approver');await page.waitForSelector('[name=comment]');await page.waitForFunction(()=>!document.querySelector('.busy-line'));
  await page.locator('[name=comment]').fill('复测符合要求，确认关闭工单');await page.screenshot({path:'outputs/demo-preview/08-maintenance-approval.png',fullPage:true});
  await page.locator('[data-action=wo-approval]').click();await page.waitForSelector('.work-order .badge.CLOSED');await page.waitForFunction(()=>!document.querySelector('.busy-line'));
  await page.screenshot({path:'outputs/demo-preview/09-maintenance-closed.png',fullPage:true});
  order=(await api('/work-orders')).items[0];assert.equal(order.state,'CLOSED');assert.ok(order.resolution.digest);assert.ok(order.approval.signature);
  assert.equal((await api('/predictive/overview')).alerts[0].state,'RESOLVED');assert.equal((await api('/audit')).chainValid,true);
  await page.setViewportSize({width:390,height:844});await page.screenshot({path:'outputs/demo-preview/10-maintenance-mobile.png',fullPage:true});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false,'mobile overflow');assert.deepEqual(errors,[]);
  await browser.close();browser=null;await stop();await start();
  const restored=(await api('/work-orders')).items[0];assert.deepEqual(restored,order);assert.equal((await api('/audit')).chainValid,true);
  const result={realWorkOrder:true,repairEvidence:true,independentFinalApproval:true,noSelfApproval:true,tenantIsolation:true,auditChain:true,restartRecovery:true,mobileOverflow:false,pageErrors:0,namespace};
  await writeFile('outputs/maintenance-verification.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
}finally{if(browser)await browser.close();await stop();}
