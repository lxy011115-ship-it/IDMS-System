import {canonical,digest} from './imports.ts';
import {DomainError} from './service.ts';
import {requestSignal,CapacityError} from './capacity.ts';
export const sparesAuditFailure=()=>new DomainError(503,'备件业务历史暂无法核验，请联系管理员');
export const checkSparesRead=()=>{if(requestSignal()?.aborted)throw new CapacityError(499,'请求已取消','REQUEST_CANCELLED');};
export interface SpareAuditRow {sequence:string;site_code:string;body:any;hash:string}
/** New capability events deliberately fail the old canonical-only verifier. */
export function spareEventHash(body:any){
 if(body?.wireVersion===undefined)return digest(canonical(body));
 if(body.wireVersion!==2)throw sparesAuditFailure();
 return digest('IDMS-SPARES-EVENT-V2\0'+canonical(body));
}
export class SparesAuditChain {
 readonly tenantId:string;sequence=0n;previous='GENESIS';
 constructor(tenantId:string){this.tenantId=tenantId;}
 accept(row:SpareAuditRow){
  checkSparesRead();const b=row.body;this.sequence++;
  if(row.sequence!==this.sequence.toString()||!b||b.tenantId!==this.tenantId||b.previousHash!==this.previous||spareEventHash(b)!==row.hash||!Array.isArray(b.after)||!b.after.length||!Array.isArray(b.before)||b.before.length!==b.after.length||typeof b.actor!=='string'||typeof b.action!=='string'||typeof b.at!=='string'||!Number.isFinite(Date.parse(b.at)))throw sparesAuditFailure();
  const records=[...b.after,...b.before.filter(Boolean)];if(records.some(e=>!e||e.tenantId!==this.tenantId||e.siteCode!==row.site_code||typeof e.id!=='string'||typeof e.kind!=='string'))throw sparesAuditFailure();this.previous=row.hash;
 }
 finish(revision?:string){if(revision!==undefined&&revision!==this.sequence.toString())throw sparesAuditFailure();return {sequence:this.sequence,previous:this.previous};}
}
