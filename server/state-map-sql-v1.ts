import pg from 'pg';
import type {ClientConfig,Client} from 'pg';
import {inspectStateMapCatalog} from './state-map-catalog-v1.ts';
import {stateKey,stateRequestDigest,stateReceiptHash,verifyStateProof,StateMapError,type StateRoot,type StateReceipt,type StateOperation,type StateProof} from './state-map-v1.ts';
export interface StateHead extends StateRoot {revision:string;receiptHash:string}
export interface StateCommand {tenantId:string;commandId:string;expectedRevision:string;expectedRoot:string;operations:StateOperation[]}
export interface StateMapBinding {databaseOid:string;roleOid:string;catalogHash:string;tenantId:string}
export class StateMapCommitUnknownError extends Error {
 commandId:string;requestHash:string;
 constructor(commandId:string,requestHash:string,cause:unknown){super('STATE_MAP_COMMIT_UNKNOWN',{cause});this.commandId=commandId;this.requestHash=requestHash;}
}
function ensure(value:unknown,code:string):asserts value{if(!value)throw new StateMapError(code);}
const raw=(hex:string)=>{ensure(/^[a-f0-9]{64}$/.test(hex),'STATE_MAP_INVALID');return Buffer.from(hex,'hex');};
function operationClient(account:ClientConfig){const c=new pg.Client(account);
 // pg also emits a connection error after rejecting an outstanding query.
 // Every operation awaits its queries; this prevents a second, unhandled process error.
 c.on('error',()=>{});return c;
}
/** A new connection per operation intentionally proves there is no authoritative process cache. */
export class PostgresStateMapV1 {
 #account:ClientConfig;#binding:StateMapBinding;
 constructor(account:ClientConfig,binding:StateMapBinding){this.#account={...account};this.#binding=Object.freeze({...binding});}
 async #check(client:Client){
  const r=(await client.query(`SELECT (SELECT oid::text FROM pg_database WHERE datname=current_database()) AS db,session_user::regrole::oid::text AS role`)).rows[0];
  ensure(r.db===this.#binding.databaseOid&&r.role===this.#binding.roleOid,'STATE_MAP_CONNECTION_BINDING');
  ensure(await inspectStateMapCatalog(client)===this.#binding.catalogHash,'STATE_MAP_CATALOG_DRIFT');
 }
 async #read<T>(operation:(c:Client)=>Promise<T>){
  const c=operationClient(this.#account);await c.connect();try{await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');await this.#check(c);const value=await operation(c);await this.#check(c);await c.query('COMMIT');return value;}catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}finally{await c.end().catch(()=>{});}
 }
 async head():Promise<StateHead>{return this.#read(async c=>(await c.query('SELECT state_map_v1.read_head_v1($1) AS value',[this.#binding.tenantId])).rows[0].value);}
 async proof(namespace:string,key:string,trustedRoot:StateRoot){
  const keyHash=stateKey(this.#binding.tenantId,namespace,key);
  return this.#read(async c=>{const proof:StateProof=(await c.query('SELECT state_map_v1.read_proof_v1($1,$2,$3) AS value',[this.#binding.tenantId,raw(keyHash),trustedRoot.rootId===null?null:raw(trustedRoot.rootId)])).rows[0].value;
   return {proof,result:verifyStateProof(proof,trustedRoot,keyHash)};
  });
 }
 #receipt(value:StateReceipt,command:StateCommand,requestHash:string){
  ensure(value&&value.tenantId===this.#binding.tenantId&&value.commandId===command.commandId&&value.requestHash===requestHash&&value.beforeRevision===command.expectedRevision&&value.beforeRoot===command.expectedRoot&&BigInt(value.revision)===BigInt(value.beforeRevision)+1n&&typeof value.replayed==='boolean'&&value.receiptHash===stateReceiptHash(value),'STATE_MAP_RECEIPT_INTEGRITY');return value;
 }
 #request(command:StateCommand){ensure(command.tenantId===this.#binding.tenantId,'STATE_MAP_AUTHORITY');return stateRequestDigest(command.tenantId,command.commandId,command.expectedRevision,command.expectedRoot,command.operations);}
 async apply(command:StateCommand):Promise<StateReceipt>{
  const requestHash=this.#request(command),c=operationClient(this.#account);await c.connect();let committing=false;
  try{
   await c.query('BEGIN');await c.query("SET LOCAL lock_timeout='10s'");await c.query("SET LOCAL statement_timeout='30s'");await this.#check(c);
   const value=this.#receipt((await c.query('SELECT state_map_v1.apply_delta_v1($1,$2,$3,$4,$5::jsonb) AS value',[command.tenantId,command.commandId,command.expectedRevision,raw(command.expectedRoot),JSON.stringify(command.operations)])).rows[0].value,command,requestHash);
   await this.#check(c);committing=true;const commit=await c.query('COMMIT');ensure(commit.command==='COMMIT','STATE_MAP_COMMIT_UNCONFIRMED');return value;
  }catch(e){if(committing)throw new StateMapCommitUnknownError(command.commandId,requestHash,e);await c.query('ROLLBACK').catch(()=>{});throw e;}finally{await c.end().catch(()=>{});}
 }
 async resolve(command:StateCommand):Promise<StateReceipt|null>{const requestHash=this.#request(command);return this.#read(async c=>{const value=(await c.query('SELECT state_map_v1.read_receipt_v1($1,$2,$3) AS value',[command.tenantId,command.commandId,raw(requestHash)])).rows[0].value;return value===null?null:this.#receipt(value,command,requestHash);});}
}
