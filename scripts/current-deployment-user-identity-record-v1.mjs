import {createLocalJWKSet,jwtVerify} from 'jose';
import {canonical} from '../server/imports.ts';
import {CurrentRecoveryActor} from './field-recovery-current-actor.mjs';
import {recoveryExternalConfig,externalJson} from './field-recovery-external-config.mjs';
import {reviewSourceHashV1 as hash} from './workflow-review-source-facts-v1.mjs';

const need=(v,c)=>{if(!v)throw Object.assign(Error(c),{code:c});};
const pick=(v,keys)=>{need(v&&Object.getPrototypeOf(v)===Object.prototype,'CURRENT_DEPLOYMENT_USER_RECORD_RESPONSE');return Object.fromEntries(keys.filter(k=>Object.hasOwn(v,k)).map(k=>[k,structuredClone(v[k])]));};
const same=(a,b)=>canonical(a)===canonical(b);
function publicKeys(v){need(v&&Object.keys(v).length===1&&Array.isArray(v.keys)&&v.keys.length>0&&v.keys.length<=64,'CURRENT_DEPLOYMENT_USER_RECORD_KEYS');for(const k of v.keys)need(k&&typeof k==='object'&&!Array.isArray(k)&&!['d','p','q','dp','dq','qi','oth','k'].some(n=>Object.hasOwn(k,n)),'CURRENT_DEPLOYMENT_USER_RECORD_PUBLIC_KEYS_REQUIRED');return structuredClone(v);}
function cleanFacts(realm,client,user,roles,sessions){
  need(Array.isArray(roles)&&roles.length<=1024&&Array.isArray(sessions)&&sessions.length<=256,'CURRENT_DEPLOYMENT_USER_RECORD_RESPONSE_LIMIT');
  const result={realm:pick(realm,['id','realm','enabled','notBefore']),client:pick(client,['id','clientId','enabled','notBefore']),user:pick(user,['id','username','enabled','requiredActions','notBefore']),roles:roles.map(v=>pick(v,['name'])),sessions:sessions.map(v=>pick(v,['id','userId','start','clients']))};
  result.realm.attributes=pick(realm.attributes??{},['idms_authority_id','idms_authority_epoch','idms_authority_challenge']);result.user.attributes=pick(user.attributes??{},['tenant_id','idms_sites','idms_lines','idms_devices']);return result;
}

/** Trusted identity reader. Captures actual responses, never accepts a verifier callback or actor record. */
export function createCurrentDeploymentUserIdentityRecordV1(configuration){
  const config=recoveryExternalConfig(configuration),actor=new CurrentRecoveryActor(config),abort=new AbortController();
  let rawToken='',initial=null,evidence=null,active=null,closed=false,closing=false,failed=false,closeJob=null;
  const available=()=>need(!closed&&!closing&&!failed,'CURRENT_DEPLOYMENT_USER_RECORD_CLOSED');
  async function capture(signal){
    const capturedFrom=new Date().toISOString(),before=await actor.current({purpose:'AUTHOR',signal});
    const jwks=publicKeys(await externalJson(config.auth.issuer+'/protocol/openid-connect/certs',{signal,max:65536}));
    const verified=await jwtVerify(rawToken,createLocalJWKSet(jwks),{issuer:config.auth.issuer,audience:config.auth.audience,algorithms:['RS256'],requiredClaims:['sub','exp','iat'],clockTolerance:5}),jwtVerifiedAt=new Date().toISOString();
    need(verified.payload.sub===before.actorId&&verified.payload.sid===before.sessionId&&hash(rawToken)===before.tokenSha256,'CURRENT_DEPLOYMENT_USER_RECORD_TOKEN_BINDING');
    let reader='';try{
      const service=await externalJson(config.auth.issuer+'/protocol/openid-connect/token',{method:'POST',body:new URLSearchParams({grant_type:'client_credentials',client_id:config.identityReader.clientId,client_secret:config.identityReader.clientSecret}),signal,max:65536});
      need(typeof service.access_token==='string'&&service.access_token.length>0&&service.access_token.length<=32768&&service.token_type==='Bearer'&&Number.isFinite(service.expires_in)&&service.expires_in>=30,'CURRENT_DEPLOYMENT_USER_RECORD_READER');reader=service.access_token;
      const issuer=new URL(config.auth.issuer),base=issuer.origin+'/admin'+issuer.pathname,user='/users/'+encodeURIComponent(before.actorId),paths=['','/clients/'+config.identityReader.loginClientUuid,user,user+'/role-mappings/realm/composite',user+'/sessions'];
      const responses=await Promise.allSettled(paths.map(path=>externalJson(base+path,{headers:{Authorization:'Bearer '+reader},signal})));const failure=responses.find(v=>v.status==='rejected');if(failure)throw failure.reason;
      const facts=cleanFacts(...responses.map(v=>v.value)),after=await actor.current({purpose:'AUTHOR',signal});available();
      need(!signal.aborted&&same(before,after)&&same(initial,after),'CURRENT_DEPLOYMENT_USER_RECORD_CHANGED');
      const capturedAt=new Date().toISOString();need(Date.parse(capturedAt)-Date.parse(capturedFrom)<=30000,'CURRENT_DEPLOYMENT_USER_RECORD_EXPIRED');
      const body={format:'CURRENT_DEPLOYMENT_USER_IDENTITY_RAW_RECORD_V1',tenantId:config.tenantId,issuer:config.auth.issuer,audience:config.auth.audience,clientId:config.auth.clientId,loginClientUuid:config.identityReader.loginClientUuid,accessToken:rawToken,jwks,jwksSha256:hash(jwks),facts,actor:after,jwtVerifiedAt,capturedFrom,capturedAt,liveAuthorityOrRuntimeGranted:false};evidence={...body,sha256:hash(body)};return structuredClone(evidence);
    }finally{reader='';}
  }
  async function run(work){available();need(!active,'CURRENT_DEPLOYMENT_USER_RECORD_BUSY');let job;job=work(AbortSignal.any([abort.signal,AbortSignal.timeout(30000)]));active=job;try{return await job;}catch(error){failed=true;throw error;}finally{if(active===job)active=null;}}
  return Object.freeze({
    verify(token){need(!initial&&typeof token==='string'&&token.length>0&&token.length<=32768&&!/[\u0000-\u0020\u007f]/.test(token),'CURRENT_DEPLOYMENT_USER_RECORD_REQUEST');return run(async signal=>{rawToken=token;initial=await actor.verify(token,{purpose:'AUTHOR',signal});return capture(signal);});},
    current(){need(initial,'CURRENT_DEPLOYMENT_USER_RECORD_NOT_AUTHENTICATED');return run(capture);},
    recorded(){available();need(evidence,'CURRENT_DEPLOYMENT_USER_RECORD_NOT_AUTHENTICATED');return structuredClone(evidence);},
    close(){if(closeJob)return closeJob;closing=true;abort.abort();closeJob=(async()=>{await active?.catch(()=>{});await actor.close();rawToken='';initial=null;if(evidence)evidence.accessToken='';evidence=null;config.identityReader.clientSecret='';config.workflow.recoveryReadToken='';closed=true;return{format:'CURRENT_DEPLOYMENT_USER_IDENTITY_RECORD_CLOSED_V1',originalIdentityReaderClosed:true,ownedSqlClients:0,ownedRuntimePrograms:0};})();return closeJob;}
  });
}
