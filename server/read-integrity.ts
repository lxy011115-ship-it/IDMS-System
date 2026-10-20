import type pg from 'pg';
import {entityTables} from './entity-schema.ts';
import {projectionTables} from './data-projection.ts';
import {verifyColdImports,readColdImportSnapshot} from './cold-import-proof.ts';
import {canonical,digest} from './imports.ts';
import {DomainError} from './service.ts';
import type {ReadWorkspaceData} from './read-model.ts';

// SQL row-version identity is used only to reuse a previously verified snapshot.
// Never use xmin/ctid as business identity or trust revision alone.
export const readRelations=[...new Set([...Object.values(entityTables),'business_state','business_import_batches','business_import_files','business_import_input_rows','business_import_requests','business_command_receipts','audit_ledger','work_orders',...projectionTables,'managed_projection_state','managed_record_revisions','idms_schema_migrations'])].sort();
export const readFingerprintSql=`/* IDMS_VERIFIED_READ_FINGERPRINT */ SELECT
 current_setting('transaction_isolation') AS isolation,current_setting('transaction_read_only') AS read_only,
 current_database() AS database,current_user AS username,
 (SELECT oid::text FROM pg_database WHERE datname=current_database()) AS database_oid,
 pg_postmaster_start_time()::text AS server_started,
 floor(pg_snapshot_xmax(pg_current_snapshot())::text::numeric/4294967296)::text AS xid_epoch,
 encode(sha256(convert_to(pg_get_viewdef('public.runtime_state'::regclass,true),'UTF8')),'hex') AS view_definition,
 jsonb_build_array(${readRelations.map(table=>`(SELECT jsonb_build_array('${table}',c.oid::text,pg_relation_filenode(c.oid)::text,c.xmin::text,
 (SELECT encode(sha256(convert_to(COALESCE(string_agg(tableoid::text||':'||xmin::text||':'||ctid::text,',' ORDER BY ctid),''),'UTF8')),'hex') FROM public.${table}))
 FROM pg_class c WHERE c.oid='public.${table}'::regclass)`).join(',')}) AS relations`;
interface Proof {fingerprint:string;tenantId:string;revision:number}
interface Cache {proof?:Proof;pending:Map<string,Promise<Proof>>}
const caches=new WeakMap<object,Map<string,Cache>>();

export function readFingerprint(row:Record<string,unknown>,tenantId:string){
 if(row.isolation!=='repeatable read'||row.read_only!=='on'||!Array.isArray(row.relations)||row.relations.length!==readRelations.length||row.relations.some((r:any,i:number)=>!Array.isArray(r)||r.length!==5||r[0]!==readRelations[i]||r.some((v:unknown)=>typeof v!=='string'||!v)))throw new DomainError(503,'SQL读取必须在完整的一致性只读快照内校验');
 for(const key of ['database','username','database_oid','server_started','xid_epoch','view_definition'])if(typeof row[key]!=='string'||!row[key])throw new DomainError(503,'数据库读取代际无法验证');
 return digest(canonical({tenantId,...row}));
}
export async function verifiedReadStamp(pool:object,client:pg.PoolClient,tenantId:string,onLoaded?:(data:ReadWorkspaceData)=>void,lockedRead=false):Promise<string>{
 let tenants=caches.get(pool);if(!tenants){tenants=new Map();caches.set(pool,tenants);}let cache=tenants.get(tenantId);if(!cache){cache={pending:new Map()};tenants.set(tenantId,cache);}
 let fingerprint:string;
 try{const rows=(await client.query(readFingerprintSql)).rows;if(rows.length!==1)throw Error('Missing fingerprint');const row=rows[0];
  // The legacy workspace caller holds business_state FOR SHARE. PostgreSQL
  // requires a read/write transaction for that lock; its repeatable snapshot
  // can reuse the same content proof as an independent READ ONLY SQL reader.
  if(lockedRead&&row.read_only==='off')row.read_only='on';fingerprint=readFingerprint(row,tenantId);
 }catch(e){if(e instanceof DomainError)throw e;throw new DomainError(503,'企业数据库读取状态暂不可验证');}
 if(cache.proof?.fingerprint===fingerprint)return fingerprint;
 let pending=cache.pending.get(fingerprint);
 if(!pending){
  pending=(async()=>{
   try{let revision:number;let tenants;let data:ReadWorkspaceData|undefined;
    if(onLoaded){const loaded=await readColdImportSnapshot(client,tenantId);tenants=loaded.data.store.tenants;revision=loaded.revision;data=loaded.data;}
    else{const loaded=await verifyColdImports(client,tenantId);tenants=loaded.tenants;revision=loaded.revision;}
    if(tenants.length!==1||tenants[0].id!==tenantId||tenants[0].status!=='ACTIVE')throw new DomainError(403,'企业不存在或已停用');
    if(data)onLoaded?.(data);const proof={fingerprint,tenantId,revision};cache.proof=proof;return proof;
   }catch(e){if(e instanceof DomainError)throw e;throw new DomainError(503,'企业只读数据完整性校验失败，请联系管理员');}
  })();cache.pending.set(fingerprint,pending);
 }
 try{await pending;return fingerprint;}finally{if(cache.pending.get(fingerprint)===pending)cache.pending.delete(fingerprint);}
}
export async function verifySqlRead(pool:object,client:pg.PoolClient,tenantId:string):Promise<void>{await verifiedReadStamp(pool,client,tenantId);}
