import {readFile} from 'node:fs/promises';
import {once} from 'node:events';
import type {IncomingMessage,ServerResponse} from 'node:http';
import type {createAuth} from './auth.ts';
import {GovernanceConsoleJobApiV4} from './governance-console-job-api-v4.ts';
import {GovernanceConsoleReadV4} from './governance-console-read-v4.ts';
import {withRequestCapacity,bindRequestTenant,reserveResponse,reserveStreamResponse} from './request-capacity.ts';
import {memoryTask,holdAllocation,sqlScheduler,requestSignal,limits} from './capacity.ts';
import {DomainError} from './service.ts';
import {definitions} from './imports.ts';
interface Options {auth:ReturnType<typeof createAuth>;jobs:GovernanceConsoleJobApiV4;read:GovernanceConsoleReadV4}
const staticFiles=new Map([['/governance/',['governance-ai-v4.html','text/html; charset=utf-8']],['/governance/console.js',['governance-ai-v4.js','text/javascript; charset=utf-8']],['/governance/console.css',['governance-console-v4.css','text/css; charset=utf-8']]]);
const csp="default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";
/** Same-origin console, original authentication, QI jobs and READER projection only. */
export async function createGovernanceAiHttpV4(options:Options){
 const assets=new Map<string,{bytes:Buffer;mime:string}>();for(const [path,[file,mime]]of staticFiles){const bytes=await readFile(new URL('../public/'+file,import.meta.url));assets.set(path,{bytes,mime});}
 return async(req:IncomingMessage,res:ServerResponse)=>{
  const send=(status:number,value:unknown)=>{const text=JSON.stringify(value);if(Buffer.byteLength(text)>16*1024*1024)throw new DomainError(503,'CONSOLE_RESPONSE_BUDGET');reserveResponse(Buffer.byteLength(text));res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(text);};
  try{
   res.setHeader('x-content-type-options','nosniff');res.setHeader('referrer-policy','same-origin');res.setHeader('x-frame-options','DENY');res.setHeader('content-security-policy',csp);res.setHeader('permissions-policy','camera=(), microphone=()');if((req.url?.length||0)>8192)throw new DomainError(400,'CONSOLE_URL');const url=new URL(req.url||'/','http://localhost');
   if(url.pathname==='/governance'&&req.method==='GET'){res.writeHead(302,{location:'/governance/','cache-control':'no-store'});res.end();return;}
   const asset=assets.get(url.pathname);if(asset){if(!['GET','HEAD'].includes(req.method||''))throw new DomainError(405,'CONSOLE_METHOD');res.writeHead(200,{'content-type':asset.mime,'content-length':asset.bytes.length,'cache-control':'no-store'});res.end(req.method==='HEAD'?undefined:asset.bytes);return;}
   if(await options.auth.handle(req,res,url))return;if(await options.jobs.handle(req,res))return;
   const route=url.pathname.match(/^\/api\/v4\/governance\/(context|templates|batches)(?:\/([-\w]{1,128})(?:\/(rows|errors|original))?)?$/);if(!route)throw new DomainError(404,'CONSOLE_NOT_FOUND');if(req.method!=='GET')throw new DomainError(405,'CONSOLE_METHOD');
   await withRequestCapacity(req,res,async()=>{
    const ctx=await options.auth.context(req);if(req.headers['x-tenant-id']!==ctx.tenantId)throw new DomainError(403,'GOVERNANCE_TENANT_MISMATCH');if(req.headers['x-idms-actor-id']&&req.headers['x-idms-actor-id']!==ctx.actorId)throw new DomainError(403,'GOVERNANCE_ACTOR_CHANGED');bindRequestTenant(ctx.tenantId);
    await sqlScheduler.run(ctx.tenantId,()=>memoryTask(async()=>{
     const [_,kind,entityId,view]=route,release=holdAllocation(view==='original'?4*1024*1024:entityId?96*1024*1024:16*1024*1024);
     try{
      if(kind==='context'){if(entityId||view||url.search)throw new DomainError(400,'CONSOLE_QUERY');send(200,{...await options.read.context(ctx),importTypes:Object.entries(definitions).map(([type,value])=>({type,name:value.name,fields:value.fields}))});return;}
      if(kind==='templates'&&view)throw new DomainError(404,'CONSOLE_NOT_FOUND');
      if(view==='original'){
       if(url.search)throw new DomainError(400,'CONSOLE_QUERY');const timer=setTimeout(()=>res.destroy(),limits.exportPrepareMs+limits.exportSendMs);timer.unref?.();let f:Awaited<ReturnType<GovernanceConsoleReadV4['file']>>|undefined;try{f=await options.read.file(entityId!,ctx);await f.reauthorize(await options.auth.context(req));const allowed=['text/csv','application/json','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],mime=allowed.find(m=>f!.file.mime.split(';')[0].toLowerCase()===m)||'application/octet-stream';reserveStreamResponse(f.file.bytes,Math.max(1,Math.min(f.file.bytes,512*1024)));res.writeHead(200,{'content-type':mime,'content-length':f.file.bytes,'content-disposition':"attachment; filename=\"original\"; filename*=UTF-8''"+encodeURIComponent(f.file.filename),'cache-control':'no-store','x-content-sha256':f.file.sha256});for await(const part of f.chunks()){if(requestSignal()?.aborted)throw new DomainError(499,'REQUEST_CANCELLED');if(!res.write(part))await once(res,'drain',{signal:requestSignal()});}await f.close();res.end();}finally{clearTimeout(timer);await f?.close();}return;
      }
      if(view==='rows'||view==='errors'){send(200,await options.read.rows(entityId!,view,url.searchParams,ctx));return;}
      if(entityId){if(url.search)throw new DomainError(400,'CONSOLE_QUERY');send(200,await options.read.detail(kind as 'templates'|'batches',entityId,ctx));return;}
      send(200,await options.read.list(kind as 'templates'|'batches',url.searchParams,ctx));
     }finally{release();}
    }),requestSignal());
   });
  }catch(e){if(res.headersSent){res.destroy();return;}const error=e instanceof DomainError?e:new DomainError(503,'CONSOLE_UNAVAILABLE');send(error.status,{error:error.message});}
 };
}
