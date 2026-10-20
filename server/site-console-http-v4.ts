import {readFile} from 'node:fs/promises';
import type {IncomingMessage,ServerResponse} from 'node:http';
import type {loadSiteConsoleRuntimeV4} from './site-console-runtime-v4.ts';
import {createGovernanceAuditHttpV4} from './governance-audit-http-v4.ts';
import {GovernanceConsoleJobApiV4} from './governance-console-job-api-v4.ts';
import {GovernanceConsoleReadV4} from './governance-console-read-v4.ts';
import {UnifiedAuditApiV4} from './unified-audit-api-v4.ts';
import {createMaintenanceConsoleUiHttpV4} from './maintenance-console-ui-http-v4.ts';
import {MaintenanceConsoleJobApiV4} from './maintenance-console-job-api-v4.ts';
import {MaintenanceConsoleReadV4} from './maintenance-console-read-v4.ts';
import {DomainError} from './service.ts';
import {withRequestCapacity,bindRequestTenant,reserveResponse} from './request-capacity.ts';
import {memoryTask,holdAllocation,sqlScheduler,requestSignal} from './capacity.ts';
type Runtime=Awaited<ReturnType<typeof loadSiteConsoleRuntimeV4>>;
type Handler=(req:IncomingMessage,res:ServerResponse)=>Promise<void>;
const nav='<nav class="site-shell-nav" aria-label="站点导航"><a href="/">工作台首页</a><a href="/governance/">数据与审计</a><a href="/maintenance/">维修工单</a></nav>';
function shell(html:string){if(html.split('</header>').length!==2||html.split('</head>').length!==2)throw Error('SITE_STATIC_SHELL_VERSION');return Buffer.from(html.replace('</head>','<link rel="stylesheet" href="/site/navigation.css"></head>').replace('</header>','</header>'+nav));}
export async function createSiteConsoleHttpV4(runtime:Runtime){
 const {auth,provider}=runtime,routes=new Map<string,{governance:Handler;maintenance:Handler;read:GovernanceConsoleReadV4}>();
 for(const [tenant,member]of runtime.members){const g=member.governance,m=member.maintenance,gr=new GovernanceConsoleReadV4(g.config.business.account,g.config.business.binding,auth.auditCursors),mr=new MaintenanceConsoleReadV4(m.config.business.account,m.config.business.binding,auth.auditCursors,m.queue.binding.deployment);
  routes.set(tenant,{read:gr,governance:await createGovernanceAuditHttpV4({auth,read:gr,audit:new UnifiedAuditApiV4(g.config.business.account,g.config.business.binding,auth.auditCursors),jobs:new GovernanceConsoleJobApiV4({queue:g.queue,crypto:g.crypto,auth:provider,readAccount:g.config.business.account,readBinding:g.config.business.binding})}),maintenance:await createMaintenanceConsoleUiHttpV4({auth,read:mr,jobs:new MaintenanceConsoleJobApiV4({queue:m.queue,crypto:m.crypto,auth:provider,read:mr,readAccount:m.config.business.account,readBinding:m.config.business.binding})})});
 }
 const assets=new Map<string,{bytes:Buffer;mime:string}>();for(const [path,file,mime]of [['/','site-console-v4.html','text/html; charset=utf-8'],['/site/console.js','site-console-v4.js','text/javascript; charset=utf-8'],['/site/console.css','site-console-v4.css','text/css; charset=utf-8'],['/site/navigation.css','site-console-navigation-v4.css','text/css; charset=utf-8']])assets.set(path,{bytes:await readFile(new URL('../public/'+file,import.meta.url)),mime});
 for(const [path,file]of [['/governance/','governance-audit-v4.html'],['/maintenance/','maintenance-console-v4.html']])assets.set(path,{bytes:shell(await readFile(new URL('../public/'+file,import.meta.url),'utf8')),mime:'text/html; charset=utf-8'});
 const first=routes.values().next().value!;let authorizing=0;
 return async(req:IncomingMessage,res:ServerResponse)=>{
  const send=(status:number,value:unknown)=>{if(res.destroyed||res.writableEnded)return;const bytes=Buffer.from(JSON.stringify(value));reserveResponse(bytes.length);res.writeHead(status,{'content-type':'application/json; charset=utf-8','content-length':bytes.length,'cache-control':'no-store'});res.end(bytes);};
  try{res.setHeader('x-content-type-options','nosniff');res.setHeader('x-frame-options','DENY');res.setHeader('referrer-policy','same-origin');res.setHeader('cache-control','no-store');res.setHeader('permissions-policy','camera=(), microphone=()');res.setHeader('content-security-policy',"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");if((req.url?.length||0)>8192)throw new DomainError(400,'SITE_URL');const url=new URL(req.url||'/','http://localhost');
   const asset=assets.get(url.pathname);if(asset){if(!['GET','HEAD'].includes(req.method||''))throw new DomainError(405,'SITE_METHOD');res.writeHead(200,{'content-type':asset.mime,'content-length':asset.bytes.length});res.end(req.method==='HEAD'?undefined:asset.bytes);return;}
   if(url.pathname.startsWith('/api/v1/auth/')){if(await auth.handle(req,res,url))return;throw new DomainError(404,'SITE_NOT_FOUND');}
   if(url.pathname==='/api/v4/site/health'){if(req.method!=='GET'||url.search)throw new DomainError(400,'SITE_QUERY');send(200,{status:'UP',mode:'v4-console-integration'});return;}
   if(url.pathname==='/governance'||url.pathname.startsWith('/governance/')){await first.governance(req,res);return;}if(url.pathname==='/maintenance'||url.pathname.startsWith('/maintenance/')){await first.maintenance(req,res);return;}
   if(!url.pathname.startsWith('/api/v4/'))throw new DomainError(404,'SITE_NOT_FOUND');
   if(authorizing>=32)throw new DomainError(429,'SITE_AUTH_BUSY');authorizing++;let ctx;try{ctx=await auth.context(req);}finally{authorizing--;}if(req.aborted||res.destroyed)return;if(req.headers['x-tenant-id']!==ctx.tenantId||req.headers['x-idms-actor-id']!==ctx.actorId)throw new DomainError(403,'SITE_IDENTITY_CHANGED');const route=routes.get(ctx.tenantId);if(!route)throw new DomainError(403,'SITE_TENANT_UNREGISTERED');
    if(url.pathname==='/api/v4/site/context'){if(req.method!=='GET'||url.search)throw new DomainError(400,'SITE_QUERY');await withRequestCapacity(req,res,async()=>{bindRequestTenant(ctx.tenantId);await sqlScheduler.run(ctx.tenantId,()=>memoryTask(async()=>{const release=holdAllocation(16*1024*1024);try{const context=await route.read.context(ctx),current=await auth.context(req);if(current.tenantId!==ctx.tenantId||current.actorId!==ctx.actorId)throw new DomainError(409,'SITE_IDENTITY_CHANGED');send(200,{tenant:context.tenant,phase:context.phase,modules:[{label:'数据与审计',href:'/governance/'},{label:'维修工单',href:'/maintenance/'}]});}finally{release();}}),requestSignal());});return;}
    if(url.pathname.startsWith('/api/v4/governance/')||url.pathname==='/api/v4/audit'||url.pathname.startsWith('/api/v4/audit/')){await route.governance(req,res);return;}if(url.pathname.startsWith('/api/v4/maintenance/')){await route.maintenance(req,res);return;}throw new DomainError(404,'SITE_NOT_FOUND');
  }catch(error){if(res.headersSent){res.destroy();return;}send(error instanceof DomainError?error.status:503,{error:error instanceof DomainError?error.message:'SITE_UNAVAILABLE'});}
 };
}
