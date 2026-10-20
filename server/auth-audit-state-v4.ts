import {AsyncLocalStorage} from 'node:async_hooks';
import pg from 'pg';
import type {PoolClient} from 'pg';
import {createAuth,type AuthConfig} from './auth.ts';
import {createAuditCursorCodec,type AuditCursorCodec} from './audit-cursor.ts';
import type {AuthRuntime} from './auth-store.ts';
import {sha,stable,validId,sessionLifetime,sealState,openState,type KeyRing,type CryptoBinding,type Session,type LoginAttempt,type AuthStateStore,type SessionChange} from './auth-state.ts';
import {DomainError} from './service.ts';
import {canonicalDigest,canonicalEqual} from './canonical-state.ts';
import {AuthAuditCryptoV4,deriveAuthAuditKeyRingV4,authAuditNeedV4 as need,type AuthAuditEventV4,type AuthAuditActionV4,type AuthAuditDraftV4} from './auth-audit-event-v4.ts';
import {checkAuthAuditConnectionV4,type AuthAuditQueueBindingV4} from './auth-audit-source-v4.ts';
interface AuditedSession extends Session {authAuditSessionRef:string}
interface Tx {c:PoolClient;events:AuthAuditEventV4[];posts:Map<string,string|null>}
/** The original session ciphertext/PKCE protocol with atomic, guarded lifecycle outbox writes. */
export class AuthAuditStateV4 implements AuthStateStore {
 readonly mode='POSTGRES_ENCRYPTED' as const;readonly auditCursors:AuditCursorCodec;
 readonly pool:pg.Pool;readonly runtime:AuthRuntime;readonly ring:KeyRing;readonly scope:string;readonly binding:AuthAuditQueueBindingV4;
 #crypto:AuthAuditCryptoV4;#operation=new AsyncLocalStorage<'LOGOUT'>();#seen=new WeakSet<PoolClient>();#admit?:(s:Session)=>Promise<void>;
 constructor(pool:pg.Pool,runtime:AuthRuntime,ring:KeyRing,binding:AuthAuditQueueBindingV4,admit?:(s:Session)=>Promise<void>){need(runtime.deploymentDigest===binding.deployment,'AUTH_AUDIT_SESSION_DEPLOYMENT');this.pool=pool;this.runtime=runtime;this.ring=ring;this.scope=binding.scope;this.binding=Object.freeze({...binding});this.#crypto=new AuthAuditCryptoV4(deriveAuthAuditKeyRingV4(ring,binding),binding);this.#admit=admit;this.auditCursors=createAuditCursorCodec(ring,runtime.deploymentDigest,this.scope);}
 #binding(kind:'LOGIN'|'SESSION',lookup:string,revision:number,expires:number):CryptoBinding{return {deployment:this.runtime.deploymentDigest,scope:this.scope,kind,lookup,revision,expires};}
 async #client(){const c=await this.pool.connect().catch(()=>{throw new DomainError(503,'共享登录存储暂不可用');});if(!this.#seen.has(c)){c.on('error',()=>{});this.#seen.add(c);}return c;}
 async #resolve<T>(tx:Tx,value:T){const c=await this.#client();try{
  await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');this.#crypto.verifyWitness((await checkAuthAuditConnectionV4(c,this.binding,false)).keyCheck);
  for(const event of tx.events){const raw=(await c.query('SELECT auth_audit_v4.event_v4($1,$2) AS value',[this.scope,event.header.eventId])).rows[0].value;need(raw&&canonicalEqual(this.#crypto.open(raw.header,raw.sealed),event),'AUTH_AUDIT_COMMIT_EVENT_MISSING');}
  for(const [lookup,expected]of tx.posts){const r=(await c.query("SELECT * FROM public.auth_state WHERE scope_hash=$1 AND kind='SESSION' AND lookup_hash=$2",[this.scope,lookup])).rows[0];if(expected===null)need(!r,'AUTH_AUDIT_REVOKE_UNCONFIRMED');else need(r&&canonicalDigest(openState<AuditedSession>(r.sealed,this.#binding('SESSION',lookup,r.revision,new Date(r.expires_at).getTime()),this.ring))===expected,'AUTH_AUDIT_SESSION_UNCONFIRMED');}
  this.#crypto.verifyWitness((await checkAuthAuditConnectionV4(c,this.binding,false)).keyCheck);await c.query('COMMIT');return value;
 }catch{await c.query('ROLLBACK').catch(()=>{});throw new DomainError(503,'会话状态与审计提交尚未确认');}finally{c.release();}}
 async #tx<T>(task:(tx:Tx)=>Promise<T>):Promise<T>{
  const c=await this.#client(),tx:Tx={c,events:[],posts:new Map()};let result:T|undefined,error:unknown,committing=false,committed=false;
  try{await c.query('BEGIN');await c.query("SET LOCAL lock_timeout='10s';SET LOCAL statement_timeout='30s'");this.#crypto.verifyWitness((await checkAuthAuditConnectionV4(c,this.binding,false)).keyCheck);result=await task(tx);this.#crypto.verifyWitness((await checkAuthAuditConnectionV4(c,this.binding,false)).keyCheck);committing=true;const r=await c.query('COMMIT');need(r.command==='COMMIT','AUTH_AUDIT_COMMIT_UNCONFIRMED');committed=true;}
  catch(e){error=e;if(!committing)await c.query('ROLLBACK').catch(()=>{});}finally{c.release(committing&&!committed);}
  if(error){if(committing&&tx.events.length)return this.#resolve(tx,result!);if(error instanceof DomainError)throw error;if((error as Error).message?.includes('AUTH_AUDIT_BACKPRESSURE'))throw new DomainError(429,'认证审计积压，暂缓新登录；已有会话仍可退出');throw new DomainError(503,'共享登录与审计事务未确认');}return result!;
 }
 #session(r:any):AuditedSession{const expires=new Date(r.expires_at).getTime(),s=openState<AuditedSession>(r.sealed,this.#binding('SESSION',r.lookup_hash,r.revision,expires),this.ring);need(s.createdAt+sessionLifetime===expires&&/^[a-f0-9]{64}$/.test(s.authAuditSessionRef),'AUTH_AUDIT_SESSION_BINDING');return s;}
 async #stage(tx:Tx,lookup:string,s:AuditedSession,action:AuthAuditActionV4){
  need(s.identity.authMode==='oidc'&&s.identity.actorType==='USER','AUTH_AUDIT_OIDC_SESSION');const draft=(await tx.c.query('SELECT auth_audit_v4.reserve_v4($1,$2,$3,$4) AS value',[this.scope,s.identity.tenantId,lookup,action])).rows[0].value as AuthAuditDraftV4,event=this.#crypto.event(draft,s.authAuditSessionRef,s.identity.actorId,s.identity.roles||[]);await tx.c.query('SELECT auth_audit_v4.stage_v4($1,$2,$3,$4,$5)',[event.header.eventId,event.header.sessionRef,event.header.digest,event.header.chainHash,this.#crypto.seal(event)]);tx.events.push(event);return event;
 }
 async #remove(tx:Tx,r:any,s:AuditedSession,action:Exclude<AuthAuditActionV4,'AUTH_LOGIN'>){await this.#stage(tx,r.lookup_hash,s,action);await tx.c.query("DELETE FROM public.auth_state WHERE scope_hash=$1 AND kind='SESSION' AND lookup_hash=$2",[this.scope,r.lookup_hash]);tx.posts.set(r.lookup_hash,null);}
 async #sweep(tx:Tx,limit:number){const rows=(await tx.c.query("SELECT * FROM public.auth_state WHERE scope_hash=$1 AND kind='SESSION' AND expires_at<=clock_timestamp() ORDER BY expires_at,lookup_hash FOR UPDATE SKIP LOCKED LIMIT $2",[this.scope,limit])).rows;for(const r of rows)await this.#remove(tx,r,this.#session(r),'AUTH_SESSION_EXPIRED');return rows.length;}
 async sweepExpired(limit=16){need(Number.isInteger(limit)&&limit>=1&&limit<=32,'AUTH_AUDIT_SWEEP_LIMIT');return this.#tx(async tx=>{await tx.c.query('SELECT pg_advisory_xact_lock(hashtext($1))',[this.scope+':SESSION']);return this.#sweep(tx,limit);});}
 putAttempt(id:string,value:LoginAttempt){need(validId(id),'AUTH_AUDIT_LOGIN_LOOKUP');return this.#tx(async tx=>{await tx.c.query('SELECT pg_advisory_xact_lock(hashtext($1))',[this.scope+':LOGIN']);await tx.c.query("DELETE FROM public.auth_state WHERE scope_hash=$1 AND kind='LOGIN' AND expires_at<=clock_timestamp()",[this.scope]);if(Number((await tx.c.query("SELECT count(*) FROM public.auth_state WHERE scope_hash=$1 AND kind='LOGIN'",[this.scope])).rows[0].count)>=1000)throw new DomainError(429,'登录繁忙，请稍后再试');const lookup=sha(id);await tx.c.query("INSERT INTO public.auth_state(scope_hash,kind,lookup_hash,revision,expires_at,sealed) VALUES($1,'LOGIN',$2,1,$3,$4)",[this.scope,lookup,new Date(value.expires),sealState(value,this.#binding('LOGIN',lookup,1,value.expires),this.ring)]);});}
 takeAttempt(id:string){if(!validId(id))return Promise.resolve(undefined);return this.#tx(async tx=>{const r=(await tx.c.query("DELETE FROM public.auth_state WHERE scope_hash=$1 AND kind='LOGIN' AND lookup_hash=$2 RETURNING *",[this.scope,sha(id)])).rows[0];if(!r||new Date(r.expires_at).getTime()<=Date.now())return;return openState<LoginAttempt>(r.sealed,this.#binding('LOGIN',r.lookup_hash,r.revision,new Date(r.expires_at).getTime()),this.ring);});}
 async createSession(id:string,value:Session,oldId?:string){
  need(validId(id),'AUTH_AUDIT_SESSION_LOOKUP');await this.#admit?.(value);const lookup=sha(id);return this.#tx(async tx=>{
   await tx.c.query('SELECT pg_advisory_xact_lock(hashtext($1))',[this.scope+':SESSION']);const existing=(await tx.c.query("SELECT * FROM public.auth_state WHERE scope_hash=$1 AND kind='SESSION' AND lookup_hash=$2 FOR UPDATE",[this.scope,lookup])).rows[0],login=(await tx.c.query('SELECT auth_audit_v4.login_v4($1,$2) AS value',[this.scope,lookup])).rows[0].value;
   if(existing){const saved=this.#session(existing),{authAuditSessionRef,...session}=saved;need(canonicalEqual(session,value)&&login,'AUTH_AUDIT_SESSION_REPLAY_CONFLICT');const event=this.#crypto.open(login.header,login.sealed);need(event.header.sessionRef===authAuditSessionRef&&event.payload.actorId===value.identity.actorId&&event.header.tenantId===value.identity.tenantId,'AUTH_AUDIT_SESSION_REPLAY_CONFLICT');tx.events.push(event);tx.posts.set(lookup,canonicalDigest(saved));return;}
   need(!login,'AUTH_AUDIT_SESSION_ID_REUSED');
   if(oldId&&validId(oldId)){const r=(await tx.c.query("SELECT *,expires_at<=clock_timestamp() AS expired FROM public.auth_state WHERE scope_hash=$1 AND kind='SESSION' AND lookup_hash=$2 FOR UPDATE",[this.scope,sha(oldId)])).rows[0];if(r)await this.#remove(tx,r,this.#session(r),r.expired?'AUTH_SESSION_EXPIRED':'AUTH_SESSION_REPLACED');}
   await this.#sweep(tx,16);const active=Number((await tx.c.query("SELECT count(*) FROM public.auth_state WHERE scope_hash=$1 AND kind='SESSION' AND expires_at>clock_timestamp()",[this.scope])).rows[0].count);if(active>=10000)throw new DomainError(429,'登录繁忙，请稍后再试');
   const expires=value.createdAt+sessionLifetime,session:AuditedSession={...value,authAuditSessionRef:this.#crypto.sessionRef(this.scope,lookup)};need(expires>Date.now()&&session.identity.authMode==='oidc'&&session.identity.actorType==='USER','AUTH_AUDIT_SESSION_IDENTITY');await this.#stage(tx,lookup,session,'AUTH_LOGIN');await tx.c.query("INSERT INTO public.auth_state(scope_hash,kind,lookup_hash,revision,expires_at,sealed) VALUES($1,'SESSION',$2,1,$3,$4)",[this.scope,lookup,new Date(expires),sealState(session,this.#binding('SESSION',lookup,1,expires),this.ring)]);tx.posts.set(lookup,canonicalDigest(session));
  });
 }
 withSession<T>(id:string,change:(s:Session)=>Promise<SessionChange<T>>):Promise<T|undefined>{if(!validId(id))return Promise.resolve(undefined);const logout=this.#operation.getStore()==='LOGOUT';return this.#tx(async tx=>{
  const r=(await tx.c.query("SELECT *,expires_at<=clock_timestamp() AS expired FROM public.auth_state WHERE scope_hash=$1 AND kind='SESSION' AND lookup_hash=$2 FOR UPDATE",[this.scope,sha(id)])).rows[0];if(!r)return;const state=this.#session(r);if(r.expired){await this.#remove(tx,r,state,'AUTH_SESSION_EXPIRED');return;}
  const result=await change(structuredClone(state));if(result.remove)await this.#remove(tx,r,state,logout?'AUTH_LOGOUT':'AUTH_SESSION_REVOKED');else if(result.session){const next=result.session as AuditedSession;need(next.createdAt===state.createdAt&&next.identity.tenantId===state.identity.tenantId&&next.identity.actorId===state.identity.actorId&&next.authAuditSessionRef===state.authAuditSessionRef,'AUTH_AUDIT_SESSION_IDENTITY');await tx.c.query("UPDATE public.auth_state SET revision=revision+1,sealed=$3 WHERE scope_hash=$1 AND kind='SESSION' AND lookup_hash=$2",[this.scope,r.lookup_hash,sealState(next,this.#binding('SESSION',r.lookup_hash,r.revision+1,new Date(r.expires_at).getTime()),this.ring)]);}
  return result.value;
 });}
 explicitLogout<T>(task:()=>Promise<T>){return this.#operation.run('LOGOUT',task);}
 close(){return this.pool.end();}
}
/** Original OIDC/PKCE/CSRF implementation; only an authenticated server route marks explicit logout. */
export function createAuditedAuthV4(config:AuthConfig,state:AuthAuditStateV4){const original=createAuth(config,undefined,state);return {...original,handle:(req:Parameters<typeof original.handle>[0],res:Parameters<typeof original.handle>[1],url:URL)=>url.pathname==='/api/v1/auth/logout'&&req.method==='POST'?state.explicitLogout(()=>original.handle(req,res,url)):original.handle(req,res,url)};}
