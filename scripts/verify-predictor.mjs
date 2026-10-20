import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile,writeFile,mkdir } from 'node:fs/promises';
import { randomUUID,randomBytes } from 'node:crypto';
import { parseCsv } from '../server/imports.ts';
const namespace='predictor-qa-'+randomUUID(),token=randomBytes(32).toString('hex'),base='http://127.0.0.1:4025';
let core,predictor;
const env={...process.env,PORT:'4025',PREDICTOR_PORT:'4026',IDMS_STORAGE:'local',IDMS_DEMO_NAMESPACE:namespace,IDMS_SERVICE_TOKEN:token,IDMS_PREDICTOR_URL:'http://127.0.0.1:4026'};
function start(file){const child=spawn(process.execPath,[file],{env,stdio:['ignore','pipe','pipe'],windowsHide:true});child.stderr.on('data',b=>process.stderr.write(b));return child;}
async function ready(url,child){for(let i=0;i<100;i++){if(child.exitCode!==null)throw Error('process exited');try{if((await fetch(url)).ok)return;}catch{}await new Promise(r=>setTimeout(r,100));}throw Error('timeout');}
async function stop(child){if(!child||child.exitCode!==null)return;const done=new Promise(r=>child.once('exit',r));child.kill();await done;}
async function api(path,body,actor='demo.uploader',expected=200){const response=await fetch(base+'/api/v1'+path,{method:body?'POST':'GET',headers:{'X-Tenant-Id':'acme','X-Actor-Id':actor,'X-Actor-Type':'USER',...(body?{'Content-Type':'application/json','Idempotency-Key':randomUUID(),'X-Correlation-Id':randomUUID()}: {})},body:body?JSON.stringify(body):undefined});const result=await response.json();assert.equal(response.status,expected,JSON.stringify(result));return result;}
async function upload(type,file){const batch=await api('/data-imports/records',{dataType:type,templateVersion:'1.0.0',sourceSystem:'analysis-qa',records:parseCsv(await readFile(file,'utf8')).rows},'demo.uploader',202);assert.equal(batch.status,'AWAITING_APPROVAL');return batch;}
async function approve(batch){return api(`/data-imports/${batch.batchId}/approval`,{decision:'APPROVED',comment:'核对上传数据与来源',expectedVersion:batch.version,snapshotDigest:batch.snapshotDigest},'demo.approver',202);}
try{
  predictor=start('services/predictor/index.ts');await ready('http://127.0.0.1:4026/health',predictor);
  assert.equal((await fetch('http://127.0.0.1:4026/v1/analyze',{method:'POST',body:'{}'})).status,401);
  core=start('server/index.ts');await ready(base+'/api/v1/health',core);
  await approve(await upload('DEVICE','docs/upload-templates/devices.csv'));
  const batch=await upload('MEASUREMENT','docs/upload-templates/measurements.csv');
  let result=await api('/predictive/analyze',{deviceCode:'D-001'});assert.equal(result.status,'HUMAN_REVIEW','pending input must not be analyzed');
  await approve(batch);result=await api('/predictive/analyze',{deviceCode:'D-001'});assert.equal(result.status,'ANALYZED');assert.equal(result.snapshot.confidence,null);assert.equal(result.snapshot.provenance,'APPROVED_IMPORT');assert.ok(result.snapshot.sourceBatchIds.includes(batch.batchId));assert.ok(result.snapshot.score<65);
  const again=await api('/predictive/analyze',{deviceCode:'D-001'});assert.equal(again.snapshot.id,result.snapshot.id);assert.equal(again.reused,true);
  const overview=await api('/predictive/overview');assert.ok(overview.alerts.some(a=>a.modelVersion==='engineering-health-rules-1.0.1'&&a.probability===null));
  assert.equal((await api('/audit')).chainValid,true);
  await stop(predictor);predictor=null;
  // A different device has no cached analysis: model failure must not produce a healthy result.
  const outage=await api('/predictive/analyze',{deviceCode:'D-001-NOT-FOUND'},'demo.uploader',404);assert.ok(outage.error);
  await stop(core);core=null;
  // Reopen core without predictor and verify previous evidence persisted; new unanalysed asset fails closed.
  core=start('server/index.ts');await ready(base+'/api/v1/health',core);
  assert.equal((await api('/predictive/overview')).health.find(h=>h.deviceCode==='D-001').id,result.snapshot.id);
  const extra=await api('/data-imports/records',{dataType:'DEVICE',templateVersion:'1.0.0',sourceSystem:'analysis-qa',records:[{source_record_id:'asset-offline',device_code:'OFFLINE-1',device_name:'未连接模型设备',site_code:'FACTORY-01',line_code:'LINE-01'}]},'demo.uploader',202);await approve(extra);
  const fail=await api('/predictive/analyze',{deviceCode:'OFFLINE-1'});assert.equal(fail.status,'HUMAN_REVIEW');assert.equal(fail.snapshot,null);assert.equal((await api('/audit')).chainValid,true);
  const verification={independentPredictor:true,serviceAuthentication:true,approvedDataOnly:true,measuredInputAnalysis:true,sourceBatchLineage:true,repeatInputDeduplicated:true,noFabricatedRul:true,failClosed:true,restartRecovery:true,namespace};
  await mkdir('outputs',{recursive:true});await writeFile('outputs/predictor-verification.json',JSON.stringify(verification,null,2));console.log(JSON.stringify(verification,null,2));
}finally{await stop(core);await stop(predictor);}
