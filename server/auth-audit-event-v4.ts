import {createCipheriv,createDecipheriv,createHash,createHmac,hkdfSync,randomBytes} from 'node:crypto';
import {canonicalDigest,jsonWireClone} from './canonical-state.ts';
import {validateKeyRing,type KeyRing} from './auth-state.ts';
export const authAuditFormatV4='IDMS_AUTH_AUDIT_V4_1';
export type AuthAuditActionV4='AUTH_LOGIN'|'AUTH_LOGOUT'|'AUTH_SESSION_REPLACED'|'AUTH_SESSION_REVOKED'|'AUTH_SESSION_EXPIRED';
export type AuthAuditReasonV4='OIDC_LOGIN'|'USER_LOGOUT'|'NEW_LOGIN_REPLACEMENT'|'VALIDATION_OR_REFRESH_FAILED'|'ABSOLUTE_EXPIRY';
export interface AuthAuditBindingV4 {deployment:string;databaseOid:string}
export interface AuthAuditDraftV4 {scope:string;tenantId:string;eventId:string;position:string;action:AuthAuditActionV4;occurredAtMs:string;previousHash:string}
export interface AuthAuditHeaderV4 extends AuthAuditDraftV4 {sessionRef:string;digest:string;chainHash:string}
export interface AuthAuditPayloadV4 {format:typeof authAuditFormatV4;actorId:string;roles:string[];reason:AuthAuditReasonV4}
export interface AuthAuditEventV4 {header:AuthAuditHeaderV4;payload:AuthAuditPayloadV4}
/** Export only these one-way derived keys to a delivery process; never the session master ring. */
export function deriveAuthAuditKeyRingV4(master:KeyRing,binding:AuthAuditBindingV4):KeyRing{
 validateKeyRing(master);const salt=Buffer.from(authAuditFormatV4+'\0OUTBOX_ROOT'),info=Buffer.from(canonicalDigest({deployment:binding.deployment,databaseOid:binding.databaseOid}));return {format:1,activeKeyId:master.activeKeyId,keys:master.keys.map(k=>({keyId:k.keyId,key:Buffer.from(hkdfSync('sha256',Buffer.from(k.key,'base64url'),salt,info,32)).toString('base64url')}))};
}
const actions:Record<AuthAuditActionV4,AuthAuditReasonV4>={AUTH_LOGIN:'OIDC_LOGIN',AUTH_LOGOUT:'USER_LOGOUT',AUTH_SESSION_REPLACED:'NEW_LOGIN_REPLACEMENT',AUTH_SESSION_REVOKED:'VALIDATION_OR_REFRESH_FAILED',AUTH_SESSION_EXPIRED:'ABSOLUTE_EXPIRY'};
const hash=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
export function authAuditNeedV4(ok:unknown,code='AUTH_AUDIT_INTEGRITY'):asserts ok{if(!ok)throw Object.assign(Error(code),{code});}
const exact=(v:unknown,keys:string[]):v is Record<string,any>=>!!v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')===[...keys].sort().join(',');
export function verifyAuthAuditDraftV4(d:AuthAuditDraftV4){
 authAuditNeedV4(exact(d,['scope','tenantId','eventId','position','action','occurredAtMs','previousHash'])&&hash(d.scope)&&/^[A-Za-z0-9_-]{1,80}$/.test(d.tenantId)&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(d.eventId)&&/^[1-9][0-9]{0,18}$/.test(d.position)&&BigInt(d.position)<=9223372036854775807n&&Object.hasOwn(actions,d.action)&&/^[1-9][0-9]{0,15}$/.test(d.occurredAtMs)&&Number.isSafeInteger(Number(d.occurredAtMs))&&Number(d.occurredAtMs)<=8640000000000000&&hash(d.previousHash));return d;
}
export function authAuditPayloadV4(actorId:string,roles:readonly string[],action:AuthAuditActionV4):AuthAuditPayloadV4{
 const payload:AuthAuditPayloadV4={format:authAuditFormatV4,actorId,roles:[...new Set(roles)].sort(),reason:actions[action]};
 authAuditNeedV4(typeof actorId==='string'&&actorId.length>0&&Buffer.byteLength(actorId)<=512&&Array.isArray(roles)&&roles.length<=256&&roles.every(r=>typeof r==='string'&&r.length>0&&Buffer.byteLength(r)<=128)&&Object.hasOwn(actions,action),'AUTH_AUDIT_IDENTITY');return payload;
}
export function authAuditDigestV4(d:AuthAuditDraftV4,sessionRef:string,payload:AuthAuditPayloadV4){verifyAuthAuditDraftV4(d);authAuditNeedV4(hash(sessionRef));return canonicalDigest({format:authAuditFormatV4,...d,sessionRef,payload});}
export function authAuditChainV4(h:Omit<AuthAuditHeaderV4,'chainHash'>){return createHash('sha256').update([authAuditFormatV4,h.scope,h.tenantId,h.position,h.eventId,h.action,h.occurredAtMs,h.digest,h.previousHash,h.sessionRef].join('\n')).digest('hex');}
export function verifyAuthAuditEventV4(event:AuthAuditEventV4){
 authAuditNeedV4(exact(event,['header','payload'])&&exact(event.header,['scope','tenantId','eventId','position','action','occurredAtMs','previousHash','sessionRef','digest','chainHash'])&&exact(event.payload,['format','actorId','roles','reason']));const {sessionRef,digest,chainHash,...draft}=event.header;verifyAuthAuditDraftV4(draft);authAuditNeedV4(hash(sessionRef)&&hash(digest)&&hash(chainHash));
 const expected=authAuditPayloadV4(event.payload.actorId,event.payload.roles,draft.action);authAuditNeedV4(canonicalDigest(expected)===canonicalDigest(event.payload)&&authAuditDigestV4(draft,sessionRef,event.payload)===digest&&authAuditChainV4({...draft,sessionRef,digest})===chainHash,'AUTH_AUDIT_EVENT_DIGEST');return event;
}
/** Session state and audit boxes share managed key material with separate HKDF purposes and AAD. */
export class AuthAuditCryptoV4 {
 #ring:KeyRing;#binding:AuthAuditBindingV4;
 constructor(ring:KeyRing,binding:AuthAuditBindingV4){this.#ring=jsonWireClone(validateKeyRing(ring));authAuditNeedV4(hash(binding.deployment)&&/^[1-9][0-9]*$/.test(binding.databaseOid),'AUTH_AUDIT_BINDING');this.#binding=Object.freeze({deployment:binding.deployment,databaseOid:binding.databaseOid});}
 #key(id:string,purpose:string){const k=this.#ring.keys.find(k=>k.keyId===id);authAuditNeedV4(k,'AUTH_AUDIT_KEY');return Buffer.from(hkdfSync('sha256',Buffer.from(k.key,'base64url'),Buffer.from(authAuditFormatV4+'\0'+purpose),Buffer.from(canonicalDigest(this.#binding)),32));}
 sessionRef(scope:string,lookupHash:string){authAuditNeedV4(hash(scope)&&hash(lookupHash));return createHmac('sha256',this.#key(this.#ring.activeKeyId,'SESSION_REFERENCE')).update(scope+'\0'+lookupHash).digest('hex');}
 /** Stable reference across encryption-key rotation: callers retain the issuing reference on each session. */
 event(draft:AuthAuditDraftV4,sessionRef:string,actorId:string,roles:readonly string[]){const payload=authAuditPayloadV4(actorId,roles,draft.action),digest=authAuditDigestV4(draft,sessionRef,payload),header={...draft,sessionRef,digest,chainHash:authAuditChainV4({...draft,sessionRef,digest})};return verifyAuthAuditEventV4({header,payload});}
 seal(event:AuthAuditEventV4){verifyAuthAuditEventV4(event);const keyId=this.#ring.activeKeyId,iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',this.#key(keyId,'EVENT'),iv);cipher.setAAD(Buffer.from(canonicalDigest({binding:this.#binding,header:event.header,keyId})));const plain=Buffer.from(JSON.stringify(event.payload));authAuditNeedV4(plain.length<=65536,'AUTH_AUDIT_PAYLOAD_SIZE');const data=Buffer.concat([cipher.update(plain),cipher.final()]);return {format:1,keyId,iv:iv.toString('base64url'),tag:cipher.getAuthTag().toString('base64url'),data:data.toString('base64url')};}
 open(header:AuthAuditHeaderV4,raw:unknown):AuthAuditEventV4{
  try{authAuditNeedV4(exact(raw,['format','keyId','iv','tag','data'])&&raw.format===1&&typeof raw.keyId==='string'&&typeof raw.iv==='string'&&raw.iv.length===16&&typeof raw.tag==='string'&&raw.tag.length===22&&typeof raw.data==='string'&&raw.data.length<=87384);
   const decode=(s:string)=>{authAuditNeedV4(/^[A-Za-z0-9_-]+$/.test(s));const b=Buffer.from(s,'base64url');authAuditNeedV4(b.toString('base64url')===s);return b;},iv=decode(raw.iv),tag=decode(raw.tag);authAuditNeedV4(iv.length===12&&tag.length===16);const decipher=createDecipheriv('aes-256-gcm',this.#key(raw.keyId,'EVENT'),iv);decipher.setAAD(Buffer.from(canonicalDigest({binding:this.#binding,header,keyId:raw.keyId})));decipher.setAuthTag(tag);return verifyAuthAuditEventV4({header,payload:JSON.parse(Buffer.concat([decipher.update(decode(raw.data)),decipher.final()]).toString('utf8'))});
  }catch{throw Object.assign(Error('AUTH_AUDIT_BOX_INVALID'),{code:'AUTH_AUDIT_BOX_INVALID'});}
 }
 witness(){const event=this.event({scope:'0'.repeat(64),tenantId:'key_check',eventId:'00000000-0000-0000-0000-000000000001',position:'1',action:'AUTH_LOGIN',occurredAtMs:'1',previousHash:'0'.repeat(64)},'0'.repeat(64),'IDMS_AUTH_AUDIT_KEY_CHECK_V4',[]);return {header:event.header,sealed:this.seal(event)};}
 verifyWitness(raw:any){const expected=this.event({scope:'0'.repeat(64),tenantId:'key_check',eventId:'00000000-0000-0000-0000-000000000001',position:'1',action:'AUTH_LOGIN',occurredAtMs:'1',previousHash:'0'.repeat(64)},'0'.repeat(64),'IDMS_AUTH_AUDIT_KEY_CHECK_V4',[]);authAuditNeedV4(exact(raw,['header','sealed'])&&canonicalDigest(this.open(raw.header,raw.sealed))===canonicalDigest(expected),'AUTH_AUDIT_KEY_WITNESS');}
}
