import {createCipheriv,createDecipheriv,hkdfSync,randomBytes} from 'node:crypto';
import type {KeyRing} from './auth-state.ts';
import {DomainError} from './service.ts';
export class AuditPageError extends DomainError {readonly code:string;constructor(status:number,code:string,message:string){super(status,message);this.code=code;}}
export interface AuditCursorCodec {seal(value:unknown):string;open(token:string):unknown}
const purpose='IDMS_AUDIT_PAGE_CURSOR_V1',maximumPlain=4096,maximumToken=6144;
const invalid=()=>new AuditPageError(400,'AUDIT_CURSOR_INVALID','分页标记无效，请刷新追溯');
export function createAuditCursorCodec(ring:KeyRing,deployment:string,scope:string):AuditCursorCodec{
 const keys=new Map(ring.keys.map(k=>[k.keyId,Buffer.from(hkdfSync('sha256',Buffer.from(k.key,'base64url'),Buffer.from(purpose+'\0'+deployment),Buffer.from(scope),32))]));
 const aad=(keyId:string)=>Buffer.from(JSON.stringify({format:'a1',purpose,deployment,scope,keyId}));
 const decode=(value:string)=>{if(!/^[A-Za-z0-9_-]+$/.test(value))throw invalid();const bytes=Buffer.from(value,'base64url');if(bytes.toString('base64url')!==value)throw invalid();return bytes;};
 return Object.freeze({seal(value:unknown){const key=keys.get(ring.activeKeyId);if(!key)throw Error('Missing audit cursor key');const plain=Buffer.from(JSON.stringify(value));if(plain.length>maximumPlain)throw new AuditPageError(400,'AUDIT_QUERY_INVALID','追溯筛选条件过长');const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);cipher.setAAD(aad(ring.activeKeyId));const data=Buffer.concat([cipher.update(plain),cipher.final()]);return ['a1',ring.activeKeyId,iv.toString('base64url'),data.toString('base64url'),cipher.getAuthTag().toString('base64url')].join('.');},open(token:string){try{if(typeof token!=='string'||token.length>maximumToken)throw invalid();const parts=token.split('.');if(parts.length!==5||parts[0]!=='a1'||!/^[-\w]{1,80}$/.test(parts[1]))throw invalid();const key=keys.get(parts[1]);if(!key)throw invalid();const iv=decode(parts[2]),data=decode(parts[3]),tag=decode(parts[4]);if(iv.length!==12||tag.length!==16||data.length>maximumPlain)throw invalid();const cipher=createDecipheriv('aes-256-gcm',key,iv);cipher.setAAD(aad(parts[1]));cipher.setAuthTag(tag);return JSON.parse(Buffer.concat([cipher.update(data),cipher.final()]).toString('utf8'));}catch{throw invalid();}}});
}
export function memoryAuditCursorCodec(){const key=randomBytes(32).toString('base64url');return createAuditCursorCodec({format:1,activeKeyId:'memory-audit',keys:[{keyId:'memory-audit',key}]},'memory','file-demo');}
