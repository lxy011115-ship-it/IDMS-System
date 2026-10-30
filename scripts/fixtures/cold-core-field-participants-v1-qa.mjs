import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {decodeJwt} from 'jose';
import {authorityJsonV1} from '../../server/identity-authority-live-v1.ts';
import {readRuntimeColdReviewV3} from '../runtime-cold-readonly-control-v5.mjs';
import {createPlatformFieldAdminQaV1} from './platform-field-admin-v1-qa.mjs';
const sleep=ms=>new Promise(ok=>setTimeout(ok,ms));

/** Create current real isolated OIDC actors once; no recovery approval or business SQL. */
export async function createColdCoreFieldParticipantsQaV1({identity,site,work,save}){
 const privateIdentity=JSON.parse(await readFile(join(work,'identity.private.json'),'utf8')),api=createPlatformFieldAdminQaV1({issuer:identity.runtime.issuer,admin:privateIdentity.admin}),realm=identity.realm;
 const originalClient=(await api(realm+'/clients?clientId=authority-web'))[0],full=await api(realm+'/clients/'+originalClient.id),humanClient='recovery-review-web';
 await api(realm+'/clients','POST',{clientId:humanClient,enabled:true,publicClient:true,standardFlowEnabled:false,directAccessGrantsEnabled:true,fullScopeAllowed:true,protocol:'openid-connect',attributes:{'access.token.lifespan':'600'},protocolMappers:full.protocolMappers.map(({id,...v})=>v)});
 const human=(await api(realm+'/clients?clientId='+humanClient))[0],reader={clientId:'recovery-review-reader',clientSecret:randomBytes(32).toString('base64url')};
 await api(realm+'/clients','POST',{clientId:reader.clientId,enabled:true,publicClient:false,secret:reader.clientSecret,serviceAccountsEnabled:true,standardFlowEnabled:false,directAccessGrantsEnabled:false,fullScopeAllowed:true,protocol:'openid-connect',attributes:{'access.token.lifespan':'600'}});
 const readerClient=(await api(realm+'/clients?clientId='+reader.clientId))[0],serviceUser=await api(realm+'/clients/'+readerClient.id+'/service-account-user'),management=(await api(realm+'/clients?clientId=realm-management'))[0],roleNames=['view-users','query-users','view-realm','view-clients'];
 const readerRoles=[];for(const name of roleNames)readerRoles.push(await api(realm+'/clients/'+management.id+'/roles/'+name));
 await api(realm+'/users/'+serviceUser.id+'/role-mappings/clients/'+management.id,'POST',readerRoles);
 const users=JSON.parse(await readFile(join(work,'consistent-source-participants.private.json'),'utf8')),finalRole=await api(realm+'/roles/final-approver'),authorRole=await api(realm+'/roles/tenant-admin');
 for(const tenant of ['acme','sandbox']){
  const username='recovery-'+tenant+'-contributor',password=randomBytes(32).toString('base64url');
  await api(realm+'/users','POST',{username,enabled:true,firstName:'Recovery',lastName:'Contributor',email:username+'@idms.invalid',emailVerified:true,attributes:{tenant_id:[tenant],idms_sites:['*'],idms_lines:['*'],idms_devices:['*']},credentials:[{type:'password',value:password,temporary:false}]});
  const user=(await api(realm+'/users?username='+username+'&exact=true'))[0];await api(realm+'/users/'+user.id+'/role-mappings/realm','POST',[authorRole,finalRole]);users[tenant].contributor={id:user.id,username,password};
 }
 await save('current-actors-identity.private.json',{humanClient,humanClientUuid:human.id,reader,readerServiceUser:serviceUser.id,readerRoles:roleNames,users});
 const login=async user=>{const token=await authorityJsonV1(identity.runtime.issuer+'/protocol/openid-connect/token',{method:'POST',body:new URLSearchParams({grant_type:'password',client_id:humanClient,username:user.username,password:user.password,scope:'openid'})});const claims=decodeJwt(token.access_token);assert(claims.exp-claims.iat>=590);return token.access_token;};
 return {async participants(runtime,origin){const rows=[];for(const tenantId of ['acme','sandbox']){const workflow=runtime.tenants[tenantId],u=users[tenantId];rows.push({configuration:{format:'idms-field-recovery-external-config-v1',tenantId,auth:{...site.auth,clientId:humanClient},identityReader:{...reader,loginClientUuid:human.id},workflow:{baseUrl:origin,recoveryReadToken:workflow.recoveryReadToken,authorityId:workflow.recoveryAuthorityId,definitionSha256:workflow.bpmnSha256}},authorAccessToken:await login(u.author),contributorAccessTokens:[await login(u.contributor)],reviewerAccessToken:await login(u.reviewer)});}return rows;}};
}
