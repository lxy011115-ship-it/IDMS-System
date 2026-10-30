import type pg from 'pg';
import {holdValue} from './capacity.ts';
import {streamRows} from './pg-row-stream.ts';
import {SparesAuditChain,checkSparesRead,type SpareAuditRow} from './spares-audit-chain.ts';
import {hasSpareProofScope} from './spares-proof-scope.ts';
import {spareAuditProofCache} from './spares-audit-proof.ts';
export {SparesAuditChain,checkSparesRead,sparesAuditFailure} from './spares-audit-chain.ts';
export type {SpareAuditRow} from './spares-audit-chain.ts';
/** Maintenance/legacy transactions always retain full body verification. */
export async function verifySpareAuditFull(client:pg.PoolClient,tenant:string,revision?:string){
 checkSparesRead();const chain=new SparesAuditChain(tenant);
 await streamRows<SpareAuditRow>(client,'/* IDMS_SPARES_AUDIT_STREAM */ SELECT sequence::text,site_code,body,hash FROM idms_spares.events WHERE tenant_id=$1 ORDER BY idms_spares.events.sequence',row=>{const release=holdValue(row);try{chain.accept(row);}finally{release();}},()=>{},[tenant]);
 checkSparesRead();return chain.finish(revision);
}
/** Every segment's metadata is checked; only unchanged, committed proofs reuse
 * body validation. No proof scope means an explicit full-stream fallback. */
export async function verifySpareAudit(client:pg.PoolClient,tenant:string,revision?:string){
 return revision!==undefined&&hasSpareProofScope(client)?spareAuditProofCache.verify(client,tenant,revision):verifySpareAuditFull(client,tenant,revision);
}
