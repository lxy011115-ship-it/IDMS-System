import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
const base=process.env.IDMS_DEMO_URL || 'http://127.0.0.1:4010';
async function api(path,{actor='demo.uploader',body}={}){
  const response=await fetch(base+'/api/v1'+path,{method:body?'POST':'GET',headers:{'X-Tenant-Id':'acme','X-Actor-Id':actor,'X-Actor-Type':'USER',...(body?{'Content-Type':'application/json','Idempotency-Key':randomUUID(),'X-Correlation-Id':randomUUID()}: {})},body:body?JSON.stringify(body):undefined});
  const result=await response.json();if(!response.ok)throw Error(JSON.stringify(result));return result;
}
const existing=await api('/data-imports');
if(existing.total){console.log('Existing local demo batches preserved; seed skipped.');process.exit(0);}
async function file(type,filename,{approve=false,fallback=false}={}){
  const form=new FormData();form.set('file',new File([await readFile('outputs/demo-data/'+filename)],filename));form.set('dataType',type);form.set('templateVersion','1.0.0');form.set('sourceSystem','manual-excel');form.set('aiMode',fallback?'unavailable':'demo');
  const response=await fetch(base+'/api/v1/data-imports',{method:'POST',headers:{'X-Tenant-Id':'acme','X-Actor-Id':'demo.uploader','Idempotency-Key':randomUUID(),'X-Correlation-Id':randomUUID()},body:form});
  const batch=await response.json();if(!response.ok)throw Error(JSON.stringify(batch));
  if(approve)await api(`/data-imports/${batch.batchId}/approval`,{actor:'demo.approver',body:{decision:'APPROVED',comment:'已核对示例数据、统计口径和设备关联，批准演示数据入库。',expectedVersion:batch.version,snapshotDigest:batch.snapshotDigest}});
  console.log(`${type}: ${approve?'COMMITTED':batch.status}`);
}
await file('DEVICE','devices.xlsx',{approve:true});await file('PRODUCTION','production.csv',{approve:true});await file('STATE_INTERVAL','state-intervals.csv',{approve:true});
await file('MAINTENANCE','maintenance.csv',{fallback:true});await file('QUALITY','quality.xlsx');await file('PRODUCTION','production-error.csv');
console.log('Prepared complete OEE, pending human review, pending approval, and row-error scenarios.');
