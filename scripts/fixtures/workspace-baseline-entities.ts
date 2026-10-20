if(!process.send||!/^(workspaceqa-[a-f0-9]{10}|readqa-[a-f0-9]{10}-[01]|stateqa-[a-f0-9]{10})$/.test(process.env.IDMS_DEMO_NAMESPACE||''))throw Error('Isolated QA IPC required');
import type pg from 'pg';
import {canonical,digest,type Batch} from '../../server/imports.ts';
import {entityTables} from '../../server/entity-schema.ts';
import type {PlatformSnapshot} from '../../server/postgres-repository.ts';
import {verifyAuditChain} from '../../server/audit.ts';
import {verifyBatchMapping} from '../../server/catalog.ts';
import {verifyEquipmentCatalog} from '../../server/equipment-profiles.ts';
import {DomainError} from '../../server/service.ts';
export type TenantPayload=Omit<PlatformSnapshot,'version'>;
export function tenantPayload(snapshot:PlatformSnapshot,tenantId:string):TenantPayload{
 return JSON.parse(JSON.stringify({business:Object.fromEntries(Object.entries(snapshot.business).map(([key,items])=>[key,items.filter(item=>key==='tenants'?item.id===tenantId:(item as any).tenantId===tenantId)])),imports:{batches:snapshot.imports.batches.filter(b=>b.tenantId===tenantId),records:snapshot.imports.records.filter(r=>r.tenantId===tenantId),requests:snapshot.imports.requests.filter(r=>r.key.startsWith(tenantId+':'))},audits:snapshot.audits.filter(a=>a.tenantId===tenantId),idempotency:snapshot.idempotency.filter(([key])=>key.startsWith(tenantId+':'))}));
}
export function validateTenantPayload(payload:TenantPayload,tenantId:string){
 if(!payload?.business||!payload.imports||!Array.isArray(payload.audits)||!verifyAuditChain(payload.audits,tenantId)||payload.audits.some(a=>a.tenantId!==tenantId))throw Error('Invalid tenant audit history');
 if(canonical(Object.keys(payload.business).sort())!==canonical(Object.keys(entityTables).sort()))throw Error('Unknown or missing business collections');
 for(const [key,items]of Object.entries(payload.business)){if(!Array.isArray(items)||items.some((item:any)=>key==='tenants'?item.id!==tenantId:item.tenantId!==tenantId)||new Set(items.map((item:any)=>item.id)).size!==items.length)throw Error('Invalid or duplicate tenant business entity');}
 for(const name of ['batches','records'] as const)if(!Array.isArray(payload.imports[name])||payload.imports[name].some(r=>r.tenantId!==tenantId))throw Error('Cross-tenant import data');
 if(!Array.isArray(payload.imports.requests)||payload.imports.requests.some(r=>!r.key.startsWith(tenantId+':'))||!Array.isArray(payload.idempotency)||payload.idempotency.some(([key])=>!key.startsWith(tenantId+':')))throw Error('Cross-tenant request data');
 const store={...payload.business,audits:payload.audits,idempotency:new Map(payload.idempotency)};verifyEquipmentCatalog(store);for(const b of payload.imports.batches){verifyBatchMapping(store,b);if(digest(Buffer.from(b.originalBase64,'base64'))!==b.fileSha256)throw Error('Original import file checksum mismatch');}
}
export function splitBatch(batch:Batch){
 const {rows,validRows,originalBase64,...body}=batch,remaining=new Map<string,{ordinals:number[];used:number}>();let matched=0;
 validRows.forEach((row,i)=>{const key=canonical(row),entry=remaining.get(key)||{ordinals:[],used:0};entry.ordinals.push(i+1);remaining.set(key,entry);});
 const input=rows.map((row,i)=>{const entry=remaining.get(canonical(row)),validOrdinal=entry&&entry.used<entry.ordinals.length?entry.ordinals[entry.used++]:null;if(validOrdinal!==null)matched++;return {ordinal:i+1,validOrdinal,body:row};});
 if(matched!==validRows.length)throw Error('Validated batch rows do not match frozen input');
 return {body,input,content:Buffer.from(originalBase64,'base64')};
}
function appendOnly(before:unknown[],after:unknown[],label:string){if(after.length<before.length||canonical(after.slice(0,before.length))!==canonical(before))throw new DomainError(409,label+' cannot be changed or removed');}
export async function writeEntities(client:pg.PoolClient,before:TenantPayload|undefined,after:TenantPayload,tenantId:string){
 validateTenantPayload(after,tenantId);
 for(const [key,table]of Object.entries(entityTables)){
  const previous=(before?.business as any)?.[key]||[],items=(after.business as any)[key] as Record<string,any>[];
  if(items.length<previous.length||previous.some((row:any,i:number)=>items[i]?.id!==row.id))throw new DomainError(409,'Business entities cannot be removed or reordered');
  for(let i=0;i<items.length;i++){const item=items[i];if(canonical(previous[i])===canonical(item))continue;
   if(previous[i]){const result=await client.query(`UPDATE ${table} SET body=$3 WHERE tenant_id=$1 AND id=$2 AND body=$4`,[tenantId,item.id,item,previous[i]]);if(result.rowCount!==1)throw new DomainError(409,'Entity changed during transaction');}
   else await client.query(`INSERT INTO ${table}(tenant_id,id,ordinal,body) VALUES($1,$2,$3,$4)`,[tenantId,item.id,i+1,item]);
   if(key==='workOrders')await client.query('INSERT INTO work_orders(id,tenant_id,alert_id,state,version,body) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(id) DO UPDATE SET state=excluded.state,version=excluded.version,body=excluded.body',[item.id,tenantId,item.alertId,item.state,item.version,item]);
  }
 }
 const old=before?.imports.batches||[],batches=after.imports.batches;
 if(old.length>batches.length||old.some((b,i)=>batches[i]?.batchId!==b.batchId))throw new DomainError(409,'Import batches cannot be removed or reordered');
 for(let i=0;i<batches.length;i++){
  const b=batches[i],current=splitBatch(b);if(canonical(b)===canonical(old[i]))continue;
  if(old[i]){const prior=splitBatch(old[i]);if(canonical(prior.input)!==canonical(current.input)||!prior.content.equals(current.content)||prior.body.fileSha256!==current.body.fileSha256)throw new DomainError(409,'Frozen input rows and original file cannot be changed');
   const frozen=(body:Record<string,unknown>)=>Object.fromEntries(Object.entries(body).filter(([key])=>!['status','version','counts','aiReview','approval','committedAt','reportStatus'].includes(key)));
   if(canonical(frozen(prior.body))!==canonical(frozen(current.body)))throw new DomainError(409,'Frozen batch metadata cannot be changed');
   const result=await client.query('UPDATE business_import_batches SET body=$3 WHERE tenant_id=$1 AND batch_id=$2 AND body=$4',[tenantId,b.batchId,current.body,prior.body]);if(result.rowCount!==1)throw new DomainError(409,'Import batch changed during transaction');
  }else{
   await client.query('INSERT INTO business_import_batches(tenant_id,batch_id,ordinal,body) VALUES($1,$2,$3,$4)',[tenantId,b.batchId,i+1,current.body]);
   await client.query('INSERT INTO business_import_files(tenant_id,batch_id,sha256,content) VALUES($1,$2,$3,$4)',[tenantId,b.batchId,b.fileSha256,current.content]);
   for(let offset=0;offset<current.input.length;offset+=1000)await client.query(`INSERT INTO business_import_input_rows SELECT $1,$2,r.ordinal,r.valid_ordinal,r.body FROM jsonb_to_recordset($3::jsonb) AS r(ordinal integer,valid_ordinal integer,body jsonb)`,[tenantId,b.batchId,JSON.stringify(current.input.slice(offset,offset+1000).map(r=>({ordinal:r.ordinal,valid_ordinal:r.validOrdinal,body:r.body})))]);
  }
 }
 const oldRequests=before?.imports.requests||[];appendOnly(oldRequests,after.imports.requests,'Import receipts');
 for(let i=oldRequests.length;i<after.imports.requests.length;i++){const r=after.imports.requests[i];await client.query('INSERT INTO business_import_requests(tenant_id,request_key,ordinal,digest,batch_id) VALUES($1,$2,$3,$4,$5)',[tenantId,r.key,i+1,r.digest,r.batchId]);}
 const oldReceipts=before?.idempotency||[];appendOnly(oldReceipts,after.idempotency,'Command receipts');
 for(let i=oldReceipts.length;i<after.idempotency.length;i++){const [key,body]=after.idempotency[i];await client.query('INSERT INTO business_command_receipts(tenant_id,request_key,ordinal,body) VALUES($1,$2,$3,$4::jsonb)',[tenantId,key,i+1,JSON.stringify(body)]);}
 const oldAudit=before?.audits||[];appendOnly(oldAudit,after.audits,'Audit history');
 for(const e of after.audits.slice(oldAudit.length))await client.query('INSERT INTO audit_ledger(event_id,tenant_id,hash,previous_hash,event) VALUES($1,$2,$3,$4,$5)',[e.eventId,tenantId,e.hash,e.previousHash,e]);
}
export async function readEntities(client:pg.PoolClient,tenantId:string,verifyDigest=true){
 const relations=[...Object.values(entityTables),'business_state','business_import_batches','business_import_files','business_import_input_rows','business_import_requests','business_command_receipts','audit_ledger'];
 if((await client.query(`SELECT 1 FROM (${relations.map(t=>`SELECT tenant_id FROM ${t}`).join(' UNION ALL ')}) entities WHERE tenant_id IS DISTINCT FROM $1 LIMIT 1`,[tenantId])).rowCount)throw Error('Normalized relations contain foreign tenant data');
 if((await client.query(`SELECT 1 FROM audit_ledger WHERE event_id::text IS DISTINCT FROM event->>'eventId' OR tenant_id IS DISTINCT FROM event->>'tenantId' OR hash IS DISTINCT FROM event->>'hash' OR previous_hash IS DISTINCT FROM event->>'previousHash' LIMIT 1`)).rowCount)throw Error('SQL audit columns disagree with frozen events');
 if((await client.query(`SELECT 1 FROM business_import_files f JOIN business_import_batches b USING(tenant_id,batch_id) WHERE f.sha256 IS DISTINCT FROM b.body->>'fileSha256' LIMIT 1`)).rowCount)throw Error('Original file metadata disagrees with batch checksum');
 const rows=await client.query('SELECT s.payload_digest,s.schema_version AS storage_schema,v.revision,v.payload FROM business_state s CROSS JOIN runtime_state v WHERE s.tenant_id=$1',[tenantId]);
 if(rows.rowCount!==1||rows.rows[0].storage_schema!==3)throw Error('Normalized business migration is required');const row=rows.rows[0],payload=row.payload as TenantPayload;
 if(verifyDigest&&digest(canonical(payload))!==row.payload_digest)throw Error('Normalized entity digest disagrees with persisted state');
 validateTenantPayload(payload,tenantId);
 const orders=(await client.query('SELECT body FROM work_orders ORDER BY id')).rows.map(r=>r.body),expected=[...payload.business.workOrders].sort((a,b)=>a.id.localeCompare(b.id));
 if(canonical(orders)!==canonical(expected))throw Error('Work-order projection disagrees with normalized entities');
 return {payload,revision:Number(row.revision)};
}
