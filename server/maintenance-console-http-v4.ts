import type {IncomingMessage,ServerResponse} from 'node:http';
import type {createAuth} from './auth.ts';
import {MaintenanceConsoleJobApiV4} from './maintenance-console-job-api-v4.ts';
import {MaintenanceConsoleReadV4} from './maintenance-console-read-v4.ts';
import {DomainError} from './service.ts';
import {withRequestCapacity,bindRequestTenant,reserveResponse} from './request-capacity.ts';
import {memoryTask,holdAllocation,sqlScheduler,requestSignal} from './capacity.ts';
/** Standalone integration boundary; original site remains untouched. */
export function createMaintenanceConsoleHttpV4(o:{auth:ReturnType<typeof createAuth>;jobs:MaintenanceConsoleJobApiV4;read:MaintenanceConsoleReadV4}){
 return async(req:IncomingMessage,res:ServerResponse)=>{
  const send=(status:number,value:unknown)=>{const text=JSON.stringify(value);if(Buffer.byteLength(text)>2*1024*1024)throw new DomainError(503,'MAINTENANCE_RESPONSE_BUDGET');reserveResponse(Buffer.byteLength(text));res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(text);};
  try{
   res.setHeader('x-content-type-options','nosniff');res.setHeader('x-frame-options','DENY');res.setHeader('referrer-policy','same-origin');res.setHeader('content-security-policy',"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
   if((req.url?.length||0)>8192)throw new DomainError(400,'MAINTENANCE_URL');const url=new URL(req.url||'/','http://localhost');if(await o.auth.handle(req,res,url))return;if(await o.jobs.handle(req,res))return;
   const match=url.pathname.match(/^\/api\/v4\/maintenance\/(context|orders)(?:\/([-\w]{1,128}))?$/);if(!match)throw new DomainError(404,'MAINTENANCE_NOT_FOUND');if(req.method!=='GET')throw new DomainError(405,'MAINTENANCE_METHOD');
   await withRequestCapacity(req,res,async()=>{const ctx=await o.auth.context(req);if(req.headers['x-tenant-id']!==ctx.tenantId)throw new DomainError(403,'MAINTENANCE_TENANT');if(req.headers['x-idms-actor-id']&&req.headers['x-idms-actor-id']!==ctx.actorId)throw new DomainError(403,'MAINTENANCE_ACTOR_CHANGED');bindRequestTenant(ctx.tenantId);
    await sqlScheduler.run(ctx.tenantId,()=>memoryTask(async()=>{const release=holdAllocation(32*1024*1024);try{
     if(match[1]==='context'){if(match[2]||url.search)throw new DomainError(400,'MAINTENANCE_QUERY');send(200,await o.read.context(ctx));return;}
     if(match[2]){if(url.search)throw new DomainError(400,'MAINTENANCE_QUERY');send(200,await o.read.detail(match[2],ctx));return;}send(200,await o.read.list(url.searchParams,ctx));
    }finally{release();}}),requestSignal());
   });
  }catch(e){if(res.headersSent){res.destroy();return;}send(e instanceof DomainError?e.status:503,{error:e instanceof DomainError?e.message:'MAINTENANCE_UNAVAILABLE'});}
 };
}
