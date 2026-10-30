import type {ClientConfig,Client} from 'pg';
import {FieldMapTransactionsV2} from './field-map-transaction-v2.ts';
import {checkFieldMapSignalV1,type FieldMapGuardV1,type FieldMapGuardPhaseV1} from './field-map-transaction-v1.ts';
import {FieldMapIntakeOwnerV1} from './field-map-intake-owner-v1.ts';
import {PostgresStateMapV1,StateMapCommitUnknownError,type StateMapBinding,type StateHead} from './state-map-sql-v1.ts';
import {stateRequestDigest,stateReceiptHash,type StateReceipt,type StateOperation} from './state-map-v1.ts';
import {inspectStateMapCatalog} from './state-map-catalog-v1.ts';
import {domainMapAssert as need} from './domain-map-v4.ts';
export class FieldMapOwnedTransactionsV1 extends FieldMapTransactionsV2 {
 readonly #owner:FieldMapIntakeOwnerV1;readonly #state:PostgresStateMapV1;
 constructor(account:ClientConfig,binding:StateMapBinding,guard:FieldMapGuardV1,owner:FieldMapIntakeOwnerV1){super(account,binding,guard);this.#owner=owner;this.#state=new PostgresStateMapV1(account,binding);}
 override async assertCurrent(phase:FieldMapGuardPhaseV1,signal?:AbortSignal){this.#owner.requireHeld();await super.assertCurrent(phase,signal);this.#owner.requireHeld();}
 async #check(c:Client){const r=(await c.query('SELECT (SELECT oid::text FROM pg_database WHERE datname=current_database()) AS db,session_user::regrole::oid::text AS role')).rows[0];need(r.db===this.binding.databaseOid&&r.role===this.binding.roleOid,'FIELD_MAP_CONNECTION_BINDING');need(await inspectStateMapCatalog(c)===this.binding.catalogHash,'FIELD_MAP_CATALOG_DRIFT');await this.#owner.prove(c);}
 override async commit(head:StateHead,commandId:string,input:StateOperation[],signal?:AbortSignal,beforeCommit?:()=>Promise<void>):Promise<StateReceipt>{
  const operations=structuredClone(input),requestHash=stateRequestDigest(this.tenantId,commandId,head.revision,head.rootHash,operations),command={tenantId:this.tenantId,commandId,expectedRevision:head.revision,expectedRoot:head.rootHash,operations};await this.assertCurrent('WRITE',signal);
  return this.#owner.execute(async c=>{let committing=false,committed=false;
   try{await this.assertCurrent('WRITE',signal);await c.query('BEGIN');await c.query("SET LOCAL lock_timeout='10s'");await c.query("SET LOCAL statement_timeout='30s'");await this.#check(c);
    const receipt=(await c.query('SELECT state_map_v1.apply_delta_v1($1,$2,$3,$4,$5::jsonb) AS value',[this.tenantId,commandId,head.revision,Buffer.from(head.rootHash,'hex'),JSON.stringify(operations)])).rows[0].value as StateReceipt;
    need(receipt&&receipt.tenantId===this.tenantId&&receipt.commandId===commandId&&receipt.requestHash===requestHash&&receipt.beforeRevision===head.revision&&receipt.beforeRoot===head.rootHash&&receipt.beforeReceiptHash===head.receiptHash&&BigInt(receipt.revision)===BigInt(head.revision)+1n&&typeof receipt.replayed==='boolean'&&receipt.receiptHash===stateReceiptHash(receipt),'FIELD_MAP_RECEIPT_INTEGRITY');
    await this.#check(c);await this.assertCurrent('PRECOMMIT',signal);await beforeCommit?.();await this.assertCurrent('PRECOMMIT',signal);await this.#owner.prove(c);checkFieldMapSignalV1(signal);
    committing=true;const result=await c.query('COMMIT');need(result.command==='COMMIT','FIELD_MAP_COMMIT_UNCONFIRMED');committed=true;await this.assertCurrent('POSTCOMMIT',signal);return receipt;
   }catch(error){
    if(committing&&!committed){await this.#owner.invalidate(c);try{const resolved=await this.#state.resolve(command);if(resolved){await this.assertCurrent('POSTCOMMIT',signal);return resolved;}}catch(resolveError){throw new StateMapCommitUnknownError(commandId,requestHash,{commitError:error,resolveError});}throw new StateMapCommitUnknownError(commandId,requestHash,error);}
    if(!committed)await c.query('ROLLBACK').catch(()=>{});throw error;
   }
  });
 }
}
