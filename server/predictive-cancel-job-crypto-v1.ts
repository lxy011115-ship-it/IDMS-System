import {createCipheriv,createDecipheriv,hkdfSync,randomBytes} from 'node:crypto';
import {stable,validateKeyRing,type KeyRing} from './auth-state.ts';
import {domainMapAssert as need} from './domain-map-v4.ts';
import type {CancelQueueBindingV1,CancelJobMetaV1} from './predictive-cancel-job-store-v1.ts';
type Purpose='COMMAND'|'GRANT';
export class PredictiveCancelJobCryptoV1 {
 #binding:CancelQueueBindingV1;#ring:KeyRing;
 constructor(ring:KeyRing,binding:CancelQueueBindingV1){this.#ring=structuredClone(validateKeyRing(ring));this.#binding={...binding};}
 #aad(job:CancelJobMetaV1,purpose:Purpose,revision:string,keyId:string){return Buffer.from(stable({format:'IDMS_RECONCILIATION_JOB_V1',deployment:this.#binding.deployment,databaseOid:this.#binding.databaseOid,tenantId:this.#binding.tenantId,purpose,id:job.id,caseId:job.caseId,operationId:job.operationId,actorId:job.actorId,action:job.action,requestHash:job.requestHash,domainHash:job.domainHash,revision,keyId}));}
 #key(id:string,purpose:Purpose){const k=this.#ring.keys.find(k=>k.keyId===id);need(k,'RECON_JOB_KEY');return Buffer.from(hkdfSync('sha256',Buffer.from(k!.key,'base64url'),Buffer.from('IDMS_RECONCILIATION_JOB_V1\0'+this.#binding.deployment),Buffer.from(purpose),32));}
 seal(value:unknown,job:CancelJobMetaV1,purpose:Purpose,revision='1'){const plain=Buffer.from(JSON.stringify(value));need(plain.length<=32768,'RECON_JOB_PLAINTEXT_LIMIT');const keyId=this.#ring.activeKeyId,iv=randomBytes(12),c=createCipheriv('aes-256-gcm',this.#key(keyId,purpose),iv);c.setAAD(this.#aad(job,purpose,revision,keyId));return {format:1,keyId,iv:iv.toString('base64url'),data:Buffer.concat([c.update(plain),c.final()]).toString('base64url'),tag:c.getAuthTag().toString('base64url')};}
 open(value:unknown,job:CancelJobMetaV1,purpose:Purpose,revision='1'){
  try{const v=value as Record<string,any>;need(v&&v.format===1&&Object.keys(v).sort().join(',')==='data,format,iv,keyId,tag'&&typeof v.keyId==='string'&&/^[A-Za-z0-9_-]{1,80}$/.test(v.keyId));const decode=(s:string)=>{need(typeof s==='string'&&s.length<=49152&&/^[A-Za-z0-9_-]+$/.test(s));const bytes=Buffer.from(s,'base64url');need(bytes.toString('base64url')===s);return bytes;},iv=decode(v.iv),tag=decode(v.tag);need(iv.length===12&&tag.length===16);const c=createDecipheriv('aes-256-gcm',this.#key(v.keyId,purpose),iv);c.setAAD(this.#aad(job,purpose,revision,v.keyId));c.setAuthTag(tag);const plain=Buffer.concat([c.update(decode(v.data)),c.final()]);need(plain.length<=32768);return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(plain));}catch{throw Error('RECON_JOB_SEALED_INTEGRITY');}
 }
}
