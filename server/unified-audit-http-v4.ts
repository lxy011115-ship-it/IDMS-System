import type {IncomingMessage,ServerResponse} from 'node:http';
import type {createAuth} from './auth.ts';
import {UnifiedAuditApiV4} from './unified-audit-api-v4.ts';
import {UnifiedAuditErrorV4,unifiedAuditActorV4} from './unified-audit-query-v4.ts';
import {DomainError} from './service.ts';
import {withRequestCapacity,bindRequestTenant,reserveResponse} from './request-capacity.ts';
import {memoryTask,holdAllocation,sqlScheduler} from './capacity.ts';
export function createUnifiedAuditHttpV4(auth:ReturnType<typeof createAuth>,api:UnifiedAuditApiV4){
 return async(req:IncomingMessage,res:ServerResponse)=>{
  const send=(status:number,value:unknown,download?:string)=>{if(res.destroyed||res.writableEnded)return;const bytes=Buffer.from(JSON.stringify(value));if(bytes.length>2*1024*1024)throw new UnifiedAuditErrorV4(503,'AUDIT_RESPONSE_BUDGET');reserveResponse(bytes.length);res.writeHead(status,{'content-type':'application/json; charset=utf-8','content-length':bytes.length,'cache-control':'no-store','x-content-type-options':'nosniff',...(download?{'content-disposition':'attachment; filename="audit-'+download+'.json"'}:{})});res.end(bytes);};
  try{if(req.method!=='GET')throw new UnifiedAuditErrorV4(405,'AUDIT_METHOD');if((req.url?.length||0)>8192)throw new UnifiedAuditErrorV4(400,'AUDIT_QUERY');const url=new URL(req.url||'/','http://localhost');const match=/^\/api\/v4\/audit\/events\/([-\w]{1,128})(\/download)?$/.exec(url.pathname);if(url.pathname!=='/api/v4/audit'&&!match)throw new UnifiedAuditErrorV4(404,'AUDIT_NOT_FOUND');
   await withRequestCapacity(req,res,async()=>{const ctx=await auth.context(req);if(req.headers['x-tenant-id']!==ctx.tenantId||req.headers['x-idms-actor-id']!==ctx.actorId)throw new UnifiedAuditErrorV4(403,'AUDIT_IDENTITY_CHANGED');bindRequestTenant(ctx.tenantId);await sqlScheduler.run(ctx.tenantId,()=>memoryTask(async()=>{const release=holdAllocation(96*1024*1024);try{const value=match?await api.detail(match[1],url.searchParams,ctx):await api.page(url.searchParams,ctx);const current=await auth.context(req);if(unifiedAuditActorV4(current)!==unifiedAuditActorV4(ctx))throw new UnifiedAuditErrorV4(409,'AUDIT_SCOPE_CHANGED');send(200,value,match?.[2]?match[1]:undefined);}finally{release();}}));});
  }catch(error){const status=error instanceof DomainError?error.status:503,code=error instanceof UnifiedAuditErrorV4?error.code:error instanceof DomainError?'AUDIT_AUTHORIZATION':'AUDIT_UNAVAILABLE';send(status,{error:code,code});}
 };
}
