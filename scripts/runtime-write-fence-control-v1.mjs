import pg from 'pg';
import {canonical} from '../server/imports.ts';
import {IdentityAuthorityGuardV1,authorityRuntimeV1} from '../server/identity-authority-live-v1.ts';
import {openAuthoritySqliteV1,readAuthorityHeadSqliteV1} from '../server/identity-authority-store-v1.ts';
import {inspectRuntimeWriteFenceCatalogV1} from './runtime-write-fence-catalog-v1.mjs';
const need=(v,m)=>{if(!v)throw Error(m);};
const lock='SELECT pg_advisory_xact_lock(1229213011,905001)';
const stateSql='SELECT runtime_write_fence_v1.set_state_v1($1,$2,$3,$4,$5,$6,$7) AS value';
function matches(f,b){need(f.identity.system_id===b.systemIdentifier&&String(f.identity.database_oid)===b.databaseOid&&f.identity.database===b.database&&String(f.state.owner_oid)===b.ownerOid&&String(f.state.control_oid)===b.controlOid&&f.state.deployment===b.deployment,'RUNTIME_FENCE_BINDING');}
/** One-time seal for a newly provisioned, CLOSED database. No repair/rebaseline path. */
export async function finalizeRuntimeWriteFenceV1(account){
 const c=new pg.Client({...account,application_name:'idms-fence-finalize',connectionTimeoutMillis:5000});await c.connect();try{
  await c.query('BEGIN');await c.query(lock);const f=await inspectRuntimeWriteFenceCatalogV1(c);need(!f.state.finalized&&f.state.state==='CLOSED','RUNTIME_FENCE_FINALIZE_ONCE_CLOSED');
  const epoch=(await c.query('SELECT CASE WHEN is_called THEN last_value ELSE 0 END AS epoch FROM runtime_write_fence_v1._ddl_epoch')).rows[0].epoch;
  await c.query('UPDATE runtime_write_fence_v1._state SET finalized=true,ddl_epoch=$1,catalog_hash=$2 WHERE singleton',[epoch,f.catalogHash]);
  const binding={format:'RUNTIME_WRITE_FENCE_BINDING_V1',deployment:f.state.deployment,host:account.host,port:account.port,systemIdentifier:f.identity.system_id,database:account.database,databaseOid:String(f.identity.database_oid),ownerOid:String(f.state.owner_oid),controlOid:String(f.state.control_oid),actorOids:f.actorOids,catalogHash:f.catalogHash};await c.query('COMMIT');return binding;
 }catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}finally{await c.end();}
}
export class RuntimeWriteFenceControlV1{
 #account;#binding;
 constructor(account,binding){need(binding?.format==='RUNTIME_WRITE_FENCE_BINDING_V1'&&account.host===binding.host&&account.port===binding.port&&account.database===binding.database&&/^[a-f0-9]{64}$/.test(binding.catalogHash),'RUNTIME_FENCE_BINDING_INPUT');this.#account=structuredClone(account);this.#binding=structuredClone(binding);}
 async #run(fn){const c=new pg.Client({...this.#account,application_name:'idms-fence-control',connectionTimeoutMillis:5000});await c.connect();try{await c.query('BEGIN');const r=await fn(c);await c.query('COMMIT');return r;}catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}finally{await c.end();}}
 async close({expectedRevision,operationId}){
  // Always usable when IAM is unavailable or catalog has drifted. Does not reopen.
  return this.#run(async c=>{const s=(await c.query("SELECT s.*,(pg_control_system()).system_identifier::text AS system_id,current_database() AS database,session_user::regrole::oid AS caller FROM runtime_write_fence_v1._state s")).rows[0];matches({state:s,identity:{system_id:s.system_id,database_oid:s.database_oid,database:s.database}},this.#binding);need(s.caller===s.control_oid,'RUNTIME_FENCE_CONTROL_ONLY');return(await c.query(stateSql,[this.#binding.deployment,expectedRevision,operationId,'CLOSED',null,null,null])).rows[0].value;});
 }
 async open({expectedRevision,operationId,authority}){
  const config=authorityRuntimeV1(authority),db=await openAuthoritySqliteV1(config.trust,true);
  try{db.exec('BEGIN IMMEDIATE;');const head=readAuthorityHeadSqliteV1(db,config.trust);need(head?.event.phase==='ACTIVE','RUNTIME_FENCE_AUTHORITY_NOT_ACTIVE');
   const result=await this.#run(async c=>{await c.query(lock);const f=await inspectRuntimeWriteFenceCatalogV1(c);matches(f,this.#binding);need(f.state.finalized&&f.state.catalog_hash===this.#binding.catalogHash&&f.catalogHash===this.#binding.catalogHash&&canonical(f.actorOids)===canonical(this.#binding.actorOids),'RUNTIME_FENCE_CATALOG_CHANGED');
    const epoch=(await c.query('SELECT CASE WHEN is_called THEN last_value ELSE 0 END AS epoch FROM runtime_write_fence_v1._ddl_epoch')).rows[0].epoch;need(epoch===f.state.ddl_epoch,'RUNTIME_FENCE_CATALOG_CHANGED');
    const current=await new IdentityAuthorityGuardV1(config).assertCurrent();need(current.hash===head.hash,'RUNTIME_FENCE_AUTHORITY_CHANGED');
    return(await c.query(stateSql,[this.#binding.deployment,expectedRevision,operationId,'OPEN',current.event.authorityId,current.event.epoch,current.hash])).rows[0].value;
   });db.exec('COMMIT;');return result;
  }catch(e){try{db.exec('ROLLBACK;');}catch{}throw e;}finally{db.close();}
 }
}
