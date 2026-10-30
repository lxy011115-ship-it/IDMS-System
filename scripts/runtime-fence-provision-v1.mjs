import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {canonical} from '../server/imports.ts';
import {authorityRuntimeV1,IdentityAuthorityGuardV1} from '../server/identity-authority-live-v1.ts';
import {openAuthoritySqliteV1,readAuthorityHeadSqliteV1} from '../server/identity-authority-store-v1.ts';
import {runtimeWriteFenceSchemaSqlV1,runtimeWriteFenceAttachSqlV1,restrictRuntimeWriteFenceActorsV1,wrapFreshRuntimeWriteFenceSqlV1} from './runtime-write-fence-schema-v1.mjs';
import {finalizeRuntimeWriteFenceV1,RuntimeWriteFenceControlV1} from './runtime-write-fence-control-v1.mjs';
import {inspectLegacyV3Fence} from './legacy-v4-source.mjs';
const need=(v,m)=>{if(!v)throw Error(m);};
export const wrapFencedSchemaV1=(sql,schema,beforeEventTrigger)=>wrapFreshRuntimeWriteFenceSqlV1(sql,{schema,beforeEventTrigger});
/** Trusted fresh installer only, explicit instance, no global pg hooks or accepted catalog rebaseline. */
export class RuntimeFenceProvisionV1{
 #authority;#admin;#records=new Map();#retired=new Map();#sealed=false;
 constructor(admin,authority){this.#admin=structuredClone(admin);this.#authority=authorityRuntimeV1(authority);}
 async install(c,{owner,actors}){
  need(!this.#sealed,'FENCE_PROVISION_SEALED');const database=(await c.query('SELECT current_database() AS name')).rows[0].name;need(!this.#records.has(database),'FENCE_PROVISION_DUPLICATE');need(!(await c.query("SELECT to_regnamespace('runtime_write_fence_v1') AS n")).rows[0].n,'FENCE_PROVISION_EXISTING');const deployment=randomUUID();
  await c.query(await runtimeWriteFenceSchemaSqlV1({owner,control:this.#admin.user,deployment}));await restrictRuntimeWriteFenceActorsV1(c,actors);this.#records.set(database,{database,deployment,owner,actors:[...actors]});await this.#openProvision(c,database);
 }
 async addActors(c,actors){need(!this.#sealed,'FENCE_PROVISION_SEALED');const database=(await c.query('SELECT current_database() AS name')).rows[0].name,r=this.#records.get(database);need(r,'FENCE_PROVISION_DATABASE');await restrictRuntimeWriteFenceActorsV1(c,actors);r.actors.push(...actors);}
 async attach(c,schema){need(!this.#sealed,'FENCE_PROVISION_SEALED');await c.query(runtimeWriteFenceAttachSqlV1(schema));}
 async registerLegacy(c,manifest){
  need(!this.#sealed,'FENCE_PROVISION_SEALED');const database=(await c.query('SELECT current_database() AS name')).rows[0].name;need(database===manifest?.source?.database&&!this.#records.has(database)&&!this.#retired.has(database),'FENCE_PROVISION_LEGACY_DATABASE');
  await c.query('BEGIN');try{const before=await inspectLegacyV3Fence(c,manifest),functions=(await c.query("SELECT oid::regprocedure::text AS signature FROM pg_proc WHERE pronamespace='pg_catalog'::regnamespace AND (proname LIKE 'lo\\_%' ESCAPE '\\' OR proname IN('lowrite','loread','loopen','loclose')) ORDER BY oid")).rows;
   const actor='"'+before.appRole.replaceAll('"','""')+'"';for(const f of functions)await c.query('REVOKE EXECUTE ON FUNCTION '+f.signature+' FROM PUBLIC,'+actor);const after=await inspectLegacyV3Fence(c,manifest);need(canonical(before)===canonical(after),'FENCE_PROVISION_LEGACY_CHANGED');
   need(!(await c.query("SELECT EXISTS(SELECT 1 FROM pg_proc WHERE pronamespace='pg_catalog'::regnamespace AND (proname LIKE 'lo\\_%' ESCAPE '\\' OR proname IN('lowrite','loread','loopen','loclose')) AND has_function_privilege($1::oid,oid,'EXECUTE')) AS unsafe",[manifest.source.roleOid])).rows[0].unsafe,'FENCE_PROVISION_LEGACY_LO');
   await c.query('COMMIT');this.#retired.set(database,{format:'RUNTIME_RETIRED_LEGACY_ACL_V1',database,source:manifest.source,proof:after,sourceManifest:manifest,largeObjectWriteDenied:true});
  }catch(e){await c.query('ROLLBACK');throw e;}
 }
 async #openProvision(c,database){
  const db=await openAuthoritySqliteV1(this.#authority.trust,true);try{db.exec('BEGIN IMMEDIATE;');const head=readAuthorityHeadSqliteV1(db,this.#authority.trust);need(head?.event.phase==='ACTIVE','FENCE_PROVISION_AUTHORITY');const actual=await new IdentityAuthorityGuardV1(this.#authority).assertCurrent();need(actual.hash===head.hash,'FENCE_PROVISION_AUTHORITY_CHANGED');const s=(await c.query('SELECT * FROM runtime_write_fence_v1._state')).rows[0];need(!s.finalized&&s.deployment===this.#records.get(database)?.deployment,'FENCE_PROVISION_STATE');await c.query('SELECT runtime_write_fence_v1.set_state_v1($1,$2,$3,\'OPEN\',$4,$5,$6)',[s.deployment,s.revision,randomUUID(),head.event.authorityId,head.event.epoch,head.hash]);db.exec('COMMIT;');}catch(e){try{db.exec('ROLLBACK;');}catch{}throw e;}finally{db.close();}
 }
 async sealAll(){
  need(!this.#sealed&&this.#records.size>0,'FENCE_PROVISION_SEALED');const result=[];
  // A failed seal remains CLOSED or in provisioning, never silently treated as READY.
  for(const r of this.#records.values()){const account={...this.#admin,database:r.database},c=new pg.Client(account);await c.connect();try{const s=(await c.query('SELECT * FROM runtime_write_fence_v1._state')).rows[0];await c.query('SELECT runtime_write_fence_v1.set_state_v1($1,$2,$3,\'CLOSED\',NULL,NULL,NULL)',[r.deployment,s.revision,randomUUID()]);}finally{await c.end();}const binding=await finalizeRuntimeWriteFenceV1(account);r.binding=binding;result.push(binding);}
  this.#sealed=true;for(const r of this.#records.values()){const c=new pg.Client({...this.#admin,database:r.database});await c.connect();let revision;try{revision=Number((await c.query('SELECT revision FROM runtime_write_fence_v1._state')).rows[0].revision);}finally{await c.end();}await new RuntimeWriteFenceControlV1({...this.#admin,database:r.database},r.binding).open({expectedRevision:revision,operationId:randomUUID(),authority:this.#authority});}
  return result.sort((a,b)=>a.database.localeCompare(b.database));
 }
 get manifest(){need(this.#sealed,'FENCE_PROVISION_NOT_SEALED');return [...this.#records.values()].map(r=>structuredClone(r.binding)).sort((a,b)=>a.database.localeCompare(b.database));}
 get provisioned(){return [...this.#records.values()].map(({database,deployment,owner,actors})=>({database,deployment,owner,actors:[...actors]}));}
 get retired(){return [...this.#retired.values()].map(r=>structuredClone(r)).sort((a,b)=>a.database.localeCompare(b.database));}
}
