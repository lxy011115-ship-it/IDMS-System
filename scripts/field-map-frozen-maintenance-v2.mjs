import {randomUUID} from 'node:crypto';
import {canonical} from '../server/imports.ts';
import {inspectStateMapCatalog} from '../server/state-map-catalog-v1.ts';
import {stateKey,verifyStateProof,stateValueText,stateRequestDigest,stateReceiptHash} from '../server/state-map-v1.ts';
import {inspectRuntimeWriteFenceCatalogV1} from './runtime-write-fence-catalog-v1.mjs';
import {fieldMapFrozenProfileV2,assertFieldMapFrozenProfileV2,setFieldMapFrozenProfileV2,frozenMapIdentV1 as q,frozenMapHashV1 as hash,frozenMapEqualV1 as same,frozenMapNeedV1 as need,frozenMapRevisionV1 as revision,frozenMapUuidV1 as uuid} from './field-map-frozen-profile-v2.mjs';

const activeClients=new WeakSet(),hex=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const clone=v=>JSON.parse(JSON.stringify(v)),freeze=v=>{if(v&&typeof v==='object'){Object.values(v).forEach(freeze);Object.freeze(v);}return v;};
const validHead=h=>h&&Object.keys(h).sort().join(',')==='count,receiptHash,revision,rootHash,rootId'&&revision(h.revision)&&revision(h.count)&&hex(h.rootHash)&&hex(h.receiptHash)&&(h.rootId===null||hex(h.rootId));
function receipt(value,p,command,requestHash){
 const h=command.expectedHead;
 need(value&&value.tenantId===p.tenantId&&value.commandId===command.commandId&&value.requestHash===requestHash&&value.beforeRevision===h.revision&&value.beforeRoot===h.rootHash&&value.beforeReceiptHash===h.receiptHash&&revision(value.revision)&&BigInt(value.revision)===BigInt(h.revision)+1n&&hex(value.rootHash)&&hex(value.receiptHash)&&typeof value.replayed==='boolean'&&value.receiptHash===stateReceiptHash(value),'FIELD_MAP_FROZEN_RECEIPT_CHANGED');return value;
}
/** Internal storage adapter only. The caller owns authorization, durable recovery intent and final COMMIT. */
export async function openFieldMapFrozenMaintenanceV2(client,raw){
 const p=fieldMapFrozenProfileV2(raw);need(client?.getTransactionStatus?.()==='T'&&!activeClients.has(client),'FIELD_MAP_FROZEN_OWNED_TRANSACTION_REQUIRED');activeClients.add(client);
 const savepoint='field_map_frozen_'+randomUUID().replaceAll('-','');let saved=false,phase='OPENING',busy=false,head,beforeFence,writer,keys=0,valueBytes=0;const cache=new Map();
 const assertTransaction=()=>need(client.getTransactionStatus?.()==='T','FIELD_MAP_FROZEN_TRANSACTION_ENDED');
 const identity=async()=>{const r=(await client.query("SELECT session_user::regrole::oid::text AS session,current_user::regrole::oid::text AS current,(SELECT rolsuper FROM pg_roles WHERE oid=session_user::regrole) AS super,(SELECT oid::text FROM pg_database WHERE datname=current_database()) AS db")).rows[0];need(r.session===p.inventory.identity.control_oid&&r.current===r.session&&r.super&&r.db===p.binding.databaseOid,'FIELD_MAP_FROZEN_CONTROL_IDENTITY');};
 const noOthers=async()=>need((await client.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE backend_type='client backend' AND pid<>pg_backend_pid()")).rows[0].n===0,'FIELD_MAP_FROZEN_OTHER_SQL_CLIENT');
 const fence=async()=>{const s=(await client.query('SELECT * FROM runtime_write_fence_v1._state')).rows[0];need(s&&s.finalized===true&&s.deployment===p.fenceBinding.deployment&&String(s.database_oid)===p.binding.databaseOid&&String(s.control_oid)===p.fenceBinding.controlOid&&String(s.owner_oid)===p.fenceBinding.ownerOid&&s.catalog_hash===p.fenceBinding.catalogHash,'FIELD_MAP_FROZEN_SQL_BINDING');return s;};
 const originalCatalog=async()=>{await identity();need(await inspectStateMapCatalog(client)===p.binding.catalogHash,'FIELD_MAP_FROZEN_MAP_CATALOG_CHANGED');const f=await inspectRuntimeWriteFenceCatalogV1(client);need(f.catalogHash===p.fenceBinding.catalogHash&&same(f.actorOids,p.fenceBinding.actorOids),'FIELD_MAP_FROZEN_FENCE_CATALOG_CHANGED');const epoch=(await client.query('SELECT CASE WHEN is_called THEN last_value ELSE 0 END AS value FROM runtime_write_fence_v1._ddl_epoch')).rows[0].value;need(String(f.state.ddl_epoch)===String(epoch),'FIELD_MAP_FROZEN_DDL_CHANGED');};
 const asWriter=async(sql,args)=>{await client.query('SET LOCAL SESSION AUTHORIZATION '+q(writer));try{return await client.query(sql,args);}finally{if(client.getTransactionStatus?.()==='T')await client.query('SET LOCAL SESSION AUTHORIZATION DEFAULT');}};
 async function abort(error){
  if(phase==='ABORTED'||phase==='SEALED')return;
  phase='ABORTED';activeClients.delete(client);
  if(saved)try{need(['T','E'].includes(client.getTransactionStatus?.()),'FIELD_MAP_FROZEN_TRANSACTION_ENDED');await client.query('ROLLBACK TO SAVEPOINT '+savepoint);await client.query('RELEASE SAVEPOINT '+savepoint);saved=false;await identity();}catch(cleanup){throw Object.assign(Error('FIELD_MAP_FROZEN_ROLLBACK_UNPROVEN'),{code:'FIELD_MAP_FROZEN_ROLLBACK_UNPROVEN',cause:error,cleanupCause:cleanup});}
 }
 async function run(work){need(phase==='READING'&&!busy,'FIELD_MAP_FROZEN_NOT_READABLE');busy=true;try{assertTransaction();return await work();}catch(e){await abort(e);throw e;}finally{busy=false;}}
 async function state(namespace,key){
  const id=stateKey(p.tenantId,namespace,key);if(cache.has(id))return structuredClone(cache.get(id));
  need(++keys<=256,'FIELD_MAP_FROZEN_READ_LIMIT');const proof=(await asWriter('SELECT state_map_v1.read_proof_v1($1,$2,$3) AS value',[p.tenantId,Buffer.from(id,'hex'),head.rootId===null?null:Buffer.from(head.rootId,'hex')])).rows[0].value;
  valueBytes+=proof.valueText===null?0:Buffer.byteLength(proof.valueText);need(valueBytes<=16*1024**2,'FIELD_MAP_FROZEN_READ_LIMIT');const value=verifyStateProof(proof,head,id);cache.set(id,value);return structuredClone(value);
 }
 async function seal(afterFence){
  await identity();await noOthers();await originalCatalog();await assertFieldMapFrozenProfileV2(client,p,true);
  await setFieldMapFrozenProfileV2(client,p,false);const frozenInventorySha256=await assertFieldMapFrozenProfileV2(client,p,false);need(same(await fence(),afterFence)&&afterFence.state==='CLOSED','FIELD_MAP_FROZEN_NOT_RECLOSED');
  await client.query('RELEASE SAVEPOINT '+savepoint);saved=false;phase='SEALED';activeClients.delete(client);cache.clear();return frozenInventorySha256;
 }
 try{
  await client.query('SAVEPOINT '+savepoint);saved=true;await identity();
  await client.query("SET LOCAL lock_timeout='5s';SET LOCAL statement_timeout='30s';SET LOCAL search_path='pg_catalog,pg_temp';SET LOCAL TimeZone='UTC';SET LOCAL DateStyle='ISO, YMD';SET LOCAL IntervalStyle='iso_8601';SET LOCAL extra_float_digits=3;SET LOCAL bytea_output='hex';SET LOCAL standard_conforming_strings=on");
  await client.query('SELECT pg_advisory_xact_lock(1229213011,905001)');await client.query('SELECT pg_advisory_xact_lock(1229213011,1)');await noOthers();await assertFieldMapFrozenProfileV2(client,p,false);
  beforeFence=clone(await fence());need(beforeFence.state==='CLOSED'&&beforeFence.operation===p.closed.operationId&&String(beforeFence.revision)===p.closed.revision,'FIELD_MAP_FROZEN_CLOSED_CHANGED');
  await client.query('SELECT revision FROM state_map_v1.head FOR UPDATE');await setFieldMapFrozenProfileV2(client,p,true);await assertFieldMapFrozenProfileV2(client,p,true);await originalCatalog();
  const m=(await client.query('SELECT tenant,owner_oid::text,app_oid::text,reader_oid::text FROM state_map_v1._meta')).rows;need(m.length===1&&m[0].tenant===p.tenantId&&m[0].app_oid===p.binding.roleOid&&m[0].owner_oid===p.fenceBinding.ownerOid&&p.fenceBinding.actorOids.includes(m[0].reader_oid),'FIELD_MAP_FROZEN_MAP_ROLE_CHANGED');writer=p.inventory.roles.find(r=>r.oid===m[0].app_oid)?.rolname;need(writer,'FIELD_MAP_FROZEN_MAP_ROLE_CHANGED');
  head=(await asWriter('SELECT state_map_v1.read_head_v1($1) AS value',[p.tenantId])).rows[0].value;need(validHead(head),'FIELD_MAP_FROZEN_HEAD_CHANGED');head=freeze(clone(head));phase='READING';
  const api={tenantId:p.tenantId,head,
   status(){return Object.freeze({phase,busy,keys,valueBytes});},
   state(namespace,key){return run(()=>state(namespace,key));},
   get(namespace,key){return run(async()=>{const value=await state(namespace,key);need(value.present,'FIELD_MAP_FROZEN_REQUIRED_MISSING');return value.value;});},
   operation(namespace,key,value){return run(async()=>{const prior=await state(namespace,key);return {namespace,key,expected:prior.valueHash,valueText:stateValueText(value)};});},
   close(){return run(async()=>{await seal(beforeFence);return freeze({format:'FIELD_MAP_FROZEN_READ_WITNESS_V1',profileSha256:hash(p),head:clone(head),fence:clone(beforeFence),formalFieldActivationGranted:false});});},
   abort(){return run(async()=>{await abort();});},
   prepare(rawCommand){return run(async()=>{
    need(rawCommand&&Object.keys(rawCommand).sort().join(',')==='authority,closeOperationId,commandId,expectedHead,openOperationId,operations'&&uuid(rawCommand.commandId)&&uuid(rawCommand.openOperationId)&&uuid(rawCommand.closeOperationId)&&new Set([rawCommand.commandId,rawCommand.openOperationId,rawCommand.closeOperationId]).size===3&&validHead(rawCommand.expectedHead),'FIELD_MAP_FROZEN_COMMAND');
    const command=structuredClone(rawCommand),a=command.authority;need(a&&Object.keys(a).sort().join(',')==='authorityId,epoch,hash'&&uuid(a.authorityId)&&Number.isSafeInteger(a.epoch)&&a.epoch>0&&hex(a.hash),'FIELD_MAP_FROZEN_AUTHORITY_BINDING');
    const requestHash=stateRequestDigest(p.tenantId,command.commandId,command.expectedHead.revision,command.expectedHead.rootHash,command.operations);
    const prior=(await asWriter('SELECT state_map_v1.read_receipt_v1($1,$2,$3) AS value',[p.tenantId,command.commandId,Buffer.from(requestHash,'hex')])).rows[0].value;
    let value,afterFence=beforeFence;
    if(prior){value=receipt(prior,p,command,requestHash);need(value.replayed===true&&BigInt(value.revision)<=BigInt(head.revision),'FIELD_MAP_FROZEN_RECEIPT_CHANGED');}
    else{
     need(command.openOperationId!==p.closed.operationId&&command.closeOperationId!==p.closed.operationId,'FIELD_MAP_FROZEN_OPERATION_REUSE');need(same(head,command.expectedHead),'FIELD_MAP_FROZEN_EXPECTED_HEAD_CHANGED');
     await client.query('SELECT runtime_write_fence_v1.set_state_v1($1,$2,$3,\'OPEN\',$4,$5,$6)',[p.fenceBinding.deployment,p.closed.revision,command.openOperationId,a.authorityId,a.epoch,a.hash]);
     value=receipt((await asWriter('SELECT state_map_v1.apply_delta_v1($1,$2,$3,$4,$5::jsonb) AS value',[p.tenantId,command.commandId,head.revision,Buffer.from(head.rootHash,'hex'),JSON.stringify(command.operations)])).rows[0].value,p,command,requestHash);need(value.replayed===false,'FIELD_MAP_FROZEN_RECEIPT_CHANGED');
     const next=(await asWriter('SELECT state_map_v1.read_head_v1($1) AS value',[p.tenantId])).rows[0].value;need(next.rootId===value.rootId&&next.rootHash===value.rootHash&&next.count===value.count&&next.revision===value.revision&&next.receiptHash===value.receiptHash,'FIELD_MAP_FROZEN_AFTER_HEAD_CHANGED');
     await client.query('SELECT runtime_write_fence_v1.set_state_v1($1,$2,$3,\'CLOSED\',NULL,NULL,NULL)',[p.fenceBinding.deployment,String(BigInt(p.closed.revision)+1n),command.closeOperationId]);afterFence=clone(await fence());need(afterFence.operation===command.closeOperationId&&String(afterFence.revision)===String(BigInt(p.closed.revision)+2n),'FIELD_MAP_FROZEN_CLOSE_GENERATION_CHANGED');
    }
    const frozenInventorySha256=await seal(afterFence);
    return freeze({format:'FIELD_MAP_FROZEN_PREPARED_V1',profileSha256:hash(p),frozenInventorySha256,requestHash,beforeHead:clone(head),receipt:clone(value),beforeFence:clone(beforeFence),afterFence:clone(afterFence),callerCommitRequired:true,currentOidcApprovalVerified:false,formalFieldActivationGranted:false});
   });}
  };return Object.freeze(api);
 }catch(e){await abort(e);throw e;}
}
