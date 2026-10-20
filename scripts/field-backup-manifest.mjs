import {fieldCaptureContext} from './field-capture-context.mjs';
import {createHash} from 'node:crypto';
import {fieldBackupSourceProof} from './field-backup-proof.mjs';
import {canonical} from '../server/imports.ts';
import {fieldRecoveryIdentity,fieldRecoveryDatabaseBinding} from '../integrations/field-recovery.ts';
import {moduleTables,latestMigrationChecksum} from '../server/postgres-schema.ts';
import {fieldTablePrivileges,fieldModuleChecksum} from '../server/field-schema.ts';
export const fieldBackupLimits=Object.freeze({manifestBytes:1048576,dumpBytes:8*1024**3,rowBytes:64*1024**2,chunkBytes:65536});
export const backupError=code=>Object.assign(Error(code),{code});
const fail=()=>{throw backupError('FIELD_BACKUP_MANIFEST_INVALID');};
const sha=s=>createHash('sha256').update(s).digest('hex');
function object(v,keys){if(!v||typeof v!=='object'||Array.isArray(v)||Object.getPrototypeOf(v)!==Object.prototype||Object.keys(v).length!==keys.length||keys.some(k=>!Object.hasOwn(v,k)))fail();return v;}
function string(v,max=256){if(typeof v!=='string'||!v.length||v.length>max||v.includes('\0'))fail();return v;}
function id(v){if(!/^[a-z_][a-z0-9_]{0,62}$/.test(string(v,63)))fail();return v;}
function hash(v){if(!/^[a-f0-9]{64}$/.test(string(v,64)))fail();return v;}
function integer(v,min=0,max=Number.MAX_SAFE_INTEGER){if(!Number.isSafeInteger(v)||v<min||v>max)fail();return v;}
function decimal(v,min=0n,max=9223372036854775807n){if(typeof v!=='string'||! /^(?:0|-?[1-9]\d{0,18})$/.test(v)||BigInt(v)<min||BigInt(v)>max)fail();return v;}
function uuid(v){if(!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(string(v,36))||v==='00000000-0000-0000-0000-000000000000')fail();return v;}
function timestamp(v){string(v,24);if(!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v)||!Number.isFinite(Date.parse(v))||new Date(v).toISOString()!==v)fail();return v;}
function array(v,max){if(!Array.isArray(v)||v.length>max)fail();return v;}
const nullable=(v,read)=>v===null?null:read(v);
function jsonBudget(raw){let bytes=0,nodes=0;const pending=[{value:raw,depth:0}];while(pending.length){const {value,depth}=pending.pop();if(++nodes>65536||depth>16)fail();if(value===null||['string','boolean','number'].includes(typeof value)){if(typeof value==='number'&&!Number.isFinite(value))fail();bytes+=Buffer.byteLength(JSON.stringify(value));}else{if(!value||typeof value!=='object'||!Array.isArray(value)&&Object.getPrototypeOf(value)!==Object.prototype)fail();const keys=Object.keys(value),isArray=Array.isArray(value);if(keys.length>8192||isArray&&keys.length!==value.length)fail();bytes+=2+Math.max(0,keys.length-1);for(const key of keys){if(!isArray)bytes+=Buffer.byteLength(JSON.stringify(key))+1;pending.push({value:value[key],depth:depth+1});}}if(bytes>fieldBackupLimits.manifestBytes)fail();}}
function facts(v){
 object(v,['format','tenantId','pgVersion','sourceDatabase','sourceRoles','module','root','revision','auditEvents','auditHead','businessSha256','importsSha256','relations','sequences','factsSha256','sequenceValuesAreNotMvcc','maximumSupportedRowBytes']);
 if(v.format!=='idms-field-backup-facts-v1'||v.sequenceValuesAreNotMvcc!==true||v.maximumSupportedRowBytes!==fieldBackupLimits.rowBytes||!/^[A-Za-z0-9_-]{1,80}$/.test(string(v.tenantId,80))||!/^16\d{4}$/.test(string(v.pgVersion,6)))fail();id(v.sourceDatabase);
 object(v.sourceRoles,['owner','app','backup']);Object.values(v.sourceRoles).forEach(id);if(new Set(Object.values(v.sourceRoles)).size!==3)fail();
 const root=object(v.root,['tenant_id','revision','schema_version','payload_digest','updated_at']);if(root.tenant_id!==v.tenantId||root.schema_version!==3)fail();decimal(root.revision,1n,BigInt(Number.MAX_SAFE_INTEGER));hash(root.payload_digest);timestamp(root.updated_at);if(integer(v.revision,1)!==Number(root.revision))fail();integer(v.auditEvents);nullable(v.auditHead,hash);if((v.auditEvents===0)!==(v.auditHead===null))fail();hash(v.businessSha256);hash(v.importsSha256);
 const relations=array(v.relations,64),telemetry=relations.some(r=>r?.schema==='public'&&r?.table==='telemetry_points');
 const expected=[...moduleTables(telemetry).map(table=>'public.'+table),...Object.keys(fieldTablePrivileges).map(table=>'idms_field.'+table)].sort((a,b)=>Buffer.compare(Buffer.from(a),Buffer.from(b)));
 if(canonical(relations.map(r=>r?.schema+'.'+r?.table))!==canonical(expected))fail();
 for(const r of relations){object(r,r.kind==='v'?['schema','table','kind','definition','columns','rows','bytes','sha256']:['schema','table','kind','columns','rows','bytes','sha256']);id(r.schema);id(r.table);if(r.kind!==(r.schema==='public'&&r.table==='runtime_state'?'v':'r'))fail();if(r.kind==='v')string(r.definition,131072);integer(r.rows);integer(r.bytes);hash(r.sha256);if(r.rows===0?(r.bytes!==0||r.sha256!==sha('')):r.bytes<r.rows*3||r.bytes/r.rows>fieldBackupLimits.rowBytes+1)fail();
  const columns=array(r.columns,128);if(!columns.length)fail();const names=new Set();for(const c of columns){object(c,['column_name','data_type','udt_schema','udt_name','is_nullable','column_default','is_identity','identity_generation','is_generated','generation_expression','collation_name']);id(c.column_name);if(names.has(c.column_name))fail();names.add(c.column_name);string(c.data_type,128);id(c.udt_schema);id(c.udt_name);if(!['YES','NO'].includes(c.is_nullable)||!['YES','NO'].includes(c.is_identity)||!['ALWAYS','NEVER'].includes(c.is_generated)||c.identity_generation!==null&&!['ALWAYS','BY DEFAULT'].includes(c.identity_generation))fail();nullable(c.column_default,x=>string(x,131072));nullable(c.generation_expression,x=>string(x,131072));nullable(c.collation_name,id);}
 }
 const m=object(v.module,['version','checksum','baseChecksum']),base=latestMigrationChecksum(telemetry);if(m.version!==1||m.baseChecksum!==base||m.checksum!==fieldModuleChecksum(base))fail();
 const sequences=array(v.sequences,64);if(canonical(sequences.map(s=>s?.schema+'.'+s?.name))!==canonical(['public.audit_ledger_sequence_no_seq']))fail();
 for(const s of sequences){object(s,['schema','name','seqstart','seqincrement','seqmin','seqmax','seqcache','seqcycle','last_value','is_called']);id(s.schema);id(s.name);for(const k of ['seqstart','seqincrement','seqmin','seqmax','last_value'])decimal(s[k],-9223372036854775808n);decimal(s.seqcache,1n);if(BigInt(s.seqmin)>=BigInt(s.seqmax)||BigInt(s.seqincrement)===0n||['seqstart','last_value'].some(k=>BigInt(s[k])<BigInt(s.seqmin)||BigInt(s[k])>BigInt(s.seqmax))||typeof s.seqcycle!=='boolean'||typeof s.is_called!=='boolean')fail();}
 hash(v.factsSha256);const {factsSha256,sequenceValuesAreNotMvcc,maximumSupportedRowBytes,...content}=v;if(sha(canonical(content))!==factsSha256)fail();return v;
}
export function fieldBackupManifest(raw,tenantId){
 try{
  jsonBudget(raw);
  const m=object(raw,['format','backupId','tenantId','createdAt','scope','recoveryMode','operationId','intentDigest','sourceIdentity','targetIdentity','sourceBinding','recoveryControlDigest','facts','dump',...(['idms-field-full-backup-v2','idms-field-full-backup-v3'].includes(raw?.format)?['sourceProof']:[]),...(raw?.format==='idms-field-full-backup-v3'?['captureContext']:[])]);
  if(!['idms-field-full-backup-v1','idms-field-full-backup-v2','idms-field-full-backup-v3'].includes(m.format)||m.scope!=='TENANT_PUBLIC_AND_FIELD'||m.recoveryMode!=='ISOLATED_PENDING_INDEPENDENT_APPROVAL'||m.tenantId!==tenantId)fail();uuid(m.backupId);uuid(m.operationId);timestamp(m.createdAt);hash(m.intentDigest);hash(m.recoveryControlDigest);
  const source=fieldRecoveryIdentity(m.sourceIdentity),target=fieldRecoveryIdentity(m.targetIdentity);if(source.activationId===target.activationId||source.deploymentId!==target.deploymentId)fail();
  const b=object(m.sourceBinding,['host','port','database','user']);if(fieldRecoveryDatabaseBinding(b)!==source.databaseBindingSha256)fail();
  facts(m.facts);if(m.facts.tenantId!==tenantId||m.facts.sourceDatabase!==b.database||m.facts.sourceRoles.app!==b.user)fail();const d=object(m.dump,['format','bytes','sha256']);if(d.format!=='PGDMP')fail();integer(d.bytes,5,fieldBackupLimits.dumpBytes);hash(d.sha256);
  if(['idms-field-full-backup-v2','idms-field-full-backup-v3'].includes(m.format))fieldBackupSourceProof(m.sourceProof,m);
  if(m.format==='idms-field-full-backup-v3')fieldCaptureContext(m.captureContext);
  const encoded=canonical(m);if(Buffer.byteLength(encoded)>fieldBackupLimits.manifestBytes)fail();const snapshot=JSON.parse(encoded),freeze=value=>{if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}};freeze(snapshot);return snapshot;
 }catch(e){if(e.code==='FIELD_BACKUP_MANIFEST_INVALID')throw e;throw backupError('FIELD_BACKUP_MANIFEST_INVALID');}
}
