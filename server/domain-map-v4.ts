import pg from 'pg';
import type {ClientConfig,Client} from 'pg';
import {inspectStateMapCatalog} from './state-map-catalog-v1.ts';
import {PostgresStateMapV1,StateMapCommitUnknownError,type StateMapBinding,type StateHead,type StateCommand} from './state-map-sql-v1.ts';
import {stateKey,verifyStateProof,stateValueText,type StateOperation,type StateReceipt} from './state-map-v1.ts';
export function domainMapAssert(ok:unknown,code='DOMAIN_MAP_INTEGRITY'):asserts ok{if(!ok)throw Object.assign(Error(code),{code});}
type Resolved={present:boolean;value:unknown;valueHash:string|null};
export class DomainMapSnapshot {
 readonly head:StateHead;readonly tenantId:string;readonly stats={keys:0,nodes:0,valueBytes:0};
 #client:Client;#binding:StateMapBinding;#cache=new Map<string,Resolved>();#closed=false;#maintenance:boolean;
 private constructor(client:Client,binding:StateMapBinding,head:StateHead,maintenance:boolean){this.#client=client;this.#binding=binding;this.tenantId=binding.tenantId;this.head=Object.freeze({...head});this.#maintenance=maintenance;}
 static async open(account:ClientConfig,binding:StateMapBinding,{maintenance=false}:{maintenance?:boolean}={}){
  const c=new pg.Client(account);c.on('error',()=>{});
  try{await c.connect();await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');const identity=(await c.query('SELECT (SELECT oid::text FROM pg_database WHERE datname=current_database()) AS db,session_user::regrole::oid::text AS role')).rows[0];domainMapAssert(identity.db===binding.databaseOid&&identity.role===binding.roleOid,'DOMAIN_MAP_BINDING');domainMapAssert(await inspectStateMapCatalog(c)===binding.catalogHash,'DOMAIN_MAP_CATALOG');const head=(await c.query('SELECT state_map_v1.read_head_v1($1) AS value',[binding.tenantId])).rows[0].value;return new DomainMapSnapshot(c,binding,head,maintenance);}catch(e){await c.query('ROLLBACK').catch(()=>{});await c.end().catch(()=>{});throw e;}
 }
 async state(namespace:string,key:string):Promise<Resolved>{
  domainMapAssert(!this.#closed,'DOMAIN_MAP_SNAPSHOT_CLOSED');const k=stateKey(this.tenantId,namespace,key),cached=this.#cache.get(k);if(cached)return structuredClone(cached);
  const proof=(await this.#client.query('SELECT state_map_v1.read_proof_v1($1,$2,$3) AS value',[this.tenantId,Buffer.from(k,'hex'),this.head.rootId===null?null:Buffer.from(this.head.rootId,'hex')])).rows[0].value,result=verifyStateProof(proof,this.head,k);if(!this.#maintenance)this.#cache.set(k,result);this.stats.keys++;this.stats.nodes+=proof.nodes.length;this.stats.valueBytes+=proof.valueText===null?0:Buffer.byteLength(proof.valueText);domainMapAssert(this.stats.keys<=(this.#maintenance?2000000:256)&&this.stats.valueBytes<=(this.#maintenance?1024*1024*1024:16*1024*1024),'DOMAIN_MAP_READ_BUDGET');return structuredClone(result);
 }
 async get<T=unknown>(namespace:string,key:string):Promise<T>{const s=await this.state(namespace,key);domainMapAssert(s.present,'DOMAIN_MAP_REQUIRED_MISSING');return s.value as T;}
 async operation(namespace:string,key:string,value:unknown):Promise<StateOperation>{const s=await this.state(namespace,key);return {namespace,key,expected:s.valueHash,valueText:stateValueText(value)};}
 async close(){if(this.#closed)return;this.#closed=true;try{domainMapAssert(await inspectStateMapCatalog(this.#client)===this.#binding.catalogHash,'DOMAIN_MAP_CATALOG');await this.#client.query('COMMIT');}catch(e){await this.#client.query('ROLLBACK').catch(()=>{});throw e;}finally{await this.#client.end().catch(()=>{});}}
}
export class DomainMapV4 {
 readonly tenantId:string;#account:ClientConfig;#binding:StateMapBinding;#state:PostgresStateMapV1;
 constructor(account:ClientConfig,binding:StateMapBinding){this.#account={...account};this.#binding=Object.freeze({...binding});this.#state=new PostgresStateMapV1(account,binding);this.tenantId=binding.tenantId;}
 snapshot(){return DomainMapSnapshot.open(this.#account,this.#binding);}
 head(){return this.#state.head();}
 async commit(head:StateHead,commandId:string,operations:StateOperation[]):Promise<StateReceipt>{
  const command:StateCommand={tenantId:this.tenantId,commandId,expectedRevision:head.revision,expectedRoot:head.rootHash,operations};
  try{return await this.#state.apply(command);}catch(e){if(!(e instanceof StateMapCommitUnknownError))throw e;try{const resolved=await this.#state.resolve(command);if(resolved)return resolved;}catch(resolveError){throw new StateMapCommitUnknownError(e.commandId,e.requestHash,{commitError:e,resolveError});}throw e;}
 }
}
