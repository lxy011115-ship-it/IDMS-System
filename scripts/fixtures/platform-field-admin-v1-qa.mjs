import assert from 'node:assert/strict';
import {authorityJsonV1} from '../../server/identity-authority-live-v1.ts';

/** Native QA only: long-running scenarios must not reuse the factory's early admin JWT. */
export function createPlatformFieldAdminQaV1({issuer,admin}){
 const url=new URL(issuer);assert(url.protocol==='http:'&&url.hostname==='127.0.0.1'&&url.port,'PLATFORM_FIELD_ADMIN_ORIGIN');
 assert(admin&&typeof admin.username==='string'&&typeof admin.password==='string','PLATFORM_FIELD_ADMIN_INPUT');
 return async(path,method='GET',body)=>{
  assert(typeof path==='string'&&/^[a-zA-Z0-9_?=&.\/-]+$/.test(path)&&!path.includes('..')&&!path.startsWith('/'),'PLATFORM_FIELD_ADMIN_PATH');
  const token=await authorityJsonV1(url.origin+'/realms/master/protocol/openid-connect/token',{method:'POST',body:new URLSearchParams({grant_type:'password',client_id:'admin-cli',username:admin.username,password:admin.password})});
  assert(typeof token.access_token==='string'&&token.access_token.length>0,'PLATFORM_FIELD_ADMIN_TOKEN');
  const response=await fetch(url.origin+'/admin/realms/'+path,{method,redirect:'error',headers:{authorization:'Bearer '+token.access_token,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(15000)});
  assert(response.ok,'PLATFORM_FIELD_ADMIN_API_'+response.status);
  return [201,204].includes(response.status)?null:response.json();
 };
}
