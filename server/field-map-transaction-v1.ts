import pg from 'pg';
import type {ClientConfig,Client} from 'pg';
import {DomainMapSnapshot,domainMapAssert as need} from './domain-map-v4.ts';
import {inspectStateMapCatalog} from './state-map-catalog-v1.ts';
import {PostgresStateMapV1,StateMapCommitUnknownError,type StateMapBinding,type StateHead,type StateCommand} from './state-map-sql-v1.ts';
import {stateRequestDigest,stateReceiptHash,type StateOperation,type StateReceipt} from './state-map-v1.ts';
export type FieldMapGuardPhaseV1='READ'|'WRITE'|'PRECOMMIT'|'POSTCOMMIT';
export type FieldMapGuardV1=(phase:FieldMapGuardPhaseV1,signal?:AbortSignal)=>Promise<void>;
export function checkFieldMapSignalV1(signal?:AbortSignal){if(signal?.aborted)throw Object.assign(Error('FIELD_MAP_CANCELLED'),{code:'FIELD_MAP_CANCELLED'});}

/** The host supplies the current registered identity/recovery guard. No default permit. */
export class FieldMapTransactionsV1 {
 readonly tenantId:string;#account:ClientConfig;#binding:StateMapBinding;#guard:FieldMapGuardV1;#state:PostgresStateMapV1;
 constructor(account:ClientConfig,binding:StateMapBinding,guard:FieldMapGuardV1){
  need(typeof guard==='function','FIELD_MAP_GUARD_REQUIRED');this.#account={...account,application_name:'idms-field-map-v1',connectionTimeoutMillis:5000};this.#binding=Object.freeze({...binding});this.tenantId=binding.tenantId;this.#guard=guard;this.#state=new PostgresStateMapV1(this.#account,this.#binding);
 }
 async assertCurrent(phase:FieldMapGuardPhaseV1,signal?:AbortSignal){checkFieldMapSignalV1(signal);await this.#guard(phase,signal);checkFieldMapSignalV1(signal);}
 async snapshot(signal?:AbortSignal){await this.assertCurrent('READ',signal);const s=await DomainMapSnapshot.open(this.#account,this.#binding);try{await this.assertCurrent('READ',signal);return s;}catch(e){await s.close();throw e;}}
 async #check(c:Client){const r=(await c.query('SELECT (SELECT oid::text FROM pg_database WHERE datname=current_database()) AS db,session_user::regrole::oid::text AS role')).rows[0];need(r.db===this.#binding.databaseOid&&r.role===this.#binding.roleOid,'FIELD_MAP_CONNECTION_BINDING');need(await inspectStateMapCatalog(c)===this.#binding.catalogHash,'FIELD_MAP_CATALOG_DRIFT');}
 async commit(head:StateHead,commandId:string,input:StateOperation[],signal?:AbortSignal,beforeCommit?:()=>Promise<void>):Promise<StateReceipt>{
  const operations=structuredClone(input),command:StateCommand={tenantId:this.tenantId,commandId,expectedRevision:head.revision,expectedRoot:head.rootHash,operations},requestHash=stateRequestDigest(this.tenantId,commandId,head.revision,head.rootHash,operations),c=new pg.Client(this.#account);c.on('error',()=>{});let committing=false,committed=false,connected=false;
  try{
   await this.assertCurrent('WRITE',signal);await c.connect();connected=true;
   await c.query('BEGIN');await c.query("SET LOCAL lock_timeout='10s'");await c.query("SET LOCAL statement_timeout='30s'");await this.#check(c);await this.assertCurrent('WRITE',signal);
   const receipt=(await c.query('SELECT state_map_v1.apply_delta_v1($1,$2,$3,$4,$5::jsonb) AS value',[this.tenantId,commandId,head.revision,Buffer.from(head.rootHash,'hex'),JSON.stringify(operations)])).rows[0].value as StateReceipt;
   need(receipt&&receipt.tenantId===this.tenantId&&receipt.commandId===commandId&&receipt.requestHash===requestHash&&receipt.beforeRevision===head.revision&&receipt.beforeRoot===head.rootHash&&receipt.beforeReceiptHash===head.receiptHash&&BigInt(receipt.revision)===BigInt(head.revision)+1n&&typeof receipt.replayed==='boolean'&&receipt.receiptHash===stateReceiptHash(receipt),'FIELD_MAP_RECEIPT_INTEGRITY');
   await this.#check(c);await this.assertCurrent('PRECOMMIT',signal);await beforeCommit?.();await this.assertCurrent('PRECOMMIT',signal);
   committing=true;const result=await c.query('COMMIT');need(result.command==='COMMIT','FIELD_MAP_COMMIT_UNCONFIRMED');committed=true;
   await this.assertCurrent('POSTCOMMIT',signal);return receipt;
  }catch(error){
   if(committing&&!committed){
    const unknown=new StateMapCommitUnknownError(commandId,requestHash,error);await c.end().catch(()=>{});
    await this.assertCurrent('READ',signal);try{const resolved=await this.#state.resolve(command);if(resolved){await this.assertCurrent('POSTCOMMIT',signal);return resolved;}}catch(resolveError){throw new StateMapCommitUnknownError(commandId,requestHash,{commitError:error,resolveError});}throw unknown;
   }
   if(connected&&!committed)await c.query('ROLLBACK').catch(()=>{});throw error;
  }finally{await c.end().catch(()=>{});}
 }
}
