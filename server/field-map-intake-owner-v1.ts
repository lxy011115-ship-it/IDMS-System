import pg from 'pg';
import type {Client,ClientConfig} from 'pg';
import {createHash} from 'node:crypto';
import {domainMapAssert as need} from './domain-map-v4.ts';
import {inspectStateMapCatalog} from './state-map-catalog-v1.ts';
import type {StateMapBinding} from './state-map-sql-v1.ts';
import type {FieldMapGuardV1} from './field-map-transaction-v1.ts';
const family=0x49444d47;
export class FieldMapIntakeOwnerV1 {
 readonly #account:ClientConfig;readonly #binding:StateMapBinding;readonly #guard:FieldMapGuardV1;readonly #key:number;#client:Client|null=null;#held=false;#closing=false;#closed=false;#acquiring:Promise<boolean>|null=null;#closeJob:Promise<void>|null=null;#tail:Promise<unknown>=Promise.resolve();readonly #jobs=new Set<Promise<unknown>>();readonly #ended=new WeakSet<Client>();#created=0;#retired=0;#pid:number|null=null;
 constructor(account:ClientConfig,binding:StateMapBinding,guard:FieldMapGuardV1){need(typeof guard==='function','FIELD_MAP_GUARD_REQUIRED');this.#account={...account,application_name:'idms-field-map-owner-v1',connectionTimeoutMillis:5000};this.#binding=Object.freeze({...binding});this.#guard=guard;this.#key=createHash('sha256').update(binding.tenantId).digest().readInt32BE(0);}
 get held(){return this.#held&&!this.#closing;}
 requireHeld(){need(this.held&&this.#client,'FIELD_MAP_RECEIVING_OWNER_LOST');}
 state(){return {held:this.held,closing:this.#closing,closed:this.#closed,active:this.#jobs.size,acquiring:!!this.#acquiring,backendPid:this.#pid,connectionsCreated:this.#created,connectionsRetired:this.#retired};}
 async #end(c:Client){if(this.#ended.has(c))return;this.#ended.add(c);const socket=(c as any).connection?.stream,closed=!socket||socket.closed?Promise.resolve():new Promise<void>(ok=>socket.once('close',()=>ok()));await c.end().catch(()=>{});await closed;this.#retired++;}
 async #identity(c:Client){const r=(await c.query('SELECT (SELECT oid::text FROM pg_database WHERE datname=current_database()) AS db,session_user::regrole::oid::text AS role,pg_backend_pid() AS pid')).rows[0];need(r.db===this.#binding.databaseOid&&r.role===this.#binding.roleOid&&Number.isSafeInteger(r.pid)&&r.pid>0,'FIELD_MAP_OWNER_BINDING');need(await inspectStateMapCatalog(c)===this.#binding.catalogHash,'FIELD_MAP_OWNER_CATALOG');return r;}
 async acquire(){
  if(this.#closing)return false;if(this.held)return true;if(this.#acquiring)return this.#acquiring;
  const work=(async()=>{await this.#tail.catch(()=>{});if(this.#client){const old=this.#client;this.#client=null;await this.#end(old);}if(this.#closing)return false;await this.#guard('READ');if(this.#closing)return false;const c=new pg.Client(this.#account);this.#created++;this.#client=c;const lost=()=>{if(this.#client===c)this.#held=false;};c.on('error',lost);c.once('end',lost);
   try{await c.connect();const identity=await this.#identity(c),row=(await c.query('SELECT pg_try_advisory_lock($1::int,$2::int) AS held',[family,this.#key])).rows[0];need(typeof row?.held==='boolean','FIELD_MAP_OWNER_LOCK');if(!row.held||this.#closing){this.#client=null;await this.#end(c);return false;}this.#held=true;this.#pid=identity.pid;await this.prove(c);await this.#guard('READ');this.requireHeld();return true;}catch(e){this.#held=false;if(this.#client===c)this.#client=null;await this.#end(c);throw e;}
  })();this.#acquiring=work;try{return await work;}finally{if(this.#acquiring===work)this.#acquiring=null;}
 }
 async prove(c:Client){this.requireHeld();need(c===this.#client,'FIELD_MAP_OWNER_CONNECTION');const r=(await c.query("SELECT EXISTS(SELECT 1 FROM pg_locks WHERE pid=pg_backend_pid() AND database=$1::oid AND locktype='advisory' AND classid=$2::oid AND objid=$3::oid AND objsubid=2 AND mode='ExclusiveLock' AND granted) AS held,pg_backend_pid() AS pid",[this.#binding.databaseOid,String(family),String(this.#key>>>0)])).rows[0];if(r?.held!==true||r.pid!==this.#pid)this.#held=false;need(this.#held,'FIELD_MAP_OWNER_LOCK_LOST');}
 execute<T>(task:(client:Client)=>Promise<T>):Promise<T>{
  this.requireHeld();need(this.#jobs.size<32,'FIELD_MAP_OWNER_CAPACITY');const work=this.#tail.then(async()=>{this.requireHeld();const c=this.#client!;await this.prove(c);return task(c);});this.#jobs.add(work);this.#tail=work.catch(()=>{});void work.finally(()=>this.#jobs.delete(work)).catch(()=>{});return work;
 }
 async invalidate(c:Client){need(c===this.#client,'FIELD_MAP_OWNER_CONNECTION');this.#held=false;this.#client=null;await this.#end(c);}
 close(){if(this.#closeJob)return this.#closeJob;this.#closing=true;this.#held=false;this.#closeJob=(async()=>{await this.#acquiring?.catch(()=>{});await Promise.allSettled([...this.#jobs]);const c=this.#client;this.#client=null;if(c)await this.#end(c);need(this.#created===this.#retired,'FIELD_MAP_OWNER_SOCKET_NOT_RETIRED');this.#closed=true;})();return this.#closeJob;}
}
