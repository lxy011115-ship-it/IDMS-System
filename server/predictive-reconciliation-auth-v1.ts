import type {AuthStateStore} from './auth-state.ts';
import {validId,sessionLifetime} from './auth-state.ts';
import {GovernanceJobAuthV4} from './governance-job-auth-v4.ts';
import type {GovernanceAuthReferenceV4} from './governance-job-crypto-v4.ts';
import type {AccessContext} from './access.ts';
import {canonicalDigest} from './canonical-state.ts';
import {DomainError} from './service.ts';
const brand=Symbol('PREDICTIVE_RECONCILIATION_SESSION_V1');
export const reconciliationIdentityV1=(ctx:AccessContext)=>canonicalDigest({tenantId:ctx.tenantId,actorId:ctx.actorId,actorType:ctx.actorType,authMode:ctx.authMode,roles:[...new Set(ctx.roles||[])].sort(),scope:ctx.scope});
export interface ReconciliationCurrentV1 {context:AccessContext;identityHash:string;sessionHash:string;sessionCreatedAt:number;deadline:number}
export class ReconciliationGrantV1 {
 #provider:GovernanceJobAuthV4;#store:AuthStateStore;#reference:GovernanceAuthReferenceV4;
 constructor(token:symbol,provider:GovernanceJobAuthV4,store:AuthStateStore,reference:GovernanceAuthReferenceV4){if(token!==brand)throw new DomainError(403,'RECONCILIATION_GRANT_CONSTRUCTOR');this.#provider=provider;this.#store=store;this.#reference=structuredClone(reference);}
 async current():Promise<ReconciliationCurrentV1>{
  const live=await this.#provider.resolve(this.#reference),session=await this.#store.withSession(this.#reference.value,async s=>({value:{createdAt:s.createdAt,expiresAt:s.expiresAt,identityHash:reconciliationIdentityV1(s.identity)}}));
  if(!session||live.context.authMode!=='oidc'||live.context.actorType!=='USER'||session.identityHash!==reconciliationIdentityV1(live.context)||!Number.isSafeInteger(session.createdAt)||session.createdAt<0||session.createdAt>Date.now()||Math.min(session.expiresAt,live.deadline,session.createdAt+sessionLifetime)<=Date.now())throw new DomainError(401,'RECONCILIATION_SESSION_EXPIRED');
  return {context:structuredClone(live.context),identityHash:session.identityHash,sessionHash:canonicalDigest(['PREDICTIVE_CANCEL_SESSION_V1',this.#reference.value]),sessionCreatedAt:session.createdAt,deadline:Math.min(live.deadline,session.expiresAt,session.createdAt+sessionLifetime)};
 }
}
export class PredictiveReconciliationAuthV1 {
 #provider:GovernanceJobAuthV4;#store:AuthStateStore;
 constructor(provider:GovernanceJobAuthV4,store:AuthStateStore){if(store.mode!=='POSTGRES_ENCRYPTED')throw new DomainError(503,'RECONCILIATION_ENCRYPTED_OIDC_REQUIRED');this.#provider=provider;this.#store=store;}
 grant(reference:GovernanceAuthReferenceV4){if(!reference||Object.keys(reference).sort().join(',')!=='kind,value'||reference.kind!=='SESSION'||!validId(reference.value))throw new DomainError(401,'RECONCILIATION_SESSION_REQUIRED');return new ReconciliationGrantV1(brand,this.#provider,this.#store,reference);}
}
