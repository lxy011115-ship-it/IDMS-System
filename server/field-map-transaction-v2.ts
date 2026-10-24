import type {ClientConfig} from 'pg';
import {DomainMapSnapshot} from './domain-map-v4.ts';
import type {StateMapBinding} from './state-map-sql-v1.ts';
import {FieldMapTransactionsV1,type FieldMapGuardV1} from './field-map-transaction-v1.ts';
/** Same guarded transaction primitive, with an explicit public storage binding. */
export class FieldMapTransactionsV2 extends FieldMapTransactionsV1 {
 readonly binding:Readonly<StateMapBinding>;#maintenanceAccount:ClientConfig;
 constructor(account:ClientConfig,binding:StateMapBinding,guard:FieldMapGuardV1){super(account,binding,guard);this.binding=Object.freeze({...binding});this.#maintenanceAccount={...account,application_name:'idms-field-map-v2-maintenance',connectionTimeoutMillis:5000};}
 async maintenanceSnapshot(signal?:AbortSignal){await this.assertCurrent('READ',signal);const s=await DomainMapSnapshot.open(this.#maintenanceAccount,this.binding,{maintenance:true});try{await this.assertCurrent('READ',signal);return s;}catch(e){await s.close();throw e;}}
}
