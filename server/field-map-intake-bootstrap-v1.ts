import {randomUUID} from 'node:crypto';
import {canonicalEqual} from './canonical-state.ts';
import {domainMapAssert as need} from './domain-map-v4.ts';
import {reconstructDomainPayload} from './domain-entities-v4.ts';
import {telemetryDomainFormat} from './telemetry-map-v4.ts';
import {fieldRuntimeMapFormatV1} from './field-runtime-map-v1.ts';
import {FieldMapTransactionsV2} from './field-map-transaction-v2.ts';
import type {FieldMapSnapshotV1} from './field-map-audit-v1.ts';
export const fieldMapIntakeFormatV1='IDMS_FIELD_MAP_INTAKE_V1';
export async function assertFieldMapIntakePreparedV1(s:FieldMapSnapshotV1){
 need(canonicalEqual(await s.get('domain_head','field_runtime'),{format:fieldRuntimeMapFormatV1,tenantId:s.tenantId}),'FIELD_MAP_NOT_PREPARED');
 const m=await s.get<any>('domain_head','field_intake');need(m?.format===fieldMapIntakeFormatV1&&m.tenantId===s.tenantId&&Object.keys(m).sort().join(',')==='format,initializedFrom,tenantId','FIELD_MAP_INTAKE_NOT_PREPARED');
 need(m.initializedFrom&&Object.keys(m.initializedFrom).sort().join(',')==='receiptHash,revision,rootHash,rootId'&&/^(0|[1-9][0-9]{0,18})$/.test(m.initializedFrom.revision)&&[m.initializedFrom.rootHash,m.initializedFrom.receiptHash,m.initializedFrom.rootId].every(v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v)),'FIELD_MAP_INTAKE_NOT_PREPARED');return m;
}
/** Explicit maintenance operation. Legacy FIELD_EVENT history must be migrated, never discarded. */
export async function prepareEmptyFieldMapIntakeV1(tx:FieldMapTransactionsV2,signal?:AbortSignal){
 for(let attempt=0;;attempt++){
  const s=await tx.maintenanceSnapshot(signal);let operation;
  try{
   need(canonicalEqual(await s.get('domain_head','field_runtime'),{format:fieldRuntimeMapFormatV1,tenantId:s.tenantId}),'FIELD_MAP_NOT_PREPARED');
   const present=await s.state('domain_head','field_intake');if(present.present){await assertFieldMapIntakePreparedV1(s);return {changed:false};}
   const c=await s.get<any>('domain_head','control');need(c.format===telemetryDomainFormat&&c.tenantId===s.tenantId&&c.status==='ACTIVE','FIELD_ADMISSION_MAP_NOT_ACTIVE');
   const payload=await reconstructDomainPayload(s.tenantId,(ns,k)=>s.get(ns,k));need(!payload.audits.some(a=>a.objectType==='FIELD_EVENT'),'FIELD_MAP_LEGACY_INTAKE_REQUIRES_MIGRATION');
   const {revision,rootId,rootHash,receiptHash}=s.head;operation=await s.operation('domain_head','field_intake',{format:fieldMapIntakeFormatV1,tenantId:s.tenantId,initializedFrom:{revision,rootId,rootHash,receiptHash}});
  }finally{await s.close();}
  try{await tx.commit(s.head,randomUUID(),[operation!],signal);return {changed:true};}catch(e){if(attempt<7&&/STATE_MAP_(CAS|KEY)_CONFLICT/.test((e as Error).message))continue;throw e;}
 }
}
