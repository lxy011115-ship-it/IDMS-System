import type {IncomingMessage,ServerResponse} from 'node:http';
import type {AccessContext} from './access.ts';
import {DomainError} from './service.ts';
import {DomainReadApiV4,DomainReadErrorV4} from './domain-read-api-v4.ts';
/** Auth is the existing server-owned OIDC/session context; request headers never select a store. */
export function createDomainReadHttpV4(context:(req:IncomingMessage)=>Promise<AccessContext>,readers:ReadonlyMap<string,DomainReadApiV4>){
 return async(req:IncomingMessage,res:ServerResponse)=>{
  const send=(status:number,value:unknown)=>{if(res.destroyed||res.writableEnded)return;const body=JSON.stringify(value);res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});res.end(body);};
  try{const who=await context(req);if(req.method!=='GET')throw new DomainReadErrorV4(405,'READ_METHOD_NOT_ALLOWED');if((req.url?.length||0)>8192)throw new DomainReadErrorV4(400,'READ_QUERY_INVALID');const url=new URL(req.url||'/','http://idms.invalid'),api=readers.get(who.tenantId);if(!api)throw new DomainReadErrorV4(404,'READ_NOT_FOUND');let result;
   if(url.pathname==='/api/v4/data-management/assets')result=await api.assets(url.searchParams,who);
   else if(url.pathname==='/api/v4/audit')result=await api.audit(url.searchParams,who);
   else{const match=/^\/api\/v4\/telemetry\/receipts\/([-\w]{1,100})$/.exec(url.pathname);if(!match)throw new DomainReadErrorV4(404,'READ_NOT_FOUND');result=await api.receipt(match[1],url.searchParams,who);}
   send(200,result);
  }catch(e){const error=e instanceof DomainError?e:new DomainReadErrorV4(503,'READ_UNVERIFIABLE');send(error.status,{error:error instanceof DomainReadErrorV4?error.code:error.message,code:error instanceof DomainReadErrorV4?error.code:'READ_AUTHORIZATION'});}
 };
}
