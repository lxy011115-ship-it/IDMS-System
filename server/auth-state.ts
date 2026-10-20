import {memoryAuditCursorCodec,type AuditCursorCodec} from './audit-cursor.ts';
import {createCipheriv,createDecipheriv,createHash,randomBytes} from 'node:crypto';
import type {AccessContext} from './access.ts';
import {DomainError} from './service.ts';
export type Tokens={access_token:string;refresh_token?:string;id_token?:string};
export interface Identity extends AccessContext {username:string;name:string}
export interface Session {identity:Identity;tokens:Tokens;expiresAt:number;createdAt:number;csrf:string}
export interface LoginAttempt {verifier:string;nonce:string;returnTo:string;expires:number}
export const sessionLifetime=8*60*60*1000,pendingLifetime=5*60*1000;
export type SessionChange<T>={value:T;session?:Session;remove?:boolean};
export interface AuthStateStore {
 readonly mode:'MEMORY'|'POSTGRES_ENCRYPTED';
 readonly auditCursors:AuditCursorCodec;
 putAttempt(id:string,value:LoginAttempt):Promise<void>;
 takeAttempt(id:string):Promise<LoginAttempt|undefined>;
 createSession(id:string,value:Session,oldId?:string):Promise<void>;
 withSession<T>(id:string,change:(s:Session)=>Promise<SessionChange<T>>):Promise<T|undefined>;
 close():Promise<void>;
}
export const opaqueId=()=>randomBytes(32).toString('base64url');
export const validId=(id:string)=>/^[A-Za-z0-9_-]{43}$/.test(id);
export const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
export function stable(value:unknown):string{if(Array.isArray(value))return '['+value.map(stable).join(',')+']';if(value&&typeof value==='object')return '{'+Object.entries(value).filter(([,v])=>v!==undefined).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,v])=>JSON.stringify(k)+':'+stable(v)).join(',')+'}';return JSON.stringify(value);}
export interface KeyRing {format:1;activeKeyId:string;keys:{keyId:string;key:string}[]}
export function validateKeyRing(raw:any):KeyRing{
 if(!raw||raw.format!==1||!Array.isArray(raw.keys)||raw.keys.length<1||raw.keys.length>8||Object.keys(raw).some(k=>!['format','activeKeyId','keys'].includes(k)))throw Error('Invalid session encryption key ring');
 const ids=new Set<string>(),material=new Set<string>();for(const k of raw.keys){if(!k||Object.keys(k).some(x=>!['keyId','key'].includes(x))||typeof k.keyId!=='string'||!/^[a-zA-Z0-9_-]{1,80}$/.test(k.keyId)||ids.has(k.keyId)||typeof k.key!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(k.key)||Buffer.from(k.key,'base64url').length!==32||Buffer.from(k.key,'base64url').toString('base64url')!==k.key||material.has(k.key))throw Error('Invalid session encryption key');ids.add(k.keyId);material.add(k.key);}
 if(!ids.has(raw.activeKeyId))throw Error('Missing active session encryption key');return raw;
}
export interface CryptoBinding {deployment:string;scope:string;kind:'SESSION'|'LOGIN'|'KEY_CHECK';lookup:string;revision:number;expires:number}
interface Sealed {format:1;keyId:string;iv:string;tag:string;data:string}
const maxPlaintext=262144;
export function sealState(value:unknown,binding:CryptoBinding,ring:KeyRing):Sealed{
 const key=ring.keys.find(k=>k.keyId===ring.activeKeyId);if(!key)throw Error('Missing active session encryption key');const plain=Buffer.from(JSON.stringify(value));if(plain.length>maxPlaintext)throw Error('Session state exceeds supported size');
 const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',Buffer.from(key.key,'base64url'),iv);cipher.setAAD(Buffer.from(stable({...binding,keyId:key.keyId})));const data=Buffer.concat([cipher.update(plain),cipher.final()]);return {format:1,keyId:key.keyId,iv:iv.toString('base64url'),tag:cipher.getAuthTag().toString('base64url'),data:data.toString('base64url')};
}
export function openState<T>(raw:any,binding:CryptoBinding,ring:KeyRing):T{
 try{
  if(!raw||raw.format!==1||Object.keys(raw).some(k=>!['format','keyId','iv','tag','data'].includes(k))||typeof raw.iv!=='string'||typeof raw.tag!=='string'||typeof raw.data!=='string'||raw.iv.length!==16||raw.tag.length!==22||raw.data.length>Math.ceil(maxPlaintext*4/3)||![raw.iv,raw.tag,raw.data].every(v=>/^[A-Za-z0-9_-]*$/.test(v)))throw Error();
  const key=ring.keys.find(k=>k.keyId===raw.keyId);if(!key)throw Error();const decipher=createDecipheriv('aes-256-gcm',Buffer.from(key.key,'base64url'),Buffer.from(raw.iv,'base64url'));decipher.setAAD(Buffer.from(stable({...binding,keyId:key.keyId})));decipher.setAuthTag(Buffer.from(raw.tag,'base64url'));return JSON.parse(Buffer.concat([decipher.update(Buffer.from(raw.data,'base64url')),decipher.final()]).toString('utf8'));
 }catch{throw new DomainError(503,'共享会话状态无法验证，请联系部署管理员');}
}
// Explicit in-memory implementation for file demo and isolated protocol unit tests only.
export class MemoryAuthStore implements AuthStateStore {
 readonly mode='MEMORY' as const;readonly auditCursors=memoryAuditCursorCodec();private attempts=new Map<string,LoginAttempt>();private sessions=new Map<string,Session>();private queue:Promise<unknown>=Promise.resolve();
 private run<T>(task:()=>Promise<T>):Promise<T>{const r=this.queue.then(task);this.queue=r.then(()=>undefined,()=>undefined);return r;}
 private sweep(){const now=Date.now();for(const [id,s]of this.sessions)if(s.createdAt+sessionLifetime<=now)this.sessions.delete(id);for(const [id,p]of this.attempts)if(p.expires<=now)this.attempts.delete(id);}
 putAttempt(id:string,value:LoginAttempt){return this.run(async()=>{this.sweep();if(this.attempts.size>=1000)throw new DomainError(429,'登录繁忙，请稍后再试');this.attempts.set(id,structuredClone(value));});}
 takeAttempt(id:string){return this.run(async()=>{this.sweep();const p=this.attempts.get(id);this.attempts.delete(id);return p?structuredClone(p):undefined;});}
 createSession(id:string,value:Session,oldId?:string){return this.run(async()=>{this.sweep();if(oldId)this.sessions.delete(oldId);if(this.sessions.size>=10000)throw new DomainError(429,'登录繁忙，请稍后再试');this.sessions.set(id,structuredClone(value));});}
 withSession<T>(id:string,change:(s:Session)=>Promise<SessionChange<T>>){return this.run(async()=>{this.sweep();const original=this.sessions.get(id);if(!original)return;const result=await change(structuredClone(original));if(result.remove)this.sessions.delete(id);else if(result.session)this.sessions.set(id,structuredClone(result.session));return result.value;});}
 async close(){}
}
