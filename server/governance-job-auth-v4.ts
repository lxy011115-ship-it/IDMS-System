import type {IncomingMessage} from 'node:http';
import type {createAuth} from './auth.ts';
import {validId,sessionLifetime,type AuthStateStore} from './auth-state.ts';
import type {GovernanceAuthReferenceV4} from './governance-job-crypto-v4.ts';
import type {AccessContext} from './access.ts';
import {domainReadAccessV4} from './domain-read-api-v4.ts';
import {DomainError} from './service.ts';
export interface ResolvedGovernanceAuthV4 {context:AccessContext;deadline:number;referenceUntil:number}
/** References contain no roles. Every resolution goes through the existing live auth/session verifier. */
export class GovernanceJobAuthV4 {
 #auth:ReturnType<typeof createAuth>;#state:AuthStateStore;
 constructor(auth:ReturnType<typeof createAuth>,state:AuthStateStore){if(auth.mode!=='oidc')throw new DomainError(503,'GOVERNANCE_OIDC_REQUIRED');this.#auth=auth;this.#state=state;}
 async resolve(ref:GovernanceAuthReferenceV4):Promise<ResolvedGovernanceAuthV4>{
  if(!ref||Object.keys(ref).sort().join(',')!=='kind,value'||typeof ref.value!=='string')throw new DomainError(401,'GOVERNANCE_AUTH_REFERENCE');
  if(ref.kind==='BEARER'){if(ref.value.length>32768||!/^[A-Za-z0-9._~-]+$/.test(ref.value))throw new DomainError(401,'GOVERNANCE_AUTH_REFERENCE');const v=await this.#auth.verify(ref.value);domainReadAccessV4(v.identity);if(v.expiresAt<=Date.now())throw new DomainError(401,'GOVERNANCE_AUTH_EXPIRED');return {context:v.identity,deadline:v.expiresAt,referenceUntil:v.expiresAt};}
  if(ref.kind!=='SESSION'||!validId(ref.value))throw new DomainError(401,'GOVERNANCE_AUTH_REFERENCE');const req={method:'GET',headers:{cookie:'idms_session='+ref.value}} as IncomingMessage,ctx=await this.#auth.context(req);domainReadAccessV4(ctx);const times=await this.#state.withSession(ref.value,async s=>({value:{deadline:s.expiresAt,until:s.createdAt+sessionLifetime}}));if(!times||times.deadline<=Date.now()||times.until<=Date.now())throw new DomainError(401,'GOVERNANCE_AUTH_EXPIRED');return {context:ctx,deadline:times.deadline,referenceUntil:times.until};
 }
 async capture(req:IncomingMessage){const who=await this.#auth.context(req);domainReadAccessV4(who);let reference:GovernanceAuthReferenceV4;
  if(req.headers.authorization){if(!req.headers.authorization.startsWith('Bearer '))throw new DomainError(401,'GOVERNANCE_AUTH_REFERENCE');reference={kind:'BEARER',value:req.headers.authorization.slice(7)};}
  else{const cookies=(req.headers.cookie||'').split(';').map(v=>v.trim()).filter(v=>v.startsWith('idms_session='));if(cookies.length!==1)throw new DomainError(401,'GOVERNANCE_AUTH_REFERENCE');reference={kind:'SESSION',value:cookies[0].slice('idms_session='.length)};}
  const checked=await this.resolve(reference);if(checked.context.actorId!==who.actorId||checked.context.tenantId!==who.tenantId)throw new DomainError(401,'GOVERNANCE_AUTH_CHANGED');return {...checked,reference};
 }
}
