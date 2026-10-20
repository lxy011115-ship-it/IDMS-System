import {requireAuthAuditTransportV4} from './auth-audit-transport-v4.ts';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import type {Client,ClientConfig,PoolClient} from 'pg';
import {inspectAuthAuditCatalogV4} from './auth-audit-catalog-v4.ts';
import {authAuditNeedV4 as need,AuthAuditCryptoV4,type AuthAuditBindingV4,type AuthAuditHeaderV4} from './auth-audit-event-v4.ts';
import {canonicalEqual} from './canonical-state.ts';
import {VerifiedAuthAuditDeliveryV4} from './auth-audit-map-v4.ts';
export interface AuthAuditQueueBindingV4 extends AuthAuditBindingV4 {scope:string;roleOid:string;catalogHash:string}
export interface AuthAuditClaimV4 {header:AuthAuditHeaderV4;sealed:unknown;owner:string;token:string;fence:string;attempts:number;leaseUntil:string}
export async function checkAuthAuditConnectionV4(c:Pick<Client|PoolClient,'query'>,binding:AuthAuditQueueBindingV4,delivery:boolean){
 const identity=(await c.query('SELECT auth_audit_v4.verify_v4($1) AS value',[delivery])).rows[0].value;need(identity.deployment===binding.deployment&&identity.databaseOid===binding.databaseOid&&identity.roleOid===binding.roleOid,'AUTH_AUDIT_RUNTIME_BINDING');need(await inspectAuthAuditCatalogV4(c)===binding.catalogHash,'AUTH_AUDIT_RUNTIME_CATALOG');return identity;
}
export class AuthAuditCommitUnknownV4 extends Error {readonly operation:string;readonly reference:string;constructor(operation:string,reference:string){super('AUTH_AUDIT_COMMIT_UNKNOWN');this.operation=operation;this.reference=reference;}}
export class AuthAuditSourceV4 {
 readonly binding:AuthAuditQueueBindingV4;#account:ClientConfig;#crypto:AuthAuditCryptoV4;#targets:ReadonlyMap<string,{tenantId:string;databaseOid:string;catalogHash:string}>;
 constructor(account:ClientConfig,binding:AuthAuditQueueBindingV4,crypto:AuthAuditCryptoV4,targets:ReadonlyMap<string,{tenantId:string;databaseOid:string;catalogHash:string}>){
  requireAuthAuditTransportV4(account);need(/^[a-f0-9]{64}$/.test(binding.scope)&&/^[a-f0-9]{64}$/.test(binding.catalogHash)&&/^[1-9][0-9]*$/.test(binding.roleOid),'AUTH_AUDIT_SOURCE_BINDING');this.#account={...account};this.binding=Object.freeze({...binding});this.#crypto=crypto;this.#targets=new Map(targets);
 }
 async #tx<T>(write:boolean,op:string,ref:string,task:(c:Client)=>Promise<T>){const c=new pg.Client({...this.#account,connectionTimeoutMillis:3000,query_timeout:35000});c.on('error',()=>{});let committing=false;try{await c.connect();await c.query(write?'BEGIN':'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');await c.query("SET LOCAL lock_timeout='10s';SET LOCAL statement_timeout='30s'");this.#crypto.verifyWitness((await checkAuthAuditConnectionV4(c,this.binding,true)).keyCheck);const value=await task(c);this.#crypto.verifyWitness((await checkAuthAuditConnectionV4(c,this.binding,true)).keyCheck);committing=write;const r=await c.query('COMMIT');need(r.command==='COMMIT','AUTH_AUDIT_COMMIT_UNCONFIRMED');return value;}catch(e){if(committing)throw new AuthAuditCommitUnknownV4(op,ref);await c.query('ROLLBACK').catch(()=>{});throw e;}finally{await c.end().catch(()=>{});}}
 #args(claim:AuthAuditClaimV4){need(claim.header.scope===this.binding.scope&&this.#targets.has(claim.header.tenantId),'AUTH_AUDIT_SOURCE_TENANT');return [this.binding.scope,claim.header.eventId,claim.owner,claim.token,claim.fence];}
 async claim(tenant:string,owner=randomUUID()){
  need(this.#targets.has(tenant),'AUTH_AUDIT_SOURCE_TENANT');const token=randomUUID();return this.#tx(true,'CLAIM',token,async c=>{const v=(await c.query('SELECT auth_audit_v4.claim_v4($1,$2,$3,$4) AS value',[this.binding.scope,tenant,owner,token])).rows[0].value as AuthAuditClaimV4|null;if(v){need(v.header.scope===this.binding.scope&&v.header.tenantId===tenant&&v.owner===owner&&v.token===token&&/^[1-9][0-9]*$/.test(v.fence),'AUTH_AUDIT_CLAIM');this.#crypto.open(v.header,v.sealed);}return v;});
 }
 open(claim:AuthAuditClaimV4){this.#args(claim);return this.#crypto.open(claim.header,claim.sealed);}
 renew(claim:AuthAuditClaimV4){return this.#tx(true,'RENEW',claim.header.eventId,async c=>(await c.query('SELECT auth_audit_v4.renew_v4($1,$2,$3,$4,$5) AS value',this.#args(claim))).rows[0].value===true);}
 defer(claim:AuthAuditClaimV4,code:string){need(/^[A-Z0-9_]{1,80}$/.test(code));return this.#tx(true,'DEFER',claim.header.eventId,async c=>{await c.query('SELECT auth_audit_v4.defer_v4($1,$2,$3,$4,$5,$6)',[...this.#args(claim),code]);});}
 delivery(eventId:string){return this.#tx(false,'DELIVERY',eventId,async c=>(await c.query('SELECT auth_audit_v4.delivery_v4($1,$2) AS value',[this.binding.scope,eventId])).rows[0].value);}
 async acknowledge(claim:AuthAuditClaimV4,proof:VerifiedAuthAuditDeliveryV4){
  need(proof instanceof VerifiedAuthAuditDeliveryV4,'AUTH_AUDIT_VERIFIED_PROOF_REQUIRED');const value=proof.forSource({deployment:this.binding.deployment,databaseOid:this.binding.databaseOid,scope:this.binding.scope},claim.header,this.#targets.get(claim.header.tenantId)!);
  try{await this.#tx(true,'ACK',claim.header.eventId,async c=>{await c.query('SELECT auth_audit_v4.ack_v4($1,$2,$3,$4,$5,$6)',[...this.#args(claim),value]);});}
  catch(e){if(!(e instanceof AuthAuditCommitUnknownV4))throw e;const found=await this.delivery(claim.header.eventId);if(found?.status==='DELIVERED'&&found.fence===claim.fence&&canonicalEqual(found.receipt,value))return;throw e;}
 }
}
