import {createCipheriv,createDecipheriv,hkdfSync,randomBytes} from 'node:crypto';
import {validateKeyRing,stable,type KeyRing} from './auth-state.ts';
import type {GovernanceJobV4,GovernanceQueueBindingV4} from './governance-job-store-v4.ts';
import {domainMapAssert as need} from './domain-map-v4.ts';
type Purpose='COMMAND'|'GRANT';
export interface GovernanceAuthReferenceV4 {kind:'BEARER'|'SESSION';value:string}
interface Box {format:1;keyId:string;iv:string;tag:string;data:string}
export class GovernanceJobCryptoV4 {
 #ring:KeyRing;#binding:GovernanceQueueBindingV4;
 constructor(ring:KeyRing,binding:GovernanceQueueBindingV4){this.#ring=structuredClone(validateKeyRing(ring));this.#binding=Object.freeze({...binding});}
 #aad(job:Pick<GovernanceJobV4,'id'|'actorId'|'commandId'|'requestHash'>,purpose:Purpose,revision:string,keyId:string){return Buffer.from(stable({purpose:'IDMS_GOVERNANCE_JOB_V4_'+purpose,deployment:this.#binding.deployment,databaseOid:this.#binding.databaseOid,tenantId:this.#binding.tenantId,jobId:job.id,actorId:job.actorId,commandId:job.commandId,requestHash:job.requestHash,revision,keyId}));}
 #key(keyId:string,purpose:Purpose){const k=this.#ring.keys.find(k=>k.keyId===keyId);need(k,'GOVERNANCE_JOB_KEY');return Buffer.from(hkdfSync('sha256',Buffer.from(k!.key,'base64url'),Buffer.from('IDMS_GOVERNANCE_JOB_V4\0'+this.#binding.deployment),Buffer.from(purpose),32));}
 seal(value:unknown,job:Pick<GovernanceJobV4,'id'|'actorId'|'commandId'|'requestHash'>,purpose:Purpose,revision='1'):Box{const plain=Buffer.from(JSON.stringify(value));need(plain.length<=(purpose==='COMMAND'?16*1024*1024:49152),'GOVERNANCE_JOB_PLAINTEXT_LIMIT');const keyId=this.#ring.activeKeyId,iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',this.#key(keyId,purpose),iv);cipher.setAAD(this.#aad(job,purpose,revision,keyId));const data=Buffer.concat([cipher.update(plain),cipher.final()]);return {format:1,keyId,iv:iv.toString('base64url'),tag:cipher.getAuthTag().toString('base64url'),data:data.toString('base64url')};}
 open(value:unknown,job:Pick<GovernanceJobV4,'id'|'actorId'|'commandId'|'requestHash'>,purpose:Purpose,revision='1'){
  try{const v=value as Box;need(v&&v.format===1&&Object.keys(v).sort().join(',')==='data,format,iv,keyId,tag'&&typeof v.keyId==='string'&&/^[A-Za-z0-9_-]{1,80}$/.test(v.keyId));const decode=(x:string)=>{need(typeof x==='string'&&/^[A-Za-z0-9_-]+$/.test(x));const b=Buffer.from(x,'base64url');need(b.toString('base64url')===x);return b;},iv=decode(v.iv),tag=decode(v.tag);need(iv.length===12&&tag.length===16&&typeof v.data==='string'&&v.data.length<=(purpose==='COMMAND'?24*1024*1024:65536));const data=decode(v.data),cipher=createDecipheriv('aes-256-gcm',this.#key(v.keyId,purpose),iv);cipher.setAAD(this.#aad(job,purpose,revision,v.keyId));cipher.setAuthTag(tag);const plain=Buffer.concat([cipher.update(data),cipher.final()]);need(plain.length<=(purpose==='COMMAND'?16*1024*1024:49152));return JSON.parse(plain.toString('utf8'));
  }catch{throw Object.assign(Error('GOVERNANCE_JOB_SEALED_INTEGRITY'),{code:'GOVERNANCE_JOB_SEALED_INTEGRITY'});}
 }
}
