import {readCurrentRecoveryIdentity} from './field-recovery-live-identity.mjs';
export {revalidateRecoveryPlanAuthor} from './field-recovery-live-identity.mjs';
import {decodeJwt} from 'jose';
import {createAuth} from '../server/auth.ts';
import {scopeClaimsFromPayload,permissionsFor,rolePermissions} from '../server/access.ts';
import {canonical} from '../server/imports.ts';
import {sourceFreezeSha} from './field-source-freeze-policy.mjs';
import {recoveryExternalConfig,externalJson,externalRequire as need} from './field-recovery-external-config.mjs';
const known=new Set(Object.keys(rolePermissions)),sorted=a=>[...new Set(a)].sort(),scope=v=>{const s=scopeClaimsFromPayload(v);return {...s,sites:sorted(s.sites),lines:sorted(s.lines),devices:sorted(s.devices)};};
const opaque=v=>typeof v==='string'&&v.length>0&&v.length<=256&&!/[\u0000-\u001f\u007f]/.test(v);
export class CurrentRecoveryActor {
 #c;#auth;#reader;#claims;#identity;#raw;#purpose;#closed=false;
 constructor(configuration){this.#c=recoveryExternalConfig(configuration);this.#auth=createAuth(this.#c.auth);}
 async verify(accessToken,{purpose,otherActorId,signal}={}){
  const c=this.#c;need(!this.#closed&&typeof accessToken==='string'&&accessToken.length<=32768&&['AUTHOR','REVIEWER','READ'].includes(purpose),'FIELD_RECOVERY_ACTOR_INVALID');
  const checked=await this.#auth.verify(accessToken),claims=decodeJwt(accessToken);need(opaque(claims.sub)&&opaque(claims.sid)&&claims.exp*1000>Date.now()+10000&&claims.iat<=Date.now()/1000+5&&checked.identity.tenantId===c.tenantId,'FIELD_RECOVERY_ACTOR_INVALID');
  if(purpose==='REVIEWER')need(opaque(otherActorId)&&otherActorId!==claims.sub,'FIELD_RECOVERY_INDEPENDENT_REVIEW_REQUIRED');
  const response=await externalJson(c.auth.issuer+'/protocol/openid-connect/token',{method:'POST',body:new URLSearchParams({grant_type:'client_credentials',client_id:c.identityReader.clientId,client_secret:c.identityReader.clientSecret}),signal,max:65536});need(typeof response.access_token==='string'&&response.access_token.length<=32768&&response.token_type==='Bearer'&&Number.isFinite(response.expires_in)&&response.expires_in>=30,'FIELD_RECOVERY_IDENTITY_READER_INVALID');
  this.#reader=response.access_token;this.#claims=claims;this.#identity=checked.identity;this.#raw=accessToken;this.#purpose=purpose;return this.current({purpose,signal});
 }
 async current({purpose,signal}){
  need(!this.#closed&&this.#reader&&this.#purpose===purpose&&this.#claims.exp*1000>Date.now()+10000,'FIELD_RECOVERY_ACTOR_EXPIRED');const p=this.#claims,pin={actorId:p.sub,username:this.#identity.username,sessionId:p.sid,roles:this.#identity.roles,scope:scope(p),tokenIssuedAt:p.iat,tokenExpiresAt:new Date(p.exp*1000).toISOString(),tokenSha256:sourceFreezeSha(this.#raw)};return readCurrentRecoveryIdentity(this.#c,pin,purpose,this.#reader,signal);
 }
 async close(){this.#closed=true;this.#reader=undefined;this.#raw=undefined;await this.#auth.close();}
}
