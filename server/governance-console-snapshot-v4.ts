// No retained value cache: file verification/output has fixed-size windows.
import pg from 'pg';
import type {ClientConfig,Client} from 'pg';
import type {StateMapBinding,StateHead} from './state-map-sql-v1.ts';
import {inspectStateMapCatalog} from './state-map-catalog-v1.ts';
import {stateKey,verifyStateProof} from './state-map-v1.ts';
import {domainMapAssert as need} from './domain-map-v4.ts';
/** trustedHistory is only supplied after server-authenticated cursor decoding. */
export class GovernanceConsoleSnapshotV4 {
 readonly currentHead:StateHead;readonly tenantId:string;readonly stats={keys:0,nodes:0,valueBytes:0};
 #client:Client;#binding:StateMapBinding;#closed=false;#maximumBytes:number;
 private constructor(c:Client,binding:StateMapBinding,head:StateHead,maximumBytes:number){this.#maximumBytes=maximumBytes;this.#client=c;this.#binding=binding;this.currentHead=Object.freeze({...head});this.tenantId=binding.tenantId;}
 static async open(account:ClientConfig,binding:StateMapBinding,{file=false}:{file?:boolean}={}){const c=new pg.Client({...account,connectionTimeoutMillis:3000,query_timeout:15000,statement_timeout:10000});c.on('error',()=>{});try{await c.connect();await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');const id=(await c.query('SELECT (SELECT oid::text FROM pg_database WHERE datname=current_database()) AS db,session_user::regrole::oid::text AS role')).rows[0];need(id.db===binding.databaseOid&&id.role===binding.roleOid,'READ_DATABASE_BINDING');need(await inspectStateMapCatalog(c)===binding.catalogHash,'READ_DATABASE_CATALOG');const head=(await c.query('SELECT state_map_v1.read_head_v1($1) AS value',[binding.tenantId])).rows[0].value;return new GovernanceConsoleSnapshotV4(c,binding,head,file?40*1024*1024:16*1024*1024);}catch(e){await c.query('ROLLBACK').catch(()=>{});await c.end().catch(()=>{});throw e;}}
 async state(namespace:string,key:string,trustedHistory?:StateHead){need(!this.#closed,'READ_SNAPSHOT_CLOSED');const head=trustedHistory||this.currentHead,k=stateKey(this.tenantId,namespace,key);
  const p=(await this.#client.query('SELECT state_map_v1.read_proof_v1($1,$2,$3) AS value',[this.tenantId,Buffer.from(k,'hex'),head.rootId===null?null:Buffer.from(head.rootId,'hex')])).rows[0].value,v=verifyStateProof(p,head,k);this.stats.keys++;this.stats.nodes+=p.nodes.length;this.stats.valueBytes+=p.valueText===null?0:Buffer.byteLength(p.valueText);need(this.stats.keys<=2048&&this.stats.valueBytes<=this.#maximumBytes,'CONSOLE_READ_BUDGET');return structuredClone(v);
 }
 async get<T=unknown>(namespace:string,key:string,trustedHistory?:StateHead):Promise<T>{const r=await this.state(namespace,key,trustedHistory);need(r.present,'READ_REQUIRED_MISSING');return r.value as T;}
 async close(){if(this.#closed)return;this.#closed=true;try{need(await inspectStateMapCatalog(this.#client)===this.#binding.catalogHash,'READ_DATABASE_CATALOG');await this.#client.query('COMMIT');}catch(e){await this.#client.query('ROLLBACK').catch(()=>{});throw e;}finally{await this.#client.end().catch(()=>{});}}
}
